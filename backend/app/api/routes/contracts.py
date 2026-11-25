from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import get_current_user, require_roles
from app.db.models import ActorType, User, UserRole, Vendor
from app.db.session import get_db
from app.schemas.rag import (
    ContractReindexResponse,
    ContractSearchRequest,
    ContractSearchResponse,
)
from app.services.audit import write_audit_log
from app.services.llm import GeminiLLMService
from app.services.rag import (
    MIN_EVIDENCE_SIMILARITY,
    index_missing_contract_embeddings,
    retrieve_vendor_clauses,
)

router = APIRouter(prefix="/api/v1/contracts", tags=["Contract RAG (pgvector)"])


@router.post("/reindex", response_model=ContractReindexResponse)
async def reindex_contract_embeddings(
    authorized_user: Annotated[User, Depends(require_roles(UserRole.CONTROLLER, UserRole.ADMIN))],
    db: Annotated[AsyncSession, Depends(get_db)],
    force: bool = False,
) -> ContractReindexResponse:
    settings = get_settings()
    llm = GeminiLLMService()
    indexed, total = await index_missing_contract_embeddings(db, llm, force_reindex=force)
    write_audit_log(
        db,
        actor_type=ActorType.HUMAN,
        actor_id=authorized_user.email,
        action="CONTRACT_EMBEDDINGS_REINDEXED",
        details={"indexed_count": indexed, "total_chunks": total, "force": force},
    )
    await db.commit()
    return ContractReindexResponse(
        indexed_count=indexed,
        total_chunks=total,
        embedding_model=settings.GEMINI_EMBEDDING_MODEL,
        dimensions=settings.EMBEDDING_DIMENSIONS,
    )


@router.post("/search", response_model=ContractSearchResponse)
async def search_vendor_contracts(
    body: ContractSearchRequest,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ContractSearchResponse:
    vendor = await db.scalar(select(Vendor).where(Vendor.vendor_code == body.vendor_code))
    if not vendor:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Vendor '{body.vendor_code}' not found.",
        )

    llm = GeminiLLMService()
    results = await retrieve_vendor_clauses(db, llm, vendor_id=vendor.id, query_text=body.query, top_k=body.top_k)
    evidence_sufficient = bool(results) and results[0].similarity_score >= MIN_EVIDENCE_SIMILARITY
    return ContractSearchResponse(
        vendor_code=vendor.vendor_code,
        query=body.query,
        evidence_sufficient=evidence_sufficient,
        results=results,
    )
