from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.common import HealthResponse, UserMeResponse

router = APIRouter(tags=["System & Auth"])


@router.get("/health", response_model=HealthResponse)
async def health_check(db: Annotated[AsyncSession, Depends(get_db)]) -> HealthResponse:
    settings = get_settings()
    try:
        await db.execute(text("SELECT 1"))
        ext = await db.scalar(text("SELECT extname FROM pg_extension WHERE extname = 'vector'"))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database health check failed: {exc}",
        ) from exc

    return HealthResponse(
        status="ok",
        app=settings.APP_NAME,
        database="connected",
        pgvector_enabled=ext == "vector",
    )


@router.get("/api/v1/auth/me", response_model=UserMeResponse)
async def get_authenticated_user(
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserMeResponse:
    return UserMeResponse.model_validate(current_user)
