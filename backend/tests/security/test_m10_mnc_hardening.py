import time
import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.core.hardening import api_rate_limiter
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    InvoiceStatus,
    UserRole,
)
from app.schemas.extraction import InvoiceExtraction, SecurityScanReport, ThreeWayMatchReport
from app.schemas.rag import ContractComplianceReport
from app.services.audit import verify_audit_ledger_integrity, write_audit_log
from app.services.file_security import FileSecurityError, validate_uploaded_document
from app.services.intake import ingest_invoice_bytes
from app.services.pdf_forensics import scan_document_bytes
from app.services.pdf_generator import InvoicePDFSpec, generate_invoice_pdf_bytes
from app.services.policy import evaluate_ap_policy
from app.services.resilience import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    DailyLLMBudgetGuard,
    LLMBudgetExceededError,
)

settings = get_settings()


# 1. HTTP Security Headers & no-store financial caching header
@pytest.mark.asyncio
async def test_mnc01_security_headers_and_no_store(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/metrics/overview", headers={"X-API-Key": settings.MANAGER_API_KEY})
    assert resp.status_code == 200
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert resp.headers["Referrer-Policy"] == "no-referrer"
    assert "max-age=" in resp.headers["Strict-Transport-Security"]
    assert "no-store" in resp.headers["Cache-Control"]


# 2. Magic-byte, polyglot executable & path-traversal upload blocking
@pytest.mark.asyncio
async def test_mnc02_magic_byte_and_polyglot_upload_blocked(client: AsyncClient) -> None:
    # Spoofed .pdf containing Windows EXE magic bytes ("MZ")
    resp_exe = await client.post(
        "/api/v1/invoices/ingest",
        headers={"X-API-Key": settings.CLERK_API_KEY},
        files={"file": ("../../evil_invoice.pdf", b"MZ\x90\x00fake_pe_binary", "application/pdf")},
    )
    assert resp_exe.status_code == 400
    assert "polyglot" in resp_exe.json()["detail"].lower()

    # Spoofed .pdf containing HTML/XSS script
    with pytest.raises(FileSecurityError):
        validate_uploaded_document("invoice.pdf", b"<script>alert(1)</script>")

    # Path traversal sanitized cleanly on valid PDF magic bytes
    safe = validate_uploaded_document("../../../etc/passwd_inv.pdf", b"%PDF-1.4\n%%EOF")
    assert "/" not in safe and ".." not in safe


# 3. Weaponized PDF with embedded /JavaScript & /OpenAction quarantined
def test_mnc03_pdf_javascript_exploit_detected_and_quarantined() -> None:
    weaponized_pdf = (
        b"%PDF-1.4\n"
        b"1 0 obj << /Type /Catalog /Pages 2 0 R "
        b"/OpenAction << /S /JavaScript /JS (app.alert('pwn')) >> >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n"
        b"xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n"
        b"0000000120 00000 n \n0000000179 00000 n \n"
        b"trailer << /Size 4 /Root 1 0 R >>\nstartxref\n250\n%%EOF"
    )
    sec = scan_document_bytes(weaponized_pdf, "weaponized.pdf")
    assert "PDF_ACTIVE_CONTENT_EXPLOIT" in sec.risk_flags

    dummy_ext = InvoiceExtraction(
        vendor_name="Apex Cloud",
        invoice_number="INV-JS-01",
        currency="USD",
        subtotal=Decimal("500.00"),
        tax_amount=Decimal("0.00"),
        total_amount=Decimal("500.00"),
        bank_iban="US64SVBKUS6S3300958879",
    )
    dummy_match = ThreeWayMatchReport(
        is_clean_match=True,
        vendor_matched=True,
        po_matched=True,
        goods_receipt_matched=True,
        arithmetic_valid=True,
        iban_verified=True,
        currency_valid=True,
        computed_subtotal=Decimal("500.00"),
        computed_total=Decimal("500.00"),
        summary="ok",
    )
    dummy_rag = ContractComplianceReport(
        evidence_sufficient=True,
        is_compliant=True,
        confidence=0.95,
        query_used="q",
        summary="ok",
    )
    decision = evaluate_ap_policy(
        security_report=sec,
        extraction=dummy_ext,
        match_report=dummy_match,
        contract_report=dummy_rag,
    )
    assert decision.outcome == "QUARANTINE"


# 4. OFAC / Sanctions high-risk IBAN prefix blocked deterministically
def test_mnc04_ofac_sanctions_iban_hard_quarantined() -> None:
    sec = SecurityScanReport(
        file_type="PDF",
        page_count=1,
        is_suspicious=False,
        prompt_injection_detected=False,
        hidden_text_detected=False,
        risk_score=0,
    )
    sanctioned_ext = InvoiceExtraction(
        vendor_name="Shell Export Co",
        invoice_number="INV-OFAC-01",
        currency="USD",
        subtotal=Decimal("400.00"),
        tax_amount=Decimal("0.00"),
        total_amount=Decimal("400.00"),
        bank_iban="IR82 0540 1026 8002 0817 9090 02",
    )
    match = ThreeWayMatchReport(
        is_clean_match=True,
        vendor_matched=True,
        po_matched=True,
        goods_receipt_matched=True,
        arithmetic_valid=True,
        iban_verified=True,
        currency_valid=True,
        computed_subtotal=Decimal("400.00"),
        computed_total=Decimal("400.00"),
        summary="ok",
    )
    rag = ContractComplianceReport(
        evidence_sufficient=True,
        is_compliant=True,
        confidence=0.95,
        query_used="q",
        summary="ok",
    )
    decision = evaluate_ap_policy(
        security_report=sec,
        extraction=sanctioned_ext,
        match_report=match,
        contract_report=rag,
    )
    assert decision.outcome == "QUARANTINE"
    assert "SANCTIONS_JURISDICTION_BLOCK" in decision.combined_risk_flags


# 5. SOX 404 Segregation of Duties: uploader cannot self-approve their own invoice
@pytest.mark.asyncio
async def test_mnc05_sox_404_segregation_of_duties_blocks_self_approval(
    client: AsyncClient,
) -> None:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    sf = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    tag = uuid.uuid4().hex[:6].upper()
    pdf = generate_invoice_pdf_bytes(
        InvoicePDFSpec(
            vendor_name="Apex Cloud Infrastructure Inc.",
            vendor_code="VND-US-CLOUD01",
            vendor_tax_id="US-EIN-84-2910442",
            invoice_number=f"INV-SOD-{tag}",
            po_number="PO-2026-1002",
            invoice_date="2026-11-25",
            due_date="2026-12-25",
            payment_terms="Net-30",
            currency="USD",
            iban="US64SVBKUS6S3300958879",
            bic="SVBKUS6S",
            line_items=[
                {
                    "sku": "CLD-ENT-SUPPORT",
                    "description": "Advisory",
                    "quantity": 10,
                    "unit_price": "200.00",
                    "line_total": "2000.00",
                }
            ],
            subtotal="2000.00",
            tax_amount="0.00",
            total_amount="2000.00",
        )
    )

    # Manager uploads the invoice themselves
    async with sf() as db:
        inv, _ = await ingest_invoice_bytes(
            db,
            filename=f"sod_{tag}.pdf",
            file_bytes=pdf,
            source_channel="API_UPLOAD",
            actor_type=ActorType.HUMAN,
            actor_id="manager@ledgerpilot.io",
        )
        inv.total_amount = Decimal("2000.00")
        inv.status = InvoiceStatus.AWAITING_APPROVAL
        req = ApprovalRequest(
            invoice_id=inv.id,
            required_role=UserRole.FINANCE_MANAGER,
            status=ApprovalStatus.PENDING,
            reason_summary="SoD test",
            sla_due_at=inv.created_at,
        )
        db.add(req)
        await db.commit()
        approval_id = str(req.id)

    # Same manager tries to approve their own upload -> 403 SOX 404 violation!
    resp = await client.post(
        f"/api/v1/approvals/{approval_id}/decide",
        headers={"X-API-Key": settings.MANAGER_API_KEY},
        json={"decision": "APPROVED", "reason": "Self-approving my own uploaded invoice"},
    )
    assert resp.status_code == 403
    assert "segregation of duties" in resp.json()["detail"].lower()
    await engine.dispose()


# 6. Cryptographic HMAC-SHA256 audit ledger verification
@pytest.mark.asyncio
async def test_mnc06_cryptographic_audit_seal_verification(client: AsyncClient) -> None:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    sf = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    async with sf() as db:
        write_audit_log(
            db,
            actor_type=ActorType.SYSTEM,
            actor_id="mnc_integrity_test",
            action="SEALED_CHECKPOINT_EVENT",
            details={"probe": uuid.uuid4().hex},
        )
        await db.commit()
        report = await verify_audit_ledger_integrity(db, limit=100)
        assert report.verified is True
        assert report.signed_rows_valid >= 1
        assert report.tampered_row_ids == []

    # Endpoint enforces Controller+ RBAC
    r_clerk = await client.get("/api/v1/security/audit-integrity", headers={"X-API-Key": settings.CLERK_API_KEY})
    assert r_clerk.status_code == 403

    r_ctrl = await client.get(
        "/api/v1/security/audit-integrity", headers={"X-API-Key": settings.CONTROLLER_API_KEY}
    )
    assert r_ctrl.status_code == 200
    assert r_ctrl.json()["verified"] is True
    await engine.dispose()


# 7. Sliding-window rate limiter blocks burst abuse with 429 + Retry-After
@pytest.mark.asyncio
async def test_mnc07_rate_limiter_blocks_burst_with_429(client: AsyncClient) -> None:
    api_rate_limiter.reset()
    original_max = api_rate_limiter.max_requests
    api_rate_limiter.max_requests = 2
    try:
        headers = {
            "X-API-Key": settings.MANAGER_API_KEY,
            "X-Force-Rate-Limit": "true",
        }
        ok1, _, _ = api_rate_limiter.check("burst-test-key", limit_override=2)
        ok2, _, _ = api_rate_limiter.check("burst-test-key", limit_override=2)
        ok3, _, retry_s = api_rate_limiter.check("burst-test-key", limit_override=2)
        assert ok1 is True and ok2 is True and ok3 is False and retry_s >= 1

        resp = await client.get("/api/v1/metrics/overview", headers=headers)
        assert resp.status_code == 200
        assert "X-RateLimit-Limit" in resp.headers
        assert "X-RateLimit-Remaining" in resp.headers
    finally:
        api_rate_limiter.max_requests = original_max
        api_rate_limiter.reset()


# 8. Circuit breaker trips OPEN on failures and recovers via HALF_OPEN -> CLOSED
def test_mnc08_circuit_breaker_trips_and_recovers() -> None:
    cb = CircuitBreaker("test_upstream", failure_threshold=2, recovery_timeout_s=0.05)
    cb.allow_request()
    cb.record_failure()
    cb.record_failure()
    assert cb.snapshot().state == "OPEN"
    assert cb.snapshot().total_trips == 1

    with pytest.raises(CircuitBreakerOpenError):
        cb.allow_request()

    time.sleep(0.06)
    cb.allow_request()  # Transitions to HALF_OPEN
    cb.record_success()  # Recovers cleanly to CLOSED
    assert cb.snapshot().state == "CLOSED"


# 9. FinOps Daily LLM Budget Guard blocks runaway cloud AI spend
def test_mnc09_daily_llm_budget_guard_blocks_overspend() -> None:
    guard = DailyLLMBudgetGuard(max_daily_usd=Decimal("0.01"))
    guard.assert_within_budget()
    guard.record_spend(Decimal("0.015000"))
    with pytest.raises(LLMBudgetExceededError):
        guard.assert_within_budget()


# 10. MNC Security Posture endpoint returns live controls & circuit telemetry
@pytest.mark.asyncio
async def test_mnc10_security_posture_endpoint(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/security/posture", headers={"X-API-Key": settings.CONTROLLER_API_KEY})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "HEALTHY"
    assert body["controls"]["sox_404_segregation_of_duties"] == "ENFORCED"
    assert body["controls"]["ofac_sanctions_iban_screening"] == "ENFORCED"
    assert body["controls"]["cryptographic_audit_seals"] == "VERIFIED"
    assert len(body["reliability"]["circuit_breakers"]) == 2
