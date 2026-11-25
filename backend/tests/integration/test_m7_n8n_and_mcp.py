import json
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import REPO_ROOT, get_settings
from app.core.security import compute_hmac_signature
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    AuditLog,
    ContractChunk,
    Invoice,
    InvoiceStatus,
    UserRole,
    Vendor,
)
from app.graph.workflow import run_invoice_workflow
from app.main import app
from app.schemas.extraction import ExtractedLineItem, InvoiceExtraction
from app.schemas.rag import ContractComplianceLLM
from app.services.intake import ingest_invoice_bytes
from app.services.pdf_generator import InvoicePDFSpec, generate_invoice_pdf_bytes

# Make mcp_server importable for direct tool-level verification
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mcp_server.server import (  # noqa: E402
    LedgerPilotMCPClient,
    get_ap_metrics,
    get_invoice_audit,
    list_pending_approvals,
    place_fraud_hold,
    set_mcp_client,
)

settings = get_settings()


class StubM7LLM:
    def __init__(self, extraction: InvoiceExtraction, embed_vec: list[float]) -> None:
        self._extraction = extraction
        self._embed_vec = embed_vec

    async def extract_invoice(self, file_bytes: bytes, filename: str):
        return self._extraction, Decimal("0.001000"), {"model": "stub-m7"}

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_vec for _ in texts]

    async def audit_contract_compliance(self, prompt_text: str):
        reply = ContractComplianceLLM(
            is_compliant=True,
            confidence=0.95,
            summary="Compliant with MSA terms.",
            violations=[],
            cited_clause_ids=["C1"],
        )
        return reply, Decimal("0.000500"), {"model": "stub-m7"}


async def _create_paused_approval(
    sf: async_sessionmaker[AsyncSession],
) -> tuple[uuid.UUID, uuid.UUID]:
    async with sf() as db:
        apex = await db.scalar(select(Vendor).where(Vendor.vendor_code == "VND-US-CLOUD01"))
        assert apex is not None
        chunk = await db.scalar(
            select(ContractChunk).where(ContractChunk.vendor_id == apex.id, ContractChunk.embedding.is_not(None))
        )
        assert chunk is not None and chunk.embedding is not None
        apex_vec = list(chunk.embedding)

        tag = uuid.uuid4().hex[:8].upper()
        inv_num = f"INV-M7-{tag}"
        pdf = generate_invoice_pdf_bytes(
            InvoicePDFSpec(
                vendor_name="Apex Cloud Infrastructure Inc.",
                vendor_code="VND-US-CLOUD01",
                vendor_tax_id="US-EIN-84-2910442",
                invoice_number=inv_num,
                po_number="PO-2026-1002",
                invoice_date="2026-11-24",
                due_date="2026-12-24",
                payment_terms="Net-30",
                currency="USD",
                iban="US64SVBKUS6S3300958879",
                bic="SVBKUS6S",
                line_items=[
                    {
                        "sku": "CLD-ENT-SUPPORT",
                        "description": "Enterprise Cloud Architecture Advisory (Hours)",
                        "quantity": 24,
                        "unit_price": "200.00",
                        "line_total": "4800.00",
                    }
                ],
                subtotal="4800.00",
                tax_amount="0.00",
                total_amount="4800.00",
            )
        )
        inv, _ = await ingest_invoice_bytes(
            db,
            filename=f"{inv_num}.pdf",
            file_bytes=pdf,
            source_channel="N8N_GMAIL",
            actor_type=ActorType.N8N,
            actor_id="pytest-n8n",
        )
        inv_id = inv.id

    extraction = InvoiceExtraction(
        vendor_name="Apex Cloud Infrastructure Inc.",
        vendor_code="VND-US-CLOUD01",
        invoice_number=inv_num,
        po_number="PO-2026-1002",
        currency="USD",
        subtotal=Decimal("4800.00"),
        tax_amount=Decimal("0.00"),
        total_amount=Decimal("4800.00"),
        bank_iban="US64SVBKUS6S3300958879",
        line_items=[
            ExtractedLineItem(
                sku="CLD-ENT-SUPPORT",
                description="Enterprise Cloud Architecture Advisory (Hours)",
                quantity=Decimal("24"),
                unit_price=Decimal("200.00"),
                line_total=Decimal("4800.00"),
            )
        ],
    )
    await run_invoice_workflow(inv_id, llm_service=StubM7LLM(extraction, apex_vec), session_factory=sf)

    async with sf() as db:
        req = await db.scalar(select(ApprovalRequest).where(ApprovalRequest.invoice_id == inv_id))
        assert req is not None
        return inv_id, req.id


def _sign(payload: dict) -> tuple[bytes, dict[str, str]]:
    raw = json.dumps(payload).encode("utf-8")
    ts = str(int(time.time()))
    sig = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, ts, raw)
    return raw, {
        "Content-Type": "application/json",
        "X-LedgerPilot-Timestamp": ts,
        "X-LedgerPilot-Signature": sig,
    }


