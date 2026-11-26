import hashlib
import re
import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Annotated
from xml.etree import ElementTree as ET

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import get_current_user, require_roles
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    AuditLog,
    DeadLetterJob,
    Invoice,
    InvoiceStatus,
    User,
    UserRole,
    Vendor,
)
from app.db.session import get_db
from app.graph.workflow import run_invoice_workflow
from app.schemas.common import (
    AuditLogResponse,
    DeadLetterResponse,
    InvoiceDetailResponse,
    InvoiceIngestResponse,
    InvoiceSummaryResponse,
    VendorResponse,
)
from app.services.audit import write_audit_log
from app.services.file_security import FileSecurityError, validate_uploaded_document
from app.services.intake import ingest_invoice_bytes

router = APIRouter(prefix="/api/v1", tags=["Invoices & Operations"])
logger = get_logger("ledgerpilot.invoices")

MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB hard cap against memory-exhaustion DoS
UPLOAD_CHUNK_BYTES = 1024 * 1024

# Reference FX-to-USD rates for accurate multi-currency treasury KPI rollups
FX_TO_USD: dict[str, Decimal] = {
    "USD": Decimal("1.00"),
    "EUR": Decimal("1.09"),
    "GBP": Decimal("1.27"),
    "AED": Decimal("0.2723"),
    "CHF": Decimal("1.13"),
    "CAD": Decimal("0.73"),
    "AUD": Decimal("0.66"),
    "SGD": Decimal("0.75"),
    "JPY": Decimal("0.0065"),
}

IN_FLIGHT_STATUSES = {
    InvoiceStatus.SCANNING_SECURITY,
    InvoiceStatus.EXTRACTING,
    InvoiceStatus.MATCHING_DETERMINISTIC,
    InvoiceStatus.CHECKING_CONTRACT,
}

COMPLETED_OR_PAUSED_STATUSES = {
    InvoiceStatus.PAYMENT_STAGED,
    InvoiceStatus.AUTO_APPROVED,
    InvoiceStatus.APPROVED,
    InvoiceStatus.AWAITING_APPROVAL,
    InvoiceStatus.ESCALATED_SLA,
    InvoiceStatus.QUARANTINED_FRAUD_RISK,
    InvoiceStatus.REJECTED,
}

_XML_ILLEGAL_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SENSITIVE_URL_RE = re.compile(r"(postgres(?:ql)?(?:\+\w+)?://)[^\s'\"]+", re.IGNORECASE)


def _xml_safe(value: str, max_len: int) -> str:
    cleaned = _XML_ILLEGAL_CTRL_RE.sub("", value).strip()
    return cleaned[:max_len]


def _public_error_detail(exc: Exception) -> str:
    settings = get_settings()
    if settings.APP_ENV.lower() == "production":
        return f"Workflow execution failed ({type(exc).__name__}). Inspect audit logs or retry."
    redacted = _SENSITIVE_URL_RE.sub(r"\1[REDACTED]", str(exc))
    return f"Workflow failed ({type(exc).__name__}): {redacted}"


class FraudHoldRequest(BaseModel):
    reason: str = Field(..., min_length=5, max_length=1000)
    actor_channel: str = Field(default="API", max_length=32)


class MetricsOverviewResponse(BaseModel):
    total_invoices: int
    payment_staged_count: int
    awaiting_approval_count: int
    quarantined_fraud_count: int
    rejected_count: int
    escalated_sla_count: int
    pending_approvals_count: int
    total_staged_amount: Decimal
    total_llm_cost_usd: Decimal
    avg_processing_ms: int


