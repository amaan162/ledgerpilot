import base64
import binascii
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.approvals import ROLE_RANK
from app.core.security import verify_n8n_webhook_signature
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    Invoice,
    InvoiceStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.graph.workflow import resume_invoice_workflow
from app.schemas.common import (
    InvoiceIngestResponse,
    InvoiceSummaryResponse,
    N8nWebhookIntakeRequest,
)
from app.services.audit import enqueue_dead_letter, write_audit_log
from app.services.intake import ingest_invoice_bytes

router = APIRouter(prefix="/api/v1/webhooks", tags=["Edge Webhooks (n8n)"])


class N8nApprovalCallbackRequest(BaseModel):
    approval_id: uuid.UUID
    decision: Literal["APPROVED", "REJECTED"]
    approver_email: str = Field(..., min_length=3, max_length=255)
    reason: str = Field(..., min_length=3, max_length=1000)
    slack_message_ts: str | None = None


class N8nApprovalCallbackResponse(BaseModel):
    approval_id: uuid.UUID
    invoice_id: uuid.UUID
    invoice_status: InvoiceStatus
    settlement_reference: str | None = None
    decided_by_email: str


class EscalatedApprovalItem(BaseModel):
    approval_id: uuid.UUID
    invoice_id: uuid.UUID
    invoice_number: str | None
    total_amount: Decimal | None
    currency: str | None
    sla_due_at: datetime


class N8nSLASweepResponse(BaseModel):
    checked_at: datetime
    escalated_count: int
    escalated_items: list[EscalatedApprovalItem]


@router.post("/n8n/intake", response_model=InvoiceIngestResponse)
async def n8n_invoice_intake(
    response: Response,
    raw_body: Annotated[bytes, Depends(verify_n8n_webhook_signature)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InvoiceIngestResponse:
    """
    Receives HMAC-SHA256 signed invoice attachments forwarded by n8n edge workflows.
    Malformed payloads are safely captured in dead_letter_jobs instead of lost.
    """
    try:
        parsed_json = json.loads(raw_body.decode("utf-8"))
        payload = N8nWebhookIntakeRequest.model_validate(parsed_json)
        file_bytes = base64.b64decode(payload.content_base64, validate=True)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, binascii.Error) as exc:
        fallback_key = f"dlq-n8n-{uuid.uuid4().hex[:16]}"
        dlq_job = enqueue_dead_letter(
            db,
            source="n8n_intake",
            idempotency_key=fallback_key,
            payload={"raw_body_preview": raw_body[:500].decode("utf-8", errors="replace")},
            error_message=str(exc),
        )
        await db.flush()
        write_audit_log(
            db,
            actor_type=ActorType.N8N,
            actor_id="n8n-webhook-intake",
            action="WEBHOOK_PAYLOAD_DEAD_LETTERED",
            previous_state=None,
            new_state="DEAD_LETTERED",
            details={"dead_letter_id": str(dlq_job.id), "error": str(exc)},
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "error": "Malformed n8n intake payload; captured in dead-letter queue.",
                "dead_letter_id": str(dlq_job.id),
            },
        ) from exc

    invoice, is_duplicate = await ingest_invoice_bytes(
        db,
        filename=payload.filename,
        file_bytes=file_bytes,
        source_channel=payload.source_channel,
        actor_type=ActorType.N8N,
        actor_id="n8n-webhook-intake",
        idempotency_key=payload.idempotency_key,
        metadata={
            "sender_email": payload.sender_email,
            "subject": payload.subject,
        },
    )
    response.status_code = status.HTTP_200_OK if is_duplicate else status.HTTP_201_CREATED
    return InvoiceIngestResponse(
        duplicate=is_duplicate,
        message=(
            "Duplicate n8n delivery ignored idempotently."
            if is_duplicate
            else "Invoice ingested via signed n8n webhook."
        ),
        invoice=InvoiceSummaryResponse.model_validate(invoice),
    )


