import hashlib
import hmac
import json
import threading
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import ActorType, AuditLog, DeadLetterJob

_chain_lock = threading.Lock()
_last_seal = "GENESIS"


def _compute_audit_seal(
    *,
    invoice_id: uuid.UUID | None,
    actor_type: str,
    actor_id: str,
    action: str,
    previous_state: str | None,
    new_state: str | None,
    business_details: dict[str, Any],
    prev_seal: str,
) -> str:
    """Computes an HMAC-SHA256 cryptographic seal over canonical audit fields."""
    secret = get_settings().WEBHOOK_HMAC_SECRET.encode("utf-8")
    canonical = json.dumps(
        {
            "invoice_id": str(invoice_id) if invoice_id else None,
            "actor_type": actor_type,
            "actor_id": actor_id,
            "action": action,
            "previous_state": previous_state,
            "new_state": new_state,
            "details": business_details,
            "prev_seal": prev_seal,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hmac.new(secret, canonical, hashlib.sha256).hexdigest()


def write_audit_log(
    db: AsyncSession,
    *,
    actor_type: ActorType,
    actor_id: str,
    action: str,
    invoice_id: uuid.UUID | None = None,
    previous_state: str | None = None,
    new_state: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditLog:
    """
    Appends a cryptographically HMAC-SHA256 sealed row to the immutable audit_logs table.
    Detects post-hoc tampering even if a database superuser bypassed the append-only trigger.
    """
    global _last_seal
    business_details = dict(details or {})
    business_details.pop("_integrity", None)

    with _chain_lock:
        prev_seal = _last_seal
        seal = _compute_audit_seal(
            invoice_id=invoice_id,
            actor_type=actor_type.value,
            actor_id=actor_id,
            action=action,
            previous_state=previous_state,
            new_state=new_state,
            business_details=business_details,
            prev_seal=prev_seal,
        )
        _last_seal = seal

    sealed_details = {
        **business_details,
        "_integrity": {
            "alg": "HMAC-SHA256",
            "prev_seal": prev_seal[:16],
            "prev_seal_full": prev_seal,
            "seal": seal,
        },
    }

    entry = AuditLog(
        invoice_id=invoice_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        previous_state=previous_state,
        new_state=new_state,
        details=sealed_details,
    )
    db.add(entry)
    return entry


def enqueue_dead_letter(
    db: AsyncSession,
    *,
    source: str,
    idempotency_key: str,
    payload: dict[str, Any],
    error_message: str,
) -> DeadLetterJob:
    job = DeadLetterJob(
        source=source,
        idempotency_key=idempotency_key,
        payload=payload,
        error_message=error_message[:2000],
    )
    db.add(job)
    return job


@dataclass(frozen=True)
class AuditIntegrityReport:
    verified: bool
    total_rows_checked: int
    signed_rows_valid: int
    legacy_unsigned_rows: int
    tampered_row_ids: list[str]


async def verify_audit_ledger_integrity(db: AsyncSession, *, limit: int = 500) -> AuditIntegrityReport:
    """Verifies HMAC-SHA256 cryptographic seals across stored audit_logs rows."""
    rows = (await db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit))).all()

    valid_count = 0
    legacy_count = 0
    tampered_ids: list[str] = []

    for row in rows:
        raw_details = dict(row.details or {})
        integrity = raw_details.pop("_integrity", None)
        if not isinstance(integrity, dict) or "seal" not in integrity:
            legacy_count += 1
            continue

        expected_seal = _compute_audit_seal(
            invoice_id=row.invoice_id,
            actor_type=row.actor_type.value,
            actor_id=row.actor_id,
            action=row.action,
            previous_state=row.previous_state,
            new_state=row.new_state,
            business_details=raw_details,
            prev_seal=str(integrity.get("prev_seal_full", "")),
        )
        if hmac.compare_digest(expected_seal, str(integrity["seal"])):
            valid_count += 1
        else:
            tampered_ids.append(str(row.id))

    return AuditIntegrityReport(
        verified=len(tampered_ids) == 0,
        total_rows_checked=len(rows),
        signed_rows_valid=valid_count,
        legacy_unsigned_rows=legacy_count,
        tampered_row_ids=tampered_ids,
    )