def _rebuild_iso20022_xml(invoice: Invoice, vendor: Vendor | None) -> str:
    """
    Deterministically reconstructs a bank-ready ISO 20022 (pain.001.001.03) XML wire file
    from PostgreSQL Invoice + verified Vendor master records if ephemeral cloud disk was wiped.
    """
    settings = get_settings()
    debtor_name = _xml_safe(
        str(
            getattr(settings, "DEBTOR_COMPANY_NAME", None)
            or getattr(settings, "DEBTOR_NAME", "LedgerPilot Global Holdings Ltd")
        ),
        70,
    )
    debtor_iban = _xml_safe(str(getattr(settings, "DEBTOR_IBAN", "GB29NWBK60161331926819")), 34)
    debtor_bic = _xml_safe(str(getattr(settings, "DEBTOR_BIC", "NWBKGB2L")), 11)

    ts = invoice.created_at or datetime.now(UTC)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    cre_dt = ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    req_date = ts.astimezone(UTC).strftime("%Y-%m-%d")

    msg_id = _xml_safe(invoice.settlement_reference or f"LP-{invoice.id.hex[:12].upper()}", 35)
    vendor_ccy = getattr(vendor, "default_currency", None) if vendor else None
    currency = _xml_safe((invoice.currency or vendor_ccy or "USD").upper(), 3)
    amount = f"{Decimal(str(invoice.total_amount or '0.00')):.2f}"
    creditor_name = _xml_safe(vendor.legal_name if vendor else "Verified Supplier", 70)
    creditor_iban = _xml_safe(vendor.verified_iban if vendor else "UNVERIFIED", 34)
    creditor_bic = _xml_safe(vendor.verified_bic if vendor else "NOTPROVIDED", 11)
    remittance = _xml_safe(
        f"Invoice {invoice.invoice_number or invoice.id} / PO {invoice.po_number or 'N/A'}",
        140,
    )

    ns = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
    doc = ET.Element("Document", xmlns=ns)
    initg = ET.SubElement(doc, "CstmrCdtTrfInitn")

    grp = ET.SubElement(initg, "GrpHdr")
    ET.SubElement(grp, "MsgId").text = msg_id
    ET.SubElement(grp, "CreDtTm").text = cre_dt
    ET.SubElement(grp, "NbOfTxs").text = "1"
    ET.SubElement(grp, "CtrlSum").text = amount
    initg_pty = ET.SubElement(grp, "InitgPty")
    ET.SubElement(initg_pty, "Nm").text = debtor_name

    pmt = ET.SubElement(initg, "PmtInf")
    ET.SubElement(pmt, "PmtInfId").text = _xml_safe(f"{msg_id}-PMT1", 35)
    ET.SubElement(pmt, "PmtMtd").text = "TRF"
    ET.SubElement(pmt, "NbOfTxs").text = "1"
    ET.SubElement(pmt, "CtrlSum").text = amount
    ET.SubElement(pmt, "ReqdExctnDt").text = req_date

    dbtr = ET.SubElement(pmt, "Dbtr")
    ET.SubElement(dbtr, "Nm").text = debtor_name
    dbtr_acct = ET.SubElement(pmt, "DbtrAcct")
    dbtr_id = ET.SubElement(dbtr_acct, "Id")
    ET.SubElement(dbtr_id, "IBAN").text = debtor_iban
    dbtr_agt = ET.SubElement(pmt, "DbtrAgt")
    dbtr_fin = ET.SubElement(dbtr_agt, "FinInstnId")
    ET.SubElement(dbtr_fin, "BIC").text = debtor_bic

    tx = ET.SubElement(pmt, "CdtTrfTxInf")
    pmt_id = ET.SubElement(tx, "PmtId")
    ET.SubElement(pmt_id, "EndToEndId").text = msg_id
    amt = ET.SubElement(tx, "Amt")
    instd = ET.SubElement(amt, "InstdAmt", Ccy=currency)
    instd.text = amount
    cdtr_agt = ET.SubElement(tx, "CdtrAgt")
    cdtr_fin = ET.SubElement(cdtr_agt, "FinInstnId")
    ET.SubElement(cdtr_fin, "BIC").text = creditor_bic
    cdtr = ET.SubElement(tx, "Cdtr")
    ET.SubElement(cdtr, "Nm").text = creditor_name
    cdtr_acct = ET.SubElement(tx, "CdtrAcct")
    cdtr_id = ET.SubElement(cdtr_acct, "Id")
    ET.SubElement(cdtr_id, "IBAN").text = creditor_iban
    rmt = ET.SubElement(tx, "RmtInf")
    ET.SubElement(rmt, "Ustrd").text = remittance

    ET.indent(doc, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(doc, encoding="unicode")


async def _load_invoice_detail(db: AsyncSession, invoice: Invoice) -> InvoiceDetailResponse:
    logs = (
        await db.scalars(
            select(AuditLog).where(AuditLog.invoice_id == invoice.id).order_by(AuditLog.created_at.asc())
        )
    ).all()
    detail = InvoiceDetailResponse.model_validate(invoice)
    detail.audit_logs = [AuditLogResponse.model_validate(log) for log in logs]
    return detail


@router.post("/invoices/ingest", response_model=InvoiceIngestResponse)
async def ingest_invoice(
    response: Response,
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> InvoiceIngestResponse:
    # Bounded streaming read prevents unbounded memory allocation DoS
    chunks: list[bytes] = []
    total_bytes = 0
    while True:
        chunk = await file.read(UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total_bytes += len(chunk)
        if total_bytes > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Uploaded document exceeds the 15 MB maximum security limit.",
            )
        chunks.append(chunk)
    raw_bytes = b"".join(chunks)

    try:
        safe_filename = validate_uploaded_document(file.filename or "invoice.pdf", raw_bytes)
    except FileSecurityError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    invoice, is_duplicate = await ingest_invoice_bytes(
        db,
        filename=safe_filename,
        file_bytes=raw_bytes,
        source_channel="API_UPLOAD",
        actor_type=ActorType.HUMAN,
        actor_id=current_user.email,
        idempotency_key=idempotency_key,
    )

    # Self-heal ephemeral cloud disk if a duplicate upload matches an existing DB row whose PDF was wiped
    stored_path_str = (
        (invoice.extracted_payload or {}).get("stored_file_path")
        or getattr(invoice, "file_path", None)
        or getattr(invoice, "storage_path", None)
    )
    if is_duplicate and stored_path_str:
        stored_path = Path(stored_path_str)
        if not stored_path.exists():
            try:
                stored_path.parent.mkdir(parents=True, exist_ok=True)
                stored_path.write_bytes(raw_bytes)
            except OSError as exc:
                logger.warning("ephemeral_file_restore_failed", extra={"extra_data": {"error": str(exc)}})

    response.status_code = status.HTTP_200_OK if is_duplicate else status.HTTP_201_CREATED
    return InvoiceIngestResponse(
        duplicate=is_duplicate,
        message=(
            "Duplicate invoice detected; returning existing record idempotently."
            if is_duplicate
            else "Invoice accepted and queued for autonomous verification."
        ),
        invoice=InvoiceSummaryResponse.model_validate(invoice),
    )


@router.post("/invoices/{invoice_id}/process", response_model=InvoiceDetailResponse)
async def process_invoice(
    invoice_id: uuid.UUID,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceDetailResponse:
    """
    Executes the stateful LangGraph verification & settlement workflow on an ingested invoice.
    Idempotently returns already-processed dossiers without re-running Gemini or mutating terminal states.
    """
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    # Never re-run LLMs or mutate terminal/paused invoices (prevents replay attacks & wasted spend)
    if invoice.status in COMPLETED_OR_PAUSED_STATUSES:
        return await _load_invoice_detail(db, invoice)

    if invoice.status in IN_FLIGHT_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Invoice is already being processed (stage: {invoice.status.value}).",
        )

    # Release the outer read transaction before the LangGraph workflow opens its own DB sessions
    await db.rollback()

    try:
        await run_invoice_workflow(invoice_id)
    except FileNotFoundError as exc:
        logger.warning(
            "invoice_file_missing_on_ephemeral_disk",
            extra={"extra_data": {"invoice_id": str(invoice_id), "error": str(exc)}},
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Uploaded PDF was cleared by a cloud server restart. Re-upload the PDF via Ingest Invoice to restore and process it.",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "invoice_workflow_failed",
            extra={
                "extra_data": {
                    "invoice_id": str(invoice_id),
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                }
            },
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_public_error_detail(exc),
        ) from exc

    db.expire_all()
    refreshed = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not refreshed or refreshed.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found after processing.")

    return await _load_invoice_detail(db, refreshed)


@router.delete("/invoices/{invoice_id}")
async def delete_invoice(
    invoice_id: uuid.UUID,
    authorized_user: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    """
    SOX 404-compliant Platform Admin archive/removal.
    Preserves immutable HMAC-sealed audit_logs (never trips the BEFORE DELETE trigger),
    clears pending HITL approvals, removes disk artifacts, and releases file_sha256 /
    idempotency / invoice-number locks so the document can be cleanly re-ingested.
    """
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    prev_status = invoice.status.value
    label = invoice.invoice_number or invoice.original_filename

    for raw_path in (
        (invoice.extracted_payload or {}).get("stored_file_path"),
        invoice.settlement_xml_path,
    ):
        if raw_path:
            try:
                Path(raw_path).unlink(missing_ok=True)
            except OSError:
                pass

    await db.execute(delete(ApprovalRequest).where(ApprovalRequest.invoice_id == invoice.id))

    nonce = uuid.uuid4().hex
    invoice.status = InvoiceStatus.CANCELLED
    invoice.file_sha256 = hashlib.sha256(f"cancelled:{invoice.id}:{nonce}".encode("utf-8")).hexdigest()
    invoice.idempotency_key = f"cancelled:{invoice.id.hex}:{nonce[:12]}"
    invoice.settlement_reference = None
    invoice.settlement_xml_path = None

    write_audit_log(
        db,
        invoice_id=invoice.id,
        actor_type=ActorType.HUMAN,
        actor_id=authorized_user.email,
        action="ADMIN_INVOICE_ARCHIVED",
        previous_state=prev_status,
        new_state=InvoiceStatus.CANCELLED.value,
        details={"label": label, "sox404_audit_preserved": True},
    )
    await db.commit()
    return {"status": "deleted", "invoice_id": str(invoice_id), "label": label}


@router.post("/invoices/{invoice_id}/fraud-hold", response_model=InvoiceSummaryResponse)
async def place_manual_fraud_hold(
    invoice_id: uuid.UUID,
    body: FraudHoldRequest,
    authorized_user: Annotated[
        User, Depends(require_roles(UserRole.FINANCE_MANAGER, UserRole.CONTROLLER, UserRole.ADMIN))
    ],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceSummaryResponse:
    """Places a hard manual fraud quarantine hold on an invoice (used by Ops UI and MCP tools)."""
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")
    if invoice.status in (
        InvoiceStatus.PAYMENT_STAGED,
        InvoiceStatus.QUARANTINED_FRAUD_RISK,
        InvoiceStatus.REJECTED,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot place fraud hold on an invoice in '{invoice.status.value}' state.",
        )

    prev = invoice.status.value
    invoice.status = InvoiceStatus.QUARANTINED_FRAUD_RISK
    invoice.risk_flags = sorted(set(invoice.risk_flags) | {"MANUAL_FRAUD_HOLD"})

    # Close out any pending approval requests so quarantined invoices cannot still be approved
    await db.execute(
        delete(ApprovalRequest).where(
            ApprovalRequest.invoice_id == invoice.id,
            ApprovalRequest.status.in_([ApprovalStatus.PENDING, ApprovalStatus.ESCALATED]),
        )
    )

    actor_type = ActorType.MCP if body.actor_channel.upper() == "MCP" else ActorType.HUMAN
    write_audit_log(
        db,
        invoice_id=invoice.id,
        actor_type=actor_type,
        actor_id=authorized_user.email,
        action="MANUAL_FRAUD_HOLD_PLACED",
        previous_state=prev,
        new_state=InvoiceStatus.QUARANTINED_FRAUD_RISK.value,
        details={"reason": body.reason, "channel": body.actor_channel},
    )
    await db.commit()
    await db.refresh(invoice)
    return InvoiceSummaryResponse.model_validate(invoice)


@router.get("/invoices/{invoice_id}/settlement.xml", response_class=PlainTextResponse)
async def download_settlement_xml(
    invoice_id: uuid.UUID,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> PlainTextResponse:
    """
    Downloads the bank-ready ISO 20022 (pain.001) wire instruction XML.
    Self-heals automatically from PostgreSQL records if ephemeral cloud disk was recycled.
    """
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if (
        not invoice
        or invoice.status != InvoiceStatus.PAYMENT_STAGED
        or (not invoice.settlement_xml_path and not invoice.settlement_reference)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No ISO 20022 settlement XML staged for this invoice.",
        )

    xml_path = Path(invoice.settlement_xml_path) if invoice.settlement_xml_path else None
    if xml_path and xml_path.exists():
        return PlainTextResponse(
            content=xml_path.read_text(encoding="utf-8"),
            media_type="application/xml",
        )

    vendor = await db.scalar(select(Vendor).where(Vendor.id == invoice.vendor_id)) if invoice.vendor_id else None
    rebuilt_xml = _rebuild_iso20022_xml(invoice, vendor)

    if xml_path:
        try:
            xml_path.parent.mkdir(parents=True, exist_ok=True)
            xml_path.write_text(rebuilt_xml, encoding="utf-8")
        except OSError:
            pass

    return PlainTextResponse(content=rebuilt_xml, media_type="application/xml")


@router.get("/invoices", response_model=list[InvoiceSummaryResponse])
async def list_invoices(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[InvoiceSummaryResponse]:
    rows = (
        await db.scalars(
            select(Invoice)
            .where(Invoice.status != InvoiceStatus.CANCELLED)
            .order_by(desc(Invoice.created_at))
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return [InvoiceSummaryResponse.model_validate(r) for r in rows]


@router.get("/invoices/{invoice_id}", response_model=InvoiceDetailResponse)
async def get_invoice_detail(
    invoice_id: uuid.UUID,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceDetailResponse:
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    return await _load_invoice_detail(db, invoice)


@router.get("/vendors", response_model=list[VendorResponse])
async def list_vendors(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[VendorResponse]:
    vendors = (await db.scalars(select(Vendor).order_by(Vendor.vendor_code.asc()))).all()
    return [VendorResponse.model_validate(v) for v in vendors]


@router.get("/metrics/overview", response_model=MetricsOverviewResponse)
async def get_metrics_overview(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MetricsOverviewResponse:
    """Real-time AP operations KPIs, fraud blocks, FX-normalized USD settlements, and LLM economics."""
    active_filter = Invoice.status != InvoiceStatus.CANCELLED
    total_invoices = int(await db.scalar(select(func.count(Invoice.id)).where(active_filter)) or 0)

    async def _count_status(st: InvoiceStatus) -> int:
        return int(await db.scalar(select(func.count(Invoice.id)).where(Invoice.status == st)) or 0)

    staged_count = await _count_status(InvoiceStatus.PAYMENT_STAGED)
    awaiting_count = await _count_status(InvoiceStatus.AWAITING_APPROVAL)
    quarantined_count = await _count_status(InvoiceStatus.QUARANTINED_FRAUD_RISK)
    rejected_count = await _count_status(InvoiceStatus.REJECTED)
    escalated_count = await _count_status(InvoiceStatus.ESCALATED_SLA)

    pending_approvals = int(
        await db.scalar(
            select(func.count(ApprovalRequest.id)).where(
                ApprovalRequest.status.in_([ApprovalStatus.PENDING, ApprovalStatus.ESCALATED])
            )
        )
        or 0
    )

    # FX-normalize staged wires into USD using Decimal precision (never mixes raw EUR/GBP/USD)
    staged_rows = (
        await db.execute(
            select(Invoice.total_amount, Invoice.currency).where(
                Invoice.status == InvoiceStatus.PAYMENT_STAGED,
                Invoice.total_amount.is_not(None),
            )
        )
    ).all()
    staged_usd_total = Decimal("0.00")
    for amt, ccy in staged_rows:
        rate = FX_TO_USD.get((ccy or "USD").upper(), Decimal("1.00"))
        staged_usd_total += Decimal(str(amt)) * rate
    staged_usd_total = staged_usd_total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    total_llm_cost = await db.scalar(
        select(func.coalesce(func.sum(Invoice.llm_cost_usd), Decimal("0.000000"))).where(active_filter)
    )
    avg_ms = await db.scalar(
        select(func.coalesce(func.avg(Invoice.processing_ms), 0)).where(
            Invoice.processing_ms > 0, active_filter
        )
    )

    return MetricsOverviewResponse(
        total_invoices=total_invoices,
        payment_staged_count=staged_count,
        awaiting_approval_count=awaiting_count,
        quarantined_fraud_count=quarantined_count,
        rejected_count=rejected_count,
        escalated_sla_count=escalated_count,
        pending_approvals_count=pending_approvals,
        total_staged_amount=staged_usd_total,
        total_llm_cost_usd=Decimal(str(total_llm_cost)),
        avg_processing_ms=int(round(float(avg_ms or 0))),
    )


@router.get("/dead-letters", response_model=list[DeadLetterResponse])
async def list_dead_letters(
    _authorized_user: Annotated[User, Depends(require_roles(UserRole.CONTROLLER, UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
    only_unresolved: bool = True,
) -> list[DeadLetterResponse]:
    stmt = select(DeadLetterJob).order_by(desc(DeadLetterJob.created_at))
    if only_unresolved:
        stmt = stmt.where(DeadLetterJob.resolved.is_(False))
    jobs = (await db.scalars(stmt.limit(50))).all()
    return [DeadLetterResponse.model_validate(j) for j in jobs]