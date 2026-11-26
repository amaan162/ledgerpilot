import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.security import get_current_user, require_roles
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    AuditLog,
    Invoice,
    InvoiceStatus,
    User,
    UserRole,
)
from app.db.session import get_db
from app.graph.workflow import resume_invoice_workflow
from app.services.audit import write_audit_log
from app.services.policy import FX_TO_USD, to_usd_equivalent

router = APIRouter(prefix="/api/v1", tags=["HITL Approvals"])
logger = get_logger("ledgerpilot.approvals")

ROLE_RANK: dict[UserRole, int] = {
    UserRole.AP_CLERK: 1,
    UserRole.FINANCE_MANAGER: 2,
    UserRole.CONTROLLER: 3,
    UserRole.ADMIN: 4,
}

ROLE_DEFAULT_LIMIT_USD: dict[UserRole, Decimal] = {
    UserRole.AP_CLERK: Decimal("0.00"),
    UserRole.FINANCE_MANAGER: Decimal("10000.00"),
    UserRole.CONTROLLER: Decimal("250000.00"),
    UserRole.ADMIN: Decimal("1000000.00"),
}

RESUMABLE_INVOICE_STATUSES = {
    InvoiceStatus.AWAITING_APPROVAL,
    InvoiceStatus.ESCALATED_SLA,
}


def _get_user_approval_limit(user: User) -> Decimal:
    for attr in ("approval_limit_usd", "approval_limit", "max_approval_amount"):
        val = getattr(user, attr, None)
        if val is not None:
            return Decimal(str(val))
    return ROLE_DEFAULT_LIMIT_USD.get(user.role, Decimal("0.00"))


class ApprovalRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    invoice_id: uuid.UUID
    required_role: UserRole
    status: ApprovalStatus
    reason_summary: str
    decided_by: uuid.UUID | None = None
    decision_reason: str | None = None
    sla_due_at: datetime
    decided_at: datetime | None = None
    created_at: datetime


class ApprovalDecisionRequest(BaseModel):
    decision: Literal["APPROVED", "REJECTED"]
    reason: str = Field(..., min_length=3, max_length=1000)


class ApprovalDecisionResponse(BaseModel):
    approval: ApprovalRequestResponse
    invoice_status: str
    settlement_reference: str | None = None


@router.get("/approvals", response_model=list[ApprovalRequestResponse])
async def list_approval_requests(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    only_pending: bool = True,
    limit: int = 50,
) -> list[ApprovalRequestResponse]:
    stmt = (
        select(ApprovalRequest)
        .join(Invoice, ApprovalRequest.invoice_id == Invoice.id)
        .where(Invoice.status != InvoiceStatus.CANCELLED)
        .order_by(ApprovalRequest.created_at.desc())
    )
    if only_pending:
        stmt = stmt.where(ApprovalRequest.status.in_([ApprovalStatus.PENDING, ApprovalStatus.ESCALATED]))
    rows = (await db.scalars(stmt.limit(min(max(limit, 1), 200)))).all()
    return [ApprovalRequestResponse.model_validate(row) for row in rows]


