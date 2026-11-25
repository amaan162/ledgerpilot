import uuid
from decimal import Decimal

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.db.models import ContractChunk, Vendor, VendorStatus
from app.schemas.extraction import InvoiceExtraction, ThreeWayMatchReport
from app.schemas.rag import ContractComplianceLLM, ContractViolationLLM
from app.services.rag import evaluate_contract_compliance, retrieve_vendor_clauses


def _basis_vec(index: int, dims: int = 768) -> list[float]:
    v = [0.0] * dims
    v[index] = 1.0
    return v


class FakeRAGLLM:
    """Deterministic stub so unit tests verify pgvector math, isolation, and citation checks offline."""

    def __init__(self, query_vec: list[float], compliance_reply: ContractComplianceLLM | None = None):
        self.query_vec = query_vec
        self.compliance_reply = compliance_reply
        self.audit_calls = 0

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self.query_vec for _ in texts]

    async def audit_contract_compliance(self, prompt_text: str) -> tuple[ContractComplianceLLM, Decimal, dict]:
        self.audit_calls += 1
        assert self.compliance_reply is not None
        return self.compliance_reply, Decimal("0.000500"), {"model": "fake-gemini"}


def _dummy_extraction(vendor_name: str = "Test Vendor") -> InvoiceExtraction:
    return InvoiceExtraction(
        vendor_name=vendor_name,
        invoice_number="INV-RAG-001",
        po_number="PO-RAG-001",
        payment_terms="Net-30",
        currency="USD",
        subtotal=Decimal("500.00"),
        tax_amount=Decimal("0.00"),
        total_amount=Decimal("500.00"),
        bank_iban="US64SVBKUS6S3300958879",
    )


def _dummy_match(vendor_id: str | None) -> ThreeWayMatchReport:
    return ThreeWayMatchReport(
        is_clean_match=True,
        vendor_matched=vendor_id is not None,
        vendor_id=vendor_id,
        po_matched=True,
        goods_receipt_matched=True,
        arithmetic_valid=True,
        iban_verified=True,
        currency_valid=True,
        computed_subtotal=Decimal("500.00"),
        computed_total=Decimal("500.00"),
        summary="Clean match",
    )


@pytest.mark.asyncio
async def test_pgvector_vendor_isolation_and_citation_grounding() -> None:
    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    tag = uuid.uuid4().hex[:8]
    v1_id = uuid.uuid4()
    v2_id = uuid.uuid4()

    async with session_factory() as db:
        try:
            db.add_all(
                [
                    Vendor(
                        id=v1_id,
                        vendor_code=f"TEST-V1-{tag}",
                        legal_name="Alpha Isolated LLC",
                        tax_id=f"TAX-1-{tag}",
                        verified_iban="US00ALPHA001",
                        verified_bic="ALPHUS33",
                        verified_bank_name="Alpha Bank",
                        status=VendorStatus.ACTIVE,
                    ),
                    Vendor(
                        id=v2_id,
                        vendor_code=f"TEST-V2-{tag}",
                        legal_name="Beta Isolated LLC",
                        tax_id=f"TAX-2-{tag}",
                        verified_iban="US00BETA002",
                        verified_bic="BETAUS33",
                        verified_bank_name="Beta Bank",
                        status=VendorStatus.ACTIVE,
                    ),
                ]
            )
            await db.flush()
            db.add_all(
                [
                    ContractChunk(
                        vendor_id=v1_id,
                        document_name="MSA_Alpha.pdf",
                        clause_ref="Section 4.3 - Rate Cap",
                        content="Advisory rate is capped at $200/hr; emergency surcharges disallowed.",
                        embedding=_basis_vec(0),
                    ),
                    ContractChunk(
                        vendor_id=v2_id,
                        document_name="MSA_Beta_SECRET.pdf",
                        clause_ref="Section 1.1 - Confidential",
                        content="Beta secret clause that must never leak to Alpha.",
                        embedding=_basis_vec(0),  # Identical vector, different vendor!
                    ),
                ]
            )
            await db.commit()

            # 1. Strict Vendor Isolation: querying for v1 MUST NOT return v2's identical vector
            fake_llm = FakeRAGLLM(query_vec=_basis_vec(0))
            hits = await retrieve_vendor_clauses(
                db, fake_llm, vendor_id=v1_id, query_text="rate cap emergency surcharge"
            )
            assert len(hits) == 1
            assert hits[0].document_name == "MSA_Alpha.pdf"
            assert hits[0].similarity_score >= 0.85

            # 2. Low-Evidence Escalation: orthogonal vector (cosine=0.0) escalates WITHOUT calling LLM
            low_ev_llm = FakeRAGLLM(query_vec=_basis_vec(9))
            low_report = await evaluate_contract_compliance(
                db,
                low_ev_llm,
                extraction=_dummy_extraction("Alpha Isolated LLC"),
                match_report=_dummy_match(str(v1_id)),
            )
            assert low_report.evidence_sufficient is False
            assert "INSUFFICIENT_CONTRACT_EVIDENCE" in low_report.risk_flags
            assert low_ev_llm.audit_calls == 0

            # 3. Hallucinated Citation Filter: fake [C99] is stripped; valid [C1] is hydrated
            hallucinating_llm = FakeRAGLLM(
                query_vec=_basis_vec(0),
                compliance_reply=ContractComplianceLLM(
                    is_compliant=False,
                    confidence=0.92,
                    summary="Emergency surcharge violates Section 4.3.",
                    cited_clause_ids=["C1", "C99"],
                    violations=[
                        ContractViolationLLM(
                            rule_type="RATE_CAP_EXCEEDED",
                            severity="HIGH",
                            explanation="Unapproved emergency surcharge billed.",
                            cited_clause_id="C1",
                        ),
                        ContractViolationLLM(
                            rule_type="INVENTED_RULE",
                            severity="LOW",
                            explanation="Hallucinated clause reference.",
                            cited_clause_id="C99",
                        ),
                    ],
                ),
            )
            audit_report = await evaluate_contract_compliance(
                db,
                hallucinating_llm,
                extraction=_dummy_extraction("Alpha Isolated LLC"),
                match_report=_dummy_match(str(v1_id)),
            )
            assert audit_report.evidence_sufficient is True
            assert audit_report.is_compliant is False
            assert len(audit_report.violations) == 1
            assert audit_report.violations[0].clause_ref == "Section 4.3 - Rate Cap"
            assert "UNVERIFIED_CITATION_FILTERED" in audit_report.risk_flags
            assert "CONTRACT_POLICY_VIOLATION" in audit_report.risk_flags
        finally:
            await db.execute(delete(ContractChunk).where(ContractChunk.vendor_id.in_([v1_id, v2_id])))
            await db.execute(delete(Vendor).where(Vendor.id.in_([v1_id, v2_id])))
            await db.commit()

    await engine.dispose()


@pytest.mark.asyncio
async def test_unknown_vendor_escalates_without_llm_call() -> None:
    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    fake_llm = FakeRAGLLM(query_vec=_basis_vec(0))
    async with session_factory() as db:
        report = await evaluate_contract_compliance(
            db,
            fake_llm,
            extraction=_dummy_extraction("Unregistered Shell Corp"),
            match_report=_dummy_match(vendor_id=None),
        )
        assert report.evidence_sufficient is False
        assert "INSUFFICIENT_CONTRACT_EVIDENCE" in report.risk_flags
        assert fake_llm.audit_calls == 0

    await engine.dispose()
