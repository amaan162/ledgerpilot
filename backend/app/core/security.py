import hashlib
import hmac
import time
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import User, UserRole
from app.db.session import get_db

WEBHOOK_MAX_AGE_SECONDS = 300  # 5-minute replay-attack window


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def compute_hmac_signature(secret: str, timestamp: str, raw_body: bytes) -> str:
    """Computes sha256=<hex> HMAC over '<timestamp>.<raw_body>'."""
    signed_payload = f"{timestamp}.".encode() + raw_body
    digest = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> User:
    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-API-Key header.",
        )

    key_hash = hash_api_key(x_api_key.strip())
    user = await db.scalar(select(User).where(User.api_key_hash == key_hash))
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive.",
        )
    return user


def require_roles(*allowed_roles: UserRole) -> Callable[..., User]:
    """Backend-enforced RBAC guard (never delegated to LLM prompts)."""

    async def _role_checker(
        current_user: Annotated[User, Depends(get_current_user)],
    ) -> User:
        if current_user.role not in allowed_roles:
            allowed_names = ", ".join(r.value for r in allowed_roles)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Insufficient permissions: role '{current_user.role.value}' "
                    f"is not authorized. Required: {allowed_names}."
                ),
            )
        return current_user

    return _role_checker


async def verify_n8n_webhook_signature(
    request: Request,
    x_signature: Annotated[str | None, Header(alias="X-LedgerPilot-Signature")] = None,
    x_timestamp: Annotated[str | None, Header(alias="X-LedgerPilot-Timestamp")] = None,
) -> bytes:
    """Verifies HMAC-SHA256 signature and timestamp freshness on inbound n8n webhooks."""
    if not x_signature or not x_timestamp:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing webhook signature or timestamp headers.",
        )

    try:
        ts_int = int(x_timestamp)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid X-LedgerPilot-Timestamp header.",
        ) from exc

    now = int(time.time())
    if abs(now - ts_int) > WEBHOOK_MAX_AGE_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Webhook timestamp expired (replay protection triggered).",
        )

    raw_body = await request.body()
    settings = get_settings()
    expected = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, x_timestamp, raw_body)

    if not hmac.compare_digest(expected, x_signature.strip()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook HMAC signature.",
        )

    return raw_body
