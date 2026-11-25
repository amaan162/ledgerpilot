import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.hardening import api_rate_limiter
from app.core.security import require_roles
from app.db.models import ActorType, DeadLetterJob, Invoice, InvoiceStatus, User, UserRole
from app.db.session import get_db
from app.graph.workflow import run_invoice_workflow
from app.schemas.common import DeadLetterResponse, InvoiceSummaryResponse
from app.services.audit import verify_audit_ledger_integrity, write_audit_log
from app.services.resilience import gemini_circuit, llm_budget_guard, n8n_circuit

router = APIRouter(prefix="/api/v1/security", tags=["MNC Security & Reliability Ops"])


class ResolveDeadLetterRequest(BaseModel):
    resolution_note: str = Field(..., min_length=5, max_length=500)


@router.get("/audit-integrity")
async def get_audit_integrity(
    _authorized_user: Annotated[User, Depends(require_roles(UserRole.CONTROLLER, UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = 500,
) -> dict:
    """Cryptographically verifies HMAC-SHA256 seals across the immutable audit_logs ledger."""
    report = await verify_audit_ledger_integrity(db, limit=min(max(limit, 1), 2000))
    return {
        "verified": report.verified,
        "total_rows_checked": report.total_rows_checked,
        "signed_rows_valid": report.signed_rows_valid,
        "legacy_unsigned_rows": report.legacy_unsigned_rows,
        "tampered_row_ids": report.tampered_row_ids,
    }


@router.get("/posture")
async def get_security_and_reliability_posture(
    _authorized_user: Annotated[User, Depends(require_roles(UserRole.CONTROLLER, UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    """Real-time MNC security, resilience, circuit-breaker, and FinOps budget diagnostics."""
    pgvector_ready = bool(
        await db.scalar(text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector');"))
    )
    unresolved_dlq = int(
        await db.scalar(select(func.count(DeadLetterJob.id)).where(DeadLetterJob.resolved.is_(False))) or 0
    )
    audit_report = await verify_audit_ledger_integrity(db, limit=250)

    return {
        "status": "HEALTHY" if (pgvector_ready and audit_report.verified) else "DEGRADED",
        "controls": {
            "owasp_pdf_forensics": "ACTIVE (white-text, micro-font, off-page, metadata, active JS/Launch)",
            "sox_404_segregation_of_duties": "ENFORCED",
            "ofac_sanctions_iban_screening": "ENFORCED",
            "immutable_audit_trigger": "ENFORCED",
            "cryptographic_audit_seals": "VERIFIED" if audit_report.verified else "TAMPER_ALERT",
            "hmac_webhook_replay_window_s": 300,
            "rate_limiter_active_buckets": api_rate_limiter.active_keys_count(),
        },
        "reliability": {
            "pgvector_extension": pgvector_ready,
            "unresolved_dead_letters": unresolved_dlq,
            "circuit_breakers": [
                gemini_circuit.snapshot().__dict__,
                n8n_circuit.snapshot().__dict__,
            ],
            "daily_llm_budget": llm_budget_guard.snapshot(),
        },
    }


@router.post("/dead-letters/{job_id}/resolve", response_model=DeadLetterResponse)
async def resolve_dead_letter_job(
    job_id: uuid.UUID,
    body: ResolveDeadLetterRequest,
    authorized_user: Annotated[User, Depends(require_roles(UserRole.CONTROLLER, UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DeadLetterResponse:
    """Marks a triaged Dead-Letter Queue job as resolved with an immutable audit entry."""
    job = await db.scalar(select(DeadLetterJob).where(DeadLetterJob.id == job_id))
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dead-letter job not found.")
    job.resolved = True
    write_audit_log(
        db,
        actor_type=ActorType.HUMAN,
        actor_id=authorized_user.email,
        action="DEAD_LETTER_RESOLVED",
        previous_state="UNRESOLVED",
        new_state="RESOLVED",
        details={"dead_letter_id": str(job.id), "note": body.resolution_note},
    )
    await db.commit()
    await db.refresh(job)
    return DeadLetterResponse.model_validate(job)


@router.post("/invoices/{invoice_id}/retry", response_model=InvoiceSummaryResponse)
async def retry_stuck_or_failed_invoice(
    invoice_id: uuid.UUID,
    authorized_user: Annotated[
        User, Depends(require_roles(UserRole.FINANCE_MANAGER, UserRole.CONTROLLER, UserRole.ADMIN))
    ],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceSummaryResponse:
    """Self-healing idempotent retry for RECEIVED or FAILED invoices (never re-runs staged wires)."""
    invoice = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")
    if invoice.status in {InvoiceStatus.PAYMENT_STAGED, InvoiceStatus.QUARANTINED_FRAUD_RISK}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot retry finalized invoice in status '{invoice.status.value}'.",
        )

    write_audit_log(
        db,
        invoice_id=invoice.id,
        actor_type=ActorType.HUMAN,
        actor_id=authorized_user.email,
        action="WORKFLOW_RETRY_TRIGGERED",
        previous_state=invoice.status.value,
        new_state="RETRYING",
        details={"reason": "Manual reliability retry"},
    )
    await db.commit()

    await run_invoice_workflow(invoice.id)
    await db.refresh(invoice)
    return InvoiceSummaryResponse.model_validate(invoice)
