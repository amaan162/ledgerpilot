import hashlib
import hmac
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import User, UserRole
from app.db.session import get_db

WEBHOOK_MAX_AGE_SECONDS = 300  # 5-minute replay-attack window
MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024  # 2 MB hard cap on inbound webhooks
MAX_API_KEY_LENGTH = 256
_REPLAY_CACHE_MAX_ENTRIES = 10_000


class _WebhookReplayCache:
    """Thread-safe, memory-bounded TTL cache blocking intra-window webhook replays."""

    def __init__(self, ttl_seconds: int = WEBHOOK_MAX_AGE_SECONDS, max_entries: int = _REPLAY_CACHE_MAX_ENTRIES):
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def register_if_new(self, digest: str, now: float | None = None) -> bool:
        ts = now if now is not None else time.monotonic()
        cutoff = ts - self._ttl
        with self._lock:
            while self._seen:
                oldest_key, oldest_ts = next(iter(self._seen.items()))
                if oldest_ts < cutoff:
                    self._seen.pop(oldest_key, None)
                else:
                    break

            if digest in self._seen:
                return False

            while len(self._seen) >= self._max_entries:
                self._seen.popitem(last=False)

            self._seen[digest] = ts
            return True

    def clear(self) -> None:
        with self._lock:
            self._seen.clear()


webhook_replay_cache = _WebhookReplayCache()


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
    cleaned_key = (x_api_key or "").strip()
    if not cleaned_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-API-Key header.",
        )
    if len(cleaned_key) > MAX_API_KEY_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key.",
        )

    key_hash = hash_api_key(cleaned_key)
    user = await db.scalar(select(User).where(User.api_key_hash == key_hash))
    if not user or not hmac.compare_digest(user.api_key_hash, key_hash):
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
    """
    Verifies HMAC-SHA256 signature, payload size bounds, timestamp freshness,
    and intra-window replay protection on inbound n8n webhooks.
    """
    if not x_signature or not x_timestamp:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing webhook signature or timestamp headers.",
        )

    try:
        ts_int = int(x_timestamp.strip())
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

    settings = get_settings()
    if not (settings.WEBHOOK_HMAC_SECRET or "").strip():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook signing secret is not configured.",
        )

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_WEBHOOK_BODY_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Webhook payload exceeds the 2 MB security limit.",
                )
        except ValueError:
            pass

    raw_body = await request.body()
    if len(raw_body) > MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Webhook payload exceeds the 2 MB security limit.",
        )

    cleaned_sig = x_signature.strip()
    cleaned_ts = x_timestamp.strip()
    expected = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, cleaned_ts, raw_body)

    if not hmac.compare_digest(expected, cleaned_sig):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid webhook HMAC signature.",
        )

    # Register only AFTER signature verification so unauthenticated traffic cannot pollute cache
    replay_digest = hashlib.sha256(f"{cleaned_ts}:{cleaned_sig}".encode("utf-8")).hexdigest()
    if not webhook_replay_cache.register_if_new(replay_digest):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Duplicate webhook replay detected within signature window.",
        )

    return raw_body