@router.post("/n8n/approval-callback", response_model=N8nApprovalCallbackResponse)
async def n8n_slack_approval_callback(
    raw_body: Annotated[bytes, Depends(verify_n8n_webhook_signature)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> N8nApprovalCallbackResponse:
    """
    Receives HMAC-signed Slack Block Kit approval button actions forwarded by n8n.
    Enforces full backend RBAC role rank & spend-limit verification before resuming LangGraph.
    """
    try:
        body = N8nApprovalCallbackRequest.model_validate_json(raw_body)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.errors()) from exc

    user = await db.scalar(select(User).where(User.email == body.approver_email.lower().strip()))
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Approver '{body.approver_email}' is not an active LedgerPilot user.",
        )

    req = await db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == body.approval_id))
    if not req:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approval request not found.")
    if req.status not in {ApprovalStatus.PENDING, ApprovalStatus.ESCALATED}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Approval request is already finalized ({req.status.value}).",
        )

    invoice = await db.scalar(select(Invoice).where(Invoice.id == req.invoice_id))
    if not invoice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")

    if ROLE_RANK[user.role] < ROLE_RANK[req.required_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Slack approver '{user.email}' ({user.role.value}) lacks required role "
                f"'{req.required_role.value}'."
            ),
        )

    inv_total = Decimal(invoice.total_amount or 0)
    if body.decision == "APPROVED" and inv_total > user.approval_limit_usd:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Invoice total ({inv_total}) exceeds '{user.email}' approval limit ({user.approval_limit_usd})."
            ),
        )

    req.status = ApprovalStatus.APPROVED if body.decision == "APPROVED" else ApprovalStatus.REJECTED
    req.decided_by = user.id
    req.decision_reason = body.reason
    req.decided_at = datetime.now(UTC)

    write_audit_log(
        db,
        invoice_id=invoice.id,
        actor_type=ActorType.N8N,
        actor_id=f"slack:{user.email}",
        action=f"SLACK_APPROVAL_{body.decision}",
        previous_state=invoice.status.value,
        new_state=body.decision,
        details={
            "approval_request_id": str(req.id),
            "role": user.role.value,
            "reason": body.reason,
            "slack_message_ts": body.slack_message_ts,
        },
    )
    await db.commit()

    await resume_invoice_workflow(
        invoice.id,
        decision=body.decision,
        actor_email=user.email,
        reason=body.reason,
    )
    await db.refresh(invoice)

    return N8nApprovalCallbackResponse(
        approval_id=req.id,
        invoice_id=invoice.id,
        invoice_status=invoice.status,
        settlement_reference=invoice.settlement_reference,
        decided_by_email=user.email,
    )


@router.post("/n8n/sla-sweep", response_model=N8nSLASweepResponse)
async def n8n_sla_escalation_sweep(
    _raw_body: Annotated[bytes, Depends(verify_n8n_webhook_signature)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> N8nSLASweepResponse:
    """
    Triggered on a schedule by the n8n SLA Watchdog workflow.
    Finds overdue PENDING approvals (sla_due_at < NOW()) and escalates them to Controller.
    """
    now = datetime.now(UTC)
    overdue = list(
        (
            await db.scalars(
                select(ApprovalRequest).where(
                    ApprovalRequest.status == ApprovalStatus.PENDING,
                    ApprovalRequest.sla_due_at < now,
                )
            )
        ).all()
    )

    escalated_items: list[EscalatedApprovalItem] = []
    for req in overdue:
        req.status = ApprovalStatus.ESCALATED
        req.required_role = UserRole.CONTROLLER
        invoice = await db.scalar(select(Invoice).where(Invoice.id == req.invoice_id))
        if invoice:
            prev = invoice.status.value
            invoice.status = InvoiceStatus.ESCALATED_SLA
            write_audit_log(
                db,
                invoice_id=invoice.id,
                actor_type=ActorType.N8N,
                actor_id="n8n-sla-watchdog",
                action="SLA_BREACH_ESCALATED",
                previous_state=prev,
                new_state=InvoiceStatus.ESCALATED_SLA.value,
                details={
                    "approval_request_id": str(req.id),
                    "sla_due_at": req.sla_due_at.isoformat(),
                    "escalated_to": UserRole.CONTROLLER.value,
                },
            )
            escalated_items.append(
                EscalatedApprovalItem(
                    approval_id=req.id,
                    invoice_id=invoice.id,
                    invoice_number=invoice.invoice_number,
                    total_amount=invoice.total_amount,
                    currency=invoice.currency,
                    sla_due_at=req.sla_due_at,
                )
            )

    if overdue:
        await db.commit()

    return N8nSLASweepResponse(
        checked_at=now,
        escalated_count=len(escalated_items),
        escalated_items=escalated_items,
    )
