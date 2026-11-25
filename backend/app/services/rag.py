import asyncio
import json
import re
import uuid
from decimal import Decimal
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ContractChunk, Vendor
from app.db.session import AsyncSessionLocal
from app.schemas.extraction import InvoiceExtraction, ThreeWayMatchReport
from app.schemas.rag import (
    ContractCitation,
    ContractComplianceLLM,
    ContractComplianceReport,
    ContractViolation,
)
from app.services.llm import GeminiLLMService

MIN_EVIDENCE_SIMILARITY = 0.45
MIN_LLM_CONFIDENCE = 0.65
TOKEN_RE = re.compile(r"[a-z0-9]{3,}")


class RAGLLMProtocol(Protocol):
    async def embed_texts(self, texts: list[str]) -> list[list[float]]: ...

    async def audit_contract_compliance(self, prompt_text: str) -> tuple[ContractComplianceLLM, Decimal, dict]: ...


def _lexical_overlap_score(query_text: str, clause_text: str) -> float:
    q_tokens = set(TOKEN_RE.findall(query_text.lower()))
    if not q_tokens:
        return 0.0
    c_tokens = set(TOKEN_RE.findall(clause_text.lower()))
    return len(q_tokens & c_tokens) / len(q_tokens)


def build_invoice_rag_query(extraction: InvoiceExtraction, match_report: ThreeWayMatchReport) -> str:
    """Constructs a targeted semantic query from invoice terms, line items, and 3-way variances."""
    parts = [
        f"Vendor {extraction.vendor_name}",
        f"currency {extraction.currency}",
        f"payment terms {extraction.payment_terms or 'standard'}",
        f"tax amount {extraction.tax_amount}",
    ]
    if extraction.line_items:
        descs = "; ".join(item.description for item in extraction.line_items[:5])
        parts.append(f"billed items: {descs}")
    if match_report.risk_flags:
        parts.append(f"audit flags: {', '.join(match_report.risk_flags)}")
    if extraction.notes:
        parts.append(f"notes: {extraction.notes[:200]}")
    return " | ".join(parts)


async def index_missing_contract_embeddings(
    db: AsyncSession,
    llm: RAGLLMProtocol,
    *,
    force_reindex: bool = False,
) -> tuple[int, int]:
    """Embeds unindexed vendor MSA contract clauses into PostgreSQL pgvector idempotently."""
    total_chunks = int(await db.scalar(select(func.count(ContractChunk.id))) or 0)

    stmt = select(ContractChunk).order_by(ContractChunk.created_at.asc())
    if not force_reindex:
        stmt = stmt.where(ContractChunk.embedding.is_(None))
    chunks = list((await db.scalars(stmt)).all())

    if not chunks:
        return 0, total_chunks

    texts_to_embed = [f"{chunk.document_name} | {chunk.clause_ref}: {chunk.content}" for chunk in chunks]
    vectors = await llm.embed_texts(texts_to_embed)

    for chunk, vec in zip(chunks, vectors, strict=True):
        chunk.embedding = vec

    await db.commit()
    return len(chunks), total_chunks