@router.post("/approvals/{approval_id}/decide", response_model=ApprovalDecisionResponse)
async def decide_approval(
    approval_id: uuid.UUID,
    body: ApprovalDecisionRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ApprovalDecisionResponse:
    """
    Acquires row-level PostgreSQL locks (FOR UPDATE) to prevent double-approval races,
    verifies RBAC hierarchy, FX-normalized USD spend caps, and SOX 404 Segregation of Duties,
    then resumes the paused PostgreSQL-checkpointed LangGraph workflow with automatic rollback
    protection if resumption fails.
    """
    req = await db.scalar(
        select(ApprovalRequest).where(ApprovalRequest.id == approval_id).with_for_update()
    )
    if not req:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approval request not found.")

    if req.status not in {ApprovalStatus.PENDING, ApprovalStatus.ESCALATED}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Approval request is already finalized with status '{req.status.value}'.",
        )

    invoice = await db.scalar(
        select(Invoice).where(Invoice.id == req.invoice_id).with_for_update()
    )
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Associated invoice not found.")

    if invoice.status not in RESUMABLE_INVOICE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Associated invoice is in '{invoice.status.value}' state and can no longer "
                "accept approval decisions."
            ),
        )

    # Capture plain Python primitives before commit()/expire_all() to avoid MissingGreenlet
    req_id = req.id
    inv_id = invoice.id
    actor_id = current_user.id
    actor_email = current_user.email
    prev_status_enum = req.status
    prev_status = req.status.value

    # Guardrail 1: Strict RBAC role hierarchy enforcement
    if ROLE_RANK[current_user.role] < ROLE_RANK[req.required_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Insufficient RBAC role '{current_user.role.value}'; "
                f"requires '{req.required_role.value}' or higher."
            ),
        )

    # Guardrail 2: FX-normalized USD approval spend-limit enforcement
    if body.decision == "APPROVED" and invoice.total_amount is not None:
        user_limit = _get_user_approval_limit(current_user)
        usd_equiv, ccy_code = to_usd_equivalent(invoice.total_amount, invoice.currency)
        if ccy_code not in FX_TO_USD and ROLE_RANK[current_user.role] < ROLE_RANK[UserRole.CONTROLLER]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Unsupported FX currency '{ccy_code}' requires Corporate Controller "
                    "or Platform Admin approval."
                ),
            )
        if usd_equiv > user_limit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Invoice amount {ccy_code} {invoice.total_amount} (~USD {usd_equiv}) "
                    f"exceeds your USD {user_limit} approval limit."
                ),
            )

    # Guardrail 3: SOX 404 Segregation of Duties (uploader cannot self-approve their own wire)
    if body.decision == "APPROVED" and not invoice.source_channel.startswith("DEMO_"):
        intake_actor = await db.scalar(
            select(AuditLog.actor_id)
            .where(
                AuditLog.invoice_id == inv_id,
                AuditLog.action == "INVOICE_RECEIVED",
            )
            .order_by(AuditLog.created_at.asc())
        )
        if intake_actor and intake_actor.lower() == actor_email.lower():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "SOX 404 Segregation of Duties violation: the user who ingested this "
                    "invoice cannot self-approve its wire payment. Escalate to another approver."
                ),
            )

    req.status = ApprovalStatus.APPROVED if body.decision == "APPROVED" else ApprovalStatus.REJECTED
    req.decided_by = actor_id
    req.decision_reason = body.reason
    req.decided_at = datetime.now(UTC)

    write_audit_log(
        db,
        invoice_id=inv_id,
        actor_type=ActorType.HUMAN,
        actor_id=actor_email,
        action=f"APPROVAL_{body.decision}",
        previous_state=prev_status,
        new_state=req.status.value,
        details={
            "approval_request_id": str(req_id),
            "decision": body.decision,
            "reason": body.reason,
        },
    )
    await db.commit()

    try:
        await resume_invoice_workflow(
            inv_id,
            decision=body.decision,
            actor_email=actor_email,
            reason=body.reason,
        )
    except Exception as exc:
        # Recover cleanly so ApprovalRequest never stays orphaned as APPROVED if resume fails
        logger.exception(
            "approval_workflow_resume_failed",
            extra={"extra_data": {"approval_id": str(req_id), "invoice_id": str(inv_id)}},
        )
        db.expire_all()
        failed_req = await db.scalar(
            select(ApprovalRequest).where(ApprovalRequest.id == req_id).with_for_update()
        )
        if failed_req:
            failed_req.status = prev_status_enum
            failed_req.decided_by = None
            failed_req.decision_reason = None
            failed_req.decided_at = None
            write_audit_log(
                db,
                invoice_id=inv_id,
                actor_type=ActorType.SYSTEM,
                actor_id="approval_supervisor",
                action="APPROVAL_RESUME_REVERTED",
                previous_state=body.decision,
                new_state=prev_status,
                details={
                    "approval_request_id": str(req_id),
                    "error_type": type(exc).__name__,
                },
            )
            await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to resume invoice checkpoint; approval decision was safely reverted.",
        ) from exc

    db.expire_all()
    refreshed_req = await db.scalar(select(ApprovalRequest).where(ApprovalRequest.id == req_id))
    refreshed_inv = await db.scalar(select(Invoice).where(Invoice.id == inv_id))
    if not refreshed_req or not refreshed_inv:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reload invoice state after workflow resume.",
        )

    return ApprovalDecisionResponse(
        approval=ApprovalRequestResponse.model_validate(refreshed_req),
        invoice_status=refreshed_inv.status.value,
        settlement_reference=refreshed_inv.settlement_reference,
    )


@router.post("/approvals/{approval_id}/escalate-sla", response_model=ApprovalRequestResponse)
async def escalate_approval_sla(
    approval_id: uuid.UUID,
    authorized_user: Annotated[
        User, Depends(require_roles(UserRole.FINANCE_MANAGER, UserRole.CONTROLLER, UserRole.ADMIN))
    ],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ApprovalRequestResponse:
    """Escalates a pending approval to Corporate Controller when its SLA breaches."""
    req = await db.scalar(
        select(ApprovalRequest).where(ApprovalRequest.id == approval_id).with_for_update()
    )
    if not req:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approval request not found.")

    if req.status not in {ApprovalStatus.PENDING, ApprovalStatus.ESCALATED}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot escalate finalized approval in status '{req.status.value}'.",
        )

    invoice = await db.scalar(
        select(Invoice).where(Invoice.id == req.invoice_id).with_for_update()
    )
    if not invoice or invoice.status == InvoiceStatus.CANCELLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Associated invoice not found.")

    if invoice.status not in RESUMABLE_INVOICE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot escalate SLA for invoice in '{invoice.status.value}' state.",
        )

    prev_status = req.status.value
    req.status = ApprovalStatus.ESCALATED
    if ROLE_RANK[req.required_role] < ROLE_RANK[UserRole.CONTROLLER]:
        req.required_role = UserRole.CONTROLLER

    inv_prev = invoice.status.value
    invoice.status = InvoiceStatus.ESCALATED_SLA
    write_audit_log(
        db,
        invoice_id=invoice.id,
        actor_type=ActorType.HUMAN,
        actor_id=authorized_user.email,
        action="SLA_ESCALATED",
        previous_state=inv_prev,
        new_state=InvoiceStatus.ESCALATED_SLA.value,
        details={
            "approval_request_id": str(req.id),
            "previous_approval_status": prev_status,
            "escalated_to_role": req.required_role.value,
        },
    )

    await db.commit()
    await db.refresh(req)
    return ApprovalRequestResponse.model_validate(req)