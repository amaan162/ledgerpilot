import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import ActorType, InvoiceStatus, UserRole, VendorStatus


class HealthResponse(BaseModel):
    status: str
    app: str
    database: str
    pgvector_enabled: bool


class UserMeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: UserRole
    approval_limit_usd: Decimal
    is_active: bool


class VendorResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    vendor_code: str
    legal_name: str
    tax_id: str
    verified_iban: str
    verified_bic: str
    verified_bank_name: str
    default_currency: str
    payment_terms_days: int
    status: VendorStatus


class AuditLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    invoice_id: uuid.UUID | None
    actor_type: ActorType
    actor_id: str
    action: str
    previous_state: str | None
    new_state: str | None
    details: dict[str, Any]
    created_at: datetime


class InvoiceSummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    idempotency_key: str
    file_sha256: str
    original_filename: str
    source_channel: str
    vendor_id: uuid.UUID | None
    invoice_number: str | None
    po_number: str | None
    currency: str | None
    total_amount: Decimal | None
    status: InvoiceStatus
    risk_flags: list[str]
    settlement_reference: str | None
    llm_cost_usd: Decimal
    processing_ms: int
    created_at: datetime


class InvoiceDetailResponse(InvoiceSummaryResponse):
    subtotal_amount: Decimal | None
    tax_amount: Decimal | None
    extracted_iban: str | None
    extracted_payload: dict[str, Any]
    security_report: dict[str, Any]
    match_report: dict[str, Any]
    rag_citations: list[dict[str, Any]]
    thread_id: str
    settlement_xml_path: str | None
    audit_logs: list[AuditLogResponse] = Field(default_factory=list)


class InvoiceIngestResponse(BaseModel):
    duplicate: bool
    message: str
    invoice: InvoiceSummaryResponse


class N8nWebhookIntakeRequest(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    content_base64: str = Field(..., min_length=1)
    idempotency_key: str | None = Field(default=None, max_length=128)
    source_channel: str = Field(default="N8N_GMAIL", max_length=50)
    sender_email: str | None = Field(default=None, max_length=255)
    subject: str | None = Field(default=None, max_length=255)


class DeadLetterResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: str
    idempotency_key: str
    payload: dict[str, Any]
    error_message: str
    retry_count: int
    next_retry_at: datetime | None
    resolved: bool
    created_at: datetime
