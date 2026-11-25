from decimal import Decimal

from pydantic import BaseModel, Field


class ContractCitation(BaseModel):
    citation_id: str  # e.g., "C1"
    chunk_id: str
    document_name: str
    clause_ref: str
    excerpt: str
    similarity_score: float = Field(ge=0.0, le=1.0)


class ContractViolationLLM(BaseModel):
    rule_type: str = Field(
        ...,
        description=(
            "Short code like RATE_CAP_EXCEEDED, PAYMENT_TERMS_VIOLATION, "
            "VAT_NONCOMPLIANCE, or BANK_CHANGE_PROTOCOL"
        ),
    )
    severity: str = Field(..., description="LOW, MEDIUM, HIGH, or CRITICAL")
    explanation: str = Field(..., description="Concise factual explanation referencing the clause")
    cited_clause_id: str = Field(..., description="Exact clause tag such as C1 or C2")


class ContractComplianceLLM(BaseModel):
    is_compliant: bool = Field(
        ..., description="True ONLY if the invoice satisfies all retrieved governing contract clauses"
    )
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score from 0.0 to 1.0")
    summary: str = Field(..., description="Brief executive summary of contract compliance findings")
    violations: list[ContractViolationLLM] = Field(default_factory=list)
    cited_clause_ids: list[str] = Field(
        default_factory=list,
        description="List of exact retrieved clause IDs (e.g., ['C1', 'C2']) that support this assessment",
    )


class ContractViolation(BaseModel):
    rule_type: str
    severity: str
    explanation: str
    document_name: str
    clause_ref: str


class ContractComplianceReport(BaseModel):
    evidence_sufficient: bool
    is_compliant: bool
    confidence: float = Field(ge=0.0, le=1.0)
    query_used: str
    summary: str
    citations: list[ContractCitation] = Field(default_factory=list)
    violations: list[ContractViolation] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    llm_cost_usd: Decimal = Decimal("0.000000")
    model_used: str | None = None


class ContractSearchRequest(BaseModel):
    vendor_code: str = Field(..., min_length=1, max_length=50)
    query: str = Field(..., min_length=2, max_length=1000)
    top_k: int = Field(default=5, ge=1, le=10)


class ContractSearchResponse(BaseModel):
    vendor_code: str
    query: str
    evidence_sufficient: bool
    results: list[ContractCitation]


class ContractReindexResponse(BaseModel):
    indexed_count: int
    total_chunks: int
    embedding_model: str
    dimensions: int
