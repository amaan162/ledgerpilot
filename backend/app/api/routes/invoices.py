import uuid
from datetime import UTC, datetime
from decimal import Decimal
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
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
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
    debtor_name = str(getattr(settings, "DEBTOR_NAME", "LedgerPilot Global Treasury Ltd."))
    debtor_iban = str(getattr(settings, "DEBTOR_IBAN", "GB29NWBK60161331926819"))
    debtor_bic = str(getattr(settings, "DEBTOR_BIC", "NWBKGB2L"))

    ts = invoice.created_at or datetime.now(UTC)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    cre_dt = ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    req_date = ts.astimezone(UTC).strftime("%Y-%m-%d")

    msg_id = invoice.settlement_reference or f"LP-{invoice.id.hex[:12].upper()}"
    vendor_ccy = getattr(vendor, "default_currency", None) if vendor else None
    currency = (invoice.currency or vendor_ccy or "USD").upper()
    amount = f"{Decimal(str(invoice.total_amount or '0.00')):.2f}"
    creditor_name = vendor.legal_name if vendor else "Verified Supplier"
    creditor_iban = vendor.verified_iban if vendor else "UNVERIFIED"
    creditor_bic = vendor.verified_bic if vendor else "NOTPROVIDED"
    remittance = f"Invoice {invoice.invoice_number or invoice.id} / PO {invoice.po_number or 'N/A'}"

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
    ET.SubElement(pmt, "PmtInfId").text = f"{msg_id}-PMT1"
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


@router.post("/invoices/ingest", response_model=InvoiceIngestResponse)
async def ingest_invoice(
    response: Response,
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> InvoiceIngestResponse:
    raw_bytes = await file.read()
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
    """Executes the stateful LangGraph verification & settlement workflow on an ingested invoice."""
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    await run_invoice_workflow(invoice_id)

    await db.refresh(invoice)
    logs = (
        await db.scalars(
            select(AuditLog).where(AuditLog.invoice_id == invoice_id).order_by(AuditLog.created_at.asc())
        )
    ).all()
    detail = InvoiceDetailResponse.model_validate(invoice)
    detail.audit_logs = [AuditLogResponse.model_validate(log) for log in logs]
    return detail


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
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")
    if invoice.status == InvoiceStatus.PAYMENT_STAGED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot place fraud hold on an already staged settlement.",
        )

    prev = invoice.status.value
    invoice.status = InvoiceStatus.QUARANTINED_FRAUD_RISK
    invoice.risk_flags = sorted(set(invoice.risk_flags) | {"MANUAL_FRAUD_HOLD"})

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
    if not invoice or (not invoice.settlement_xml_path and not invoice.settlement_reference):
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
    rows = (await db.scalars(select(Invoice).order_by(desc(Invoice.created_at)).limit(limit).offset(offset))).all()
    return [InvoiceSummaryResponse.model_validate(r) for r in rows]


@router.get("/invoices/{invoice_id}", response_model=InvoiceDetailResponse)
async def get_invoice_detail(
    invoice_id: uuid.UUID,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceDetailResponse:
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    logs = (
        await db.scalars(
            select(AuditLog).where(AuditLog.invoice_id == invoice_id).order_by(AuditLog.created_at.asc())
        )
    ).all()
    detail = InvoiceDetailResponse.model_validate(invoice)
    detail.audit_logs = [AuditLogResponse.model_validate(log) for log in logs]
    return detail


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
    """Real-time AP operations KPIs, fraud blocks, latency, and LLM operating economics."""
    total_invoices = int(await db.scalar(select(func.count(Invoice.id))) or 0)

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

    staged_sum = await db.scalar(
        select(func.coalesce(func.sum(Invoice.total_amount), Decimal("0.00"))).where(
            Invoice.status == InvoiceStatus.PAYMENT_STAGED
        )
    )
    total_llm_cost = await db.scalar(select(func.coalesce(func.sum(Invoice.llm_cost_usd), Decimal("0.000000"))))
    avg_ms = await db.scalar(
        select(func.coalesce(func.avg(Invoice.processing_ms), 0)).where(Invoice.processing_ms > 0)
    )

    return MetricsOverviewResponse(
        total_invoices=total_invoices,
        payment_staged_count=staged_count,
        awaiting_approval_count=awaiting_count,
        quarantined_fraud_count=quarantined_count,
        rejected_count=rejected_count,
        escalated_sla_count=escalated_count,
        pending_approvals_count=pending_approvals,
        total_staged_amount=Decimal(str(staged_sum)),
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