async def retrieve_vendor_clauses(
    db: AsyncSession,
    llm: RAGLLMProtocol,
    *,
    vendor_id: uuid.UUID,
    query_text: str,
    top_k: int = 5,
) -> list[ContractCitation]:
    """
    Vendor-isolated hybrid RAG retrieval using pgvector cosine distance + lexical overlap boost.
    Strictly scoped to a single vendor_id to prevent cross-vendor clause leakage.
    """
    query_vectors = await llm.embed_texts([query_text])
    query_vec = query_vectors[0]

    distance_expr = ContractChunk.embedding.cosine_distance(query_vec).label("cosine_distance")
    stmt = (
        select(ContractChunk, distance_expr)
        .where(
            ContractChunk.vendor_id == vendor_id,
            ContractChunk.embedding.is_not(None),
        )
        .order_by(distance_expr.asc())
        .limit(max(top_k * 2, 10))
    )
    rows = (await db.execute(stmt)).all()

    scored: list[tuple[float, ContractChunk]] = []
    for chunk, dist in rows:
        cosine_sim = max(0.0, min(1.0, 1.0 - float(dist)))
        lex_score = _lexical_overlap_score(query_text, f"{chunk.clause_ref} {chunk.content}")
        hybrid_score = round(min(1.0, (0.85 * cosine_sim) + (0.15 * lex_score)), 4)
        scored.append((hybrid_score, chunk))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    top_scored = scored[:top_k]

    citations: list[ContractCitation] = []
    for idx, (score, chunk) in enumerate(top_scored, start=1):
        citations.append(
            ContractCitation(
                citation_id=f"C{idx}",
                chunk_id=str(chunk.id),
                document_name=chunk.document_name,
                clause_ref=chunk.clause_ref,
                excerpt=chunk.content,
                similarity_score=score,
            )
        )
    return citations


