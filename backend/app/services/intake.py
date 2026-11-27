import hashlib
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import REPO_ROOT
from app.db.models import ActorType, Invoice, InvoiceDocument, InvoiceStatus
from app.services.audit import write_audit_log

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024  # 15 MB


def _content_type_for_ext(ext: str) -> str:
    lowered = ext.lower()
    if lowered == ".png":
        return "image/png"
    if lowered in {".jpg", ".jpeg"}:
        return "image/jpeg"
    return "application/pdf"


async def _ensure_document_stored(
    db: AsyncSession,
    *,
    invoice_id: uuid.UUID,
    ext: str,
    file_bytes: bytes,
) -> None:
    exists = await db.scalar(
        select(InvoiceDocument.invoice_id).where(InvoiceDocument.invoice_id == invoice_id)
    )
    if exists is None:
        db.add(
            InvoiceDocument(
                invoice_id=invoice_id,
                content_type=_content_type_for_ext(ext),
                file_size_bytes=len(file_bytes),
                file_bytes=file_bytes,
            )
        )


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _validate_upload(filename: str, file_bytes: bytes) -> str:
    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded invoice file is empty.",
        )
    if len(file_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Uploaded file exceeds 15 MB limit.",
        )
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type '{ext}'. Allowed: PDF, PNG, JPG, JPEG.",
        )
    return ext


def _persist_file_safely(file_sha256: str, ext: str, file_bytes: bytes) -> Path:
    upload_dir = REPO_ROOT / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / f"{file_sha256}{ext}"
    if not target.exists():
        target.write_bytes(file_bytes)
    return target


async def ingest_invoice_bytes(
    db: AsyncSession,
    *,
    filename: str,
    file_bytes: bytes,
    source_channel: str,
    actor_type: ActorType,
    actor_id: str,
    idempotency_key: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> tuple[Invoice, bool]:
    """
    Idempotently ingests an invoice file.
    Returns (invoice, is_duplicate). Guarantees 0% duplicate invoice creation.
    """
    ext = _validate_upload(filename, file_bytes)
    file_sha256 = compute_sha256(file_bytes)
    resolved_key = (idempotency_key.strip() if idempotency_key else f"sha256:{file_sha256}")[:128]

    existing = await db.scalar(
        select(Invoice).where(
            or_(
                Invoice.idempotency_key == resolved_key,
                Invoice.file_sha256 == file_sha256,
            )
        )
    )
    if existing:
        await _ensure_document_stored(db, invoice_id=existing.id, ext=ext, file_bytes=file_bytes)
        write_audit_log(
            db,
            invoice_id=existing.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="IDEMPOTENT_REPLAY_IGNORED",
            previous_state=existing.status.value,
            new_state=existing.status.value,
            details={
                "incoming_idempotency_key": resolved_key,
                "incoming_filename": filename,
                "source_channel": source_channel,
            },
        )
        await db.commit()
        return existing, True

    stored_path = _persist_file_safely(file_sha256, ext, file_bytes)
    invoice = Invoice(
        idempotency_key=resolved_key,
        file_sha256=file_sha256,
        original_filename=Path(filename).name[:255],
        source_channel=source_channel[:50],
        status=InvoiceStatus.RECEIVED,
        thread_id=f"inv-{uuid.uuid4().hex}",
        extracted_payload={
            "stored_file_path": str(stored_path),
            "intake_metadata": metadata or {},
        },
    )

    try:
        db.add(invoice)
        await db.flush()
        db.add(
            InvoiceDocument(
                invoice_id=invoice.id,
                content_type=_content_type_for_ext(ext),
                file_size_bytes=len(file_bytes),
                file_bytes=file_bytes,
            )
        )
        write_audit_log(
            db,
            invoice_id=invoice.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="INVOICE_RECEIVED",
            previous_state=None,
            new_state=InvoiceStatus.RECEIVED.value,
            details={
                "filename": invoice.original_filename,
                "file_sha256": file_sha256,
                "idempotency_key": resolved_key,
                "source_channel": source_channel,
                "size_bytes": len(file_bytes),
            },
        )
        await db.commit()
        await db.refresh(invoice)
        return invoice, False
    except IntegrityError:
        await db.rollback()
        existing = await db.scalar(
            select(Invoice).where(
                or_(
                    Invoice.idempotency_key == resolved_key,
                    Invoice.file_sha256 == file_sha256,
                )
            )
        )
        if not existing:
            raise
        await _ensure_document_stored(db, invoice_id=existing.id, ext=ext, file_bytes=file_bytes)
        write_audit_log(
            db,
            invoice_id=existing.id,
            actor_type=actor_type,
            actor_id=actor_id,
            action="IDEMPOTENT_REPLAY_IGNORED",
            previous_state=existing.status.value,
            new_state=existing.status.value,
            details={"race_condition_resolved": True, "idempotency_key": resolved_key},
        )
        await db.commit()
        return existing, True
