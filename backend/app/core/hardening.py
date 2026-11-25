import math
import threading
import time
from collections import deque

from fastapi import Request
from fastapi.responses import JSONResponse

SECURITY_HEADERS: dict[str, str] = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}

DOCS_PATHS: frozenset[str] = frozenset({"/docs", "/redoc", "/docs/oauth2-redirect"})

DOCS_SECURITY_HEADERS: dict[str, str] = {
    **SECURITY_HEADERS,
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "img-src 'self' data: https://fastapi.tiangolo.com https://cdn.jsdelivr.net; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "worker-src 'self' blob:; "
        "frame-ancestors 'none'"
    ),
}


def get_security_headers(path: str) -> dict[str, str]:
    """Return strict API security headers everywhere except FastAPI docs routes."""
    if path in DOCS_PATHS:
        return DOCS_SECURITY_HEADERS
    return SECURITY_HEADERS


class SlidingWindowRateLimiter:
    """
    In-memory sliding-window rate limiter protecting API & expensive LLM endpoints
    against burst abuse and cloud-bill DoS attacks.
    """

    def __init__(self, *, max_requests: int = 120, window_seconds: float = 60.0) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    def check(self, key: str, *, limit_override: int | None = None) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_seconds)."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        limit = limit_override or self.max_requests

        with self._lock:
            bucket = self._buckets.setdefault(key, deque())
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= limit:
                retry_after = max(1, int(math.ceil(self.window_seconds - (now - bucket[0]))))
                return False, 0, retry_after

            bucket.append(now)
            remaining = max(0, limit - len(bucket))
            return True, remaining, 0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()

    def active_keys_count(self) -> int:
        with self._lock:
            return len(self._buckets)


api_rate_limiter = SlidingWindowRateLimiter(max_requests=180, window_seconds=60.0)


def build_rate_limit_response(retry_after: int, limit: int) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": f"Rate limit exceeded ({limit} requests/min). Retry after {retry_after}s."},
        headers={
            "Retry-After": str(retry_after),
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": "0",
            **SECURITY_HEADERS,
        },
    )


def extract_client_bucket_key(request: Request) -> str:
    api_key = request.headers.get("X-API-Key", "")
    key_prefix = api_key[:12] if api_key else "anon"
    forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    ip = forwarded or (request.client.host if request.client else "unknown")
    return f"{ip}:{key_prefix}"