async def evaluate_contract_compliance(
    db: AsyncSession,
    llm: RAGLLMProtocol,
    *,
    extraction: InvoiceExtraction,
    match_report: ThreeWayMatchReport,
    top_k: int = 5,
) -> ContractComplianceReport:
    """
    Runs evidence-grounded Contract RAG audit with deterministic low-evidence escalation
    and pure-Python citation verification.
    """
    query_text = build_invoice_rag_query(extraction, match_report)

    # Guardrail 1: Unknown vendor -> deterministic escalation (never hallucinate a contract)
    if not match_report.vendor_id:
        return ContractComplianceReport(
            evidence_sufficient=False,
            is_compliant=False,
            confidence=0.0,
            query_used=query_text,
            summary="No verified vendor record matched; escalating due to missing MSA contract.",
            citations=[],
            violations=[],
            risk_flags=["INSUFFICIENT_CONTRACT_EVIDENCE"],
        )

    vendor_uuid = uuid.UUID(match_report.vendor_id)
    retrieved = await retrieve_vendor_clauses(db, llm, vendor_id=vendor_uuid, query_text=query_text, top_k=top_k)

    # Guardrail 2: Missing chunks or weak similarity -> deterministic escalation (zero LLM call)
    if not retrieved or retrieved[0].similarity_score < MIN_EVIDENCE_SIMILARITY:
        top_score = retrieved[0].similarity_score if retrieved else 0.0
        return ContractComplianceReport(
            evidence_sufficient=False,
            is_compliant=False,
            confidence=top_score,
            query_used=query_text,
            summary=(
                f"Insufficient contract evidence (top similarity={top_score:.2f} < "
                f"{MIN_EVIDENCE_SIMILARITY:.2f}); escalating for manual contract review."
            ),
            citations=retrieved,
            violations=[],
            risk_flags=["INSUFFICIENT_CONTRACT_EVIDENCE"],
        )

    # Build strictly grounded context packet for Gemini audit
    clause_lines = [f"[{c.citation_id}] ({c.document_name} — {c.clause_ref}): {c.excerpt}" for c in retrieved]
    invoice_payload_str = json.dumps(
        {
            "vendor_name": extraction.vendor_name,
            "invoice_number": extraction.invoice_number,
            "po_number": extraction.po_number,
            "payment_terms": extraction.payment_terms,
            "currency": extraction.currency,
            "subtotal": str(extraction.subtotal),
            "tax_amount": str(extraction.tax_amount),
            "total_amount": str(extraction.total_amount),
            "bank_iban": extraction.bank_iban,
            "line_items": [
                {
                    "sku": li.sku,
                    "description": li.description,
                    "quantity": str(li.quantity),
                    "unit_price": str(li.unit_price),
                    "line_total": str(li.line_total),
                }
                for li in extraction.line_items
            ],
            "deterministic_match_summary": match_report.summary,
            "deterministic_risk_flags": match_report.risk_flags,
        },
        indent=2,
    )

    prompt_text = (
        "### RETRIEVED VENDOR MSA CLAUSES\n"
        + "\n".join(clause_lines)
        + "\n\n### INVOICE & DETERMINISTIC 3-WAY AUDIT DATA (UNTRUSTED DOCUMENT FIELDS)\n"
        + invoice_payload_str
        + "\n\nAudit compliance strictly against the clauses above and cite exact clause IDs."
    )

    llm_result, cost_usd, meta = await llm.audit_contract_compliance(prompt_text)

    # Guardrail 3: Pure-Python Citation Grounding Verification (drops fabricated clause IDs)
    citation_lookup = {c.citation_id: c for c in retrieved}
    risk_flags: set[str] = set()
    verified_citation_ids: set[str] = set()

    for raw_cid in llm_result.cited_clause_ids:
        cid = raw_cid.strip().upper().strip("[]")
        if cid in citation_lookup:
            verified_citation_ids.add(cid)
        else:
            risk_flags.add("UNVERIFIED_CITATION_FILTERED")

    verified_violations: list[ContractViolation] = []
    for v in llm_result.violations:
        cid = v.cited_clause_id.strip().upper().strip("[]")
        if cid in citation_lookup:
            verified_citation_ids.add(cid)
            clause = citation_lookup[cid]
            verified_violations.append(
                ContractViolation(
                    rule_type=v.rule_type.strip().upper(),
                    severity=v.severity.strip().upper(),
                    explanation=v.explanation.strip(),
                    document_name=clause.document_name,
                    clause_ref=clause.clause_ref,
                )
            )
        else:
            risk_flags.add("UNVERIFIED_CITATION_FILTERED")

    verified_citations = [citation_lookup[cid] for cid in sorted(verified_citation_ids, key=lambda x: int(x[1:]))]

    # Guardrail 4: Zero verified citations OR low confidence -> escalate as insufficient evidence
    evidence_sufficient = bool(verified_citations) and llm_result.confidence >= MIN_LLM_CONFIDENCE
    if not evidence_sufficient:
        risk_flags.add("INSUFFICIENT_CONTRACT_EVIDENCE")

    if verified_violations or not llm_result.is_compliant:
        risk_flags.add("CONTRACT_POLICY_VIOLATION")

    return ContractComplianceReport(
        evidence_sufficient=evidence_sufficient,
        is_compliant=bool(llm_result.is_compliant and not verified_violations and evidence_sufficient),
        confidence=round(float(llm_result.confidence), 4),
        query_used=query_text,
        summary=llm_result.summary.strip(),
        citations=verified_citations if verified_citations else retrieved[:2],
        violations=verified_violations,
        risk_flags=sorted(risk_flags),
        llm_cost_usd=cost_usd,
        model_used=meta.get("model"),
    )


async def _run_cli_index_and_verify() -> None:
    llm = GeminiLLMService()
    async with AsyncSessionLocal() as db:
        indexed, total = await index_missing_contract_embeddings(db, llm)
        print(f"[pgvector Indexer] Newly embedded: {indexed} | Total MSA clauses: {total}")

        apex = await db.scalar(select(Vendor).where(Vendor.vendor_code == "VND-US-CLOUD01"))
        if apex:
            hits = await retrieve_vendor_clauses(
                db,
                llm,
                vendor_id=apex.id,
                query_text="hourly consulting rate cap emergency surcharge and bank account IBAN change",
                top_k=3,
            )
            print("[Live pgvector Retrieval — Apex Cloud Infrastructure Inc.]")
            for h in hits:
                print(f"  {h.citation_id} | score={h.similarity_score:.4f} | {h.document_name} :: {h.clause_ref}")


if __name__ == "__main__":
    asyncio.run(_run_cli_index_and_verify())