@pytest.mark.asyncio
async def test_m7_n8n_slack_approval_callback_enforces_rbac_and_resumes(
    client: AsyncClient,
) -> None:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    sf = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    inv_id, approval_id = await _create_paused_approval(sf)

    # 1. AP Clerk clicks Slack button -> 403 Forbidden (backend RBAC blocks unauthorized click)
    raw_clerk, hdr_clerk = _sign(
        {
            "approval_id": str(approval_id),
            "decision": "APPROVED",
            "approver_email": "clerk@ledgerpilot.io",
            "reason": "Clerk trying to approve via Slack",
        }
    )
    resp_clerk = await client.post("/api/v1/webhooks/n8n/approval-callback", content=raw_clerk, headers=hdr_clerk)
    assert resp_clerk.status_code == 403

    # 2. Finance Manager clicks Slack button -> 200 OK -> Resumes LangGraph -> Stages ISO 20022 XML!
    raw_mgr, hdr_mgr = _sign(
        {
            "approval_id": str(approval_id),
            "decision": "APPROVED",
            "approver_email": "manager@ledgerpilot.io",
            "reason": "Approved from #ap-approvals Slack card",
            "slack_message_ts": "1763980000.001200",
        }
    )
    resp_mgr = await client.post("/api/v1/webhooks/n8n/approval-callback", content=raw_mgr, headers=hdr_mgr)
    assert resp_mgr.status_code == 200
    body = resp_mgr.json()
    assert body["invoice_status"] == "PAYMENT_STAGED"
    assert body["settlement_reference"].startswith("LP-PAIN001-")

    async with sf() as db:
        slack_log = await db.scalar(
            select(AuditLog).where(AuditLog.invoice_id == inv_id, AuditLog.action == "SLACK_APPROVAL_APPROVED")
        )
        assert slack_log is not None
        assert slack_log.actor_type == ActorType.N8N

    await engine.dispose()


@pytest.mark.asyncio
async def test_m7_n8n_sla_watchdog_escalates_overdue_approval(client: AsyncClient) -> None:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    sf = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    inv_id, approval_id = await _create_paused_approval(sf)

    # Force SLA deadline into the past to simulate an overdue 24h approval
    async with sf() as db:
        req = await db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == approval_id))
        assert req is not None
        req.sla_due_at = datetime.now(UTC) - timedelta(hours=2)
        await db.commit()

    raw_sweep, hdr_sweep = _sign({"trigger": "n8n_sla_watchdog"})
    resp = await client.post("/api/v1/webhooks/n8n/sla-sweep", content=raw_sweep, headers=hdr_sweep)
    assert resp.status_code == 200
    data = resp.json()
    assert data["escalated_count"] >= 1
    assert any(item["approval_id"] == str(approval_id) for item in data["escalated_items"])

    async with sf() as db:
        updated_req = await db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == approval_id))
        updated_inv = await db.scalar(select(Invoice).where(Invoice.id == inv_id))
        assert updated_req is not None and updated_req.status == ApprovalStatus.ESCALATED
        assert updated_req.required_role == UserRole.CONTROLLER
        assert updated_inv is not None and updated_inv.status == InvoiceStatus.ESCALATED_SLA

    await engine.dispose()


@pytest.mark.asyncio
async def test_m7_scoped_mcp_tools_consent_and_fraud_hold(client: AsyncClient) -> None:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    sf = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    inv_id, _ = await _create_paused_approval(sf)

    # Bind MCP tools directly to the FastAPI ASGI app with Finance Manager credentials
    set_mcp_client(
        LedgerPilotMCPClient(
            base_url="http://testserver",
            api_key=settings.MANAGER_API_KEY,
            transport=ASGITransport(app=app),
        )
    )

    # 1. Read-only MCP tools return real live JSON data
    metrics = json.loads(await get_ap_metrics())
    assert metrics["total_invoices"] >= 1
    assert "total_llm_cost_usd" in metrics

    pending = json.loads(await list_pending_approvals())
    assert isinstance(pending, list) and len(pending) >= 1

    dossier = json.loads(await get_invoice_audit(str(inv_id)))
    assert dossier["id"] == str(inv_id)
    assert len(dossier["audit_logs"]) >= 1

    # 2. Gated MCP tool WITHOUT confirm_hold=True -> dry-run preview ONLY (does NOT mutate DB!)
    preview = json.loads(
        await place_fraud_hold(
            invoice_id=str(inv_id),
            reason="Suspicious vendor email domain mismatch",
            confirm_hold=False,
        )
    )
    assert preview["action_required"] == "EXPLICIT_USER_CONFIRMATION"

    # 3. Gated MCP tool WITH confirm_hold=True -> quarantines invoice & logs ActorType.MCP
    held = json.loads(
        await place_fraud_hold(
            invoice_id=str(inv_id),
            reason="Confirmed BEC domain spoofing on vendor email",
            confirm_hold=True,
        )
    )
    assert held["status"] == "QUARANTINED_FRAUD_RISK"
    assert "MANUAL_FRAUD_HOLD" in held["risk_flags"]

    # 4. Validate all 3 exported n8n workflow JSON blueprints are well-formed JSON
    for wf_name in (
        "01_gmail_intake.json",
        "02_slack_hitl_approval.json",
        "03_sla_escalation_watchdog.json",
    ):
        wf_path = REPO_ROOT / "n8n" / "workflows" / wf_name
        parsed_wf = json.loads(wf_path.read_text(encoding="utf-8"))
        assert "nodes" in parsed_wf and len(parsed_wf["nodes"]) >= 4

    await engine.dispose()
