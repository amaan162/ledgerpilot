import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class UserRole(enum.StrEnum):
    AP_CLERK = "AP_CLERK"
    FINANCE_MANAGER = "FINANCE_MANAGER"
    CONTROLLER = "CONTROLLER"
    ADMIN = "ADMIN"


class VendorStatus(enum.StrEnum):
    ACTIVE = "ACTIVE"
    FROZEN = "FROZEN"


class POStatus(enum.StrEnum):
    OPEN = "OPEN"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    CLOSED = "CLOSED"


class InvoiceStatus(enum.StrEnum):
    RECEIVED = "RECEIVED"
    SCANNING_SECURITY = "SCANNING_SECURITY"
    EXTRACTING = "EXTRACTING"
    MATCHING_DETERMINISTIC = "MATCHING_DETERMINISTIC"
    CHECKING_CONTRACT = "CHECKING_CONTRACT"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    AUTO_APPROVED = "AUTO_APPROVED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    QUARANTINED_FRAUD_RISK = "QUARANTINED_FRAUD_RISK"
    ESCALATED_SLA = "ESCALATED_SLA"
    PAYMENT_STAGED = "PAYMENT_STAGED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ApprovalStatus(enum.StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ESCALATED = "ESCALATED"


class ActorType(enum.StrEnum):
    SYSTEM = "SYSTEM"
    AGENT = "AGENT"
    HUMAN = "HUMAN"
    MCP = "MCP"
    N8N = "N8N"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role_enum"), nullable=False)
    api_key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    approval_limit_usd: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    legal_name: Mapped[str] = mapped_column(String(255), nullable=False)
    tax_id: Mapped[str] = mapped_column(String(100), nullable=False)
    verified_iban: Mapped[str] = mapped_column(String(64), nullable=False)
    verified_bic: Mapped[str] = mapped_column(String(32), nullable=False)
    verified_bank_name: Mapped[str] = mapped_column(String(255), nullable=False)
    default_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    payment_terms_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    status: Mapped[VendorStatus] = mapped_column(
        Enum(VendorStatus, name="vendor_status_enum"),
        nullable=False,
        default=VendorStatus.ACTIVE,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    purchase_orders: Mapped[list["PurchaseOrder"]] = relationship(back_populates="vendor")
    contract_chunks: Mapped[list["ContractChunk"]] = relationship(back_populates="vendor")
    invoices: Mapped[list["Invoice"]] = relationship(back_populates="vendor")


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    po_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vendors.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    total_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    line_items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[POStatus] = mapped_column(
        Enum(POStatus, name="po_status_enum"), nullable=False, default=POStatus.OPEN
    )
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    vendor: Mapped["Vendor"] = relationship(back_populates="purchase_orders")
    goods_receipts: Mapped[list["GoodsReceipt"]] = relationship(back_populates="purchase_order")


class GoodsReceipt(Base):
    __tablename__ = "goods_receipts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    gr_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    po_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    received_items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    verified_by: Mapped[str] = mapped_column(String(255), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    purchase_order: Mapped["PurchaseOrder"] = relationship(back_populates="goods_receipts")


class ContractChunk(Base):
    __tablename__ = "contract_chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_name: Mapped[str] = mapped_column(String(255), nullable=False)
    clause_ref: Mapped[str] = mapped_column(String(100), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    vendor: Mapped["Vendor"] = relationship(back_populates="contract_chunks")

    __table_args__ = (
        Index(
            "ix_contract_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    file_sha256: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    source_channel: Mapped[str] = mapped_column(String(50), nullable=False, default="WEB_UPLOAD")

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    invoice_number: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    po_number: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)

    subtotal_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    tax_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    total_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    extracted_iban: Mapped[str | None] = mapped_column(String(64), nullable=True)

    extracted_payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    security_report: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    match_report: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    rag_citations: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    risk_flags: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus, name="invoice_status_enum"),
        nullable=False,
        default=InvoiceStatus.RECEIVED,
        index=True,
    )
    thread_id: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)

    # ISO 20022 (pain.001) Settlement Reference
    settlement_reference: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    settlement_xml_path: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Operating Economics & Performance Telemetry
    llm_cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False, default=Decimal("0.000000"))
    processing_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    vendor: Mapped["Vendor | None"] = relationship(back_populates="invoices")
    approvals: Mapped[list["ApprovalRequest"]] = relationship(back_populates="invoice")

    __table_args__ = (
        # Database-level duplicate-payment shield: blocks duplicate active invoice numbers per vendor
        Index(
            "uq_invoices_vendor_number_active",
            "vendor_id",
            "invoice_number",
            unique=True,
            postgresql_where=text(
                "vendor_id IS NOT NULL AND invoice_number IS NOT NULL AND status NOT IN ('REJECTED', 'CANCELLED')"
            ),
        ),
    )


class InvoiceDocument(Base):
    """Persistent binary store for uploaded source PDFs/images (survives ephemeral cloud disk wipes)."""

    __tablename__ = "invoice_documents"

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="CASCADE"),
        primary_key=True,
    )
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    file_bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    required_role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role_enum", create_type=False), nullable=False
    )
    status: Mapped[ApprovalStatus] = mapped_column(
        Enum(ApprovalStatus, name="approval_status_enum"),
        nullable=False,
        default=ApprovalStatus.PENDING,
        index=True,
    )
    reason_summary: Mapped[str] = mapped_column(Text, nullable=False)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    sla_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    invoice: Mapped["Invoice"] = relationship(back_populates="approvals")


class AuditLog(Base):
    """Append-only compliance ledger. Protected by a PostgreSQL BEFORE UPDATE/DELETE trigger."""

    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    actor_type: Mapped[ActorType] = mapped_column(Enum(ActorType, name="actor_type_enum"), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    previous_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    new_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class DeadLetterJob(Base):
    __tablename__ = "dead_letter_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    error_message: Mapped[str] = mapped_column(Text, nullable=False)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
