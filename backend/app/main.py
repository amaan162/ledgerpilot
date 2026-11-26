import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes.approvals import router as approvals_router
from app.api.routes.contracts import router as contracts_router
from app.api.routes.demo import router as demo_router
from app.api.routes.health import router as health_router
from app.api.routes.invoices import router as invoices_router
from app.api.routes.security_ops import router as security_ops_router
from app.api.routes.webhooks import router as webhooks_router
from app.core.config import get_settings
from app.core.hardening import (
    api_rate_limiter,
    build_rate_limit_response,
    extract_client_bucket_key,
    get_security_headers,
)
from app.core.logging import configure_logging, correlation_id_ctx, get_logger
from app.graph.checkpointer import checkpointer_manager

settings = get_settings()
configure_logging(settings.LOG_LEVEL)
logger = get_logger("ledgerpilot.api")

EXPENSIVE_PATH_PREFIXES = (
    "/api/v1/demo/run",
    "/api/v1/contracts/search",
    "/api/v1/invoices/ingest",
    "/api/v1/webhooks",
)
EXPENSIVE_PATH_SUFFIXES = ("/process", "/retry", "/decide")

_CORR_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_SENSITIVE_URL_RE = re.compile(r"(postgres(?:ql)?(?:\+\w+)?://)[^\s'\"]+", re.IGNORECASE)


def _is_expensive_path(path: str) -> bool:
    normalized = path.rstrip("/")
    return normalized.startswith(EXPENSIVE_PATH_PREFIXES) or normalized.endswith(EXPENSIVE_PATH_SUFFIXES)


def _sanitize_correlation_id(raw: str | None) -> str:
    candidate = (raw or "").strip()
    if candidate and _CORR_ID_RE.match(candidate):
        return candidate
    return str(uuid.uuid4())


def _safe_error_detail(exc: Exception) -> str:
    if settings.APP_ENV.lower() == "production":
        return "Internal server error. Reference correlation_id for diagnostics."
    redacted = _SENSITIVE_URL_RE.sub(r"\1[REDACTED]", str(exc))
    return f"Backend error ({type(exc).__name__}): {redacted}"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    checkpointer_manager.close()


app = FastAPI(
    title="LedgerPilot API",
    description=(
        "Autonomous Accounts Payable, Contract Compliance & Wire-Fraud Defense Engine "
        "with ISO 20022 (pain.001) settlement staging."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def security_rate_limit_and_telemetry_middleware(request: Request, call_next):
    corr_id = _sanitize_correlation_id(request.headers.get("X-Correlation-ID"))
    token = correlation_id_ctx.set(corr_id)
    start = time.perf_counter()

    # Never rate-limit CORS preflight requests
    force_rl = request.headers.get("X-Force-Rate-Limit") == "true"
    remaining_hdr: str | None = None
    is_expensive = _is_expensive_path(request.url.path)
    limit_val = 60 if is_expensive else 180

    if (
        request.method != "OPTIONS"
        and request.url.path.startswith("/api/")
        and (settings.APP_ENV != "test" or force_rl)
    ):
        bucket_key = extract_client_bucket_key(request)
        if is_expensive:
            bucket_key = f"{bucket_key}:expensive"
        allowed, remaining, retry_after = api_rate_limiter.check(bucket_key, limit_override=limit_val)
        if not allowed:
            correlation_id_ctx.reset(token)
            resp = build_rate_limit_response(retry_after, limit_val)
            resp.headers["X-Correlation-ID"] = corr_id
            return resp
        remaining_hdr = str(remaining)

    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception as exc:
        logger.exception(
            "unhandled_http_exception",
            extra={
                "extra_data": {
                    "method": request.method,
                    "path": request.url.path,
                    "error_type": type(exc).__name__,
                    "error": _SENSITIVE_URL_RE.sub(r"\1[REDACTED]", str(exc)),
                }
            },
        )
        response = JSONResponse(
            status_code=500,
            content={
                "detail": _safe_error_detail(exc),
                "correlation_id": corr_id,
            },
        )
    finally:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.info(
            "http_request",
            extra={
                "extra_data": {
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": status_code,
                    "duration_ms": elapsed_ms,
                }
            },
        )
        correlation_id_ctx.reset(token)

    # Apply enterprise security headers to every HTTP response (scoped CSP for /docs & /redoc)
    normalized_path = request.url.path.rstrip("/") or "/"
    for hdr, val in get_security_headers(normalized_path).items():
        response.headers.setdefault(hdr, val)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    if remaining_hdr is not None:
        response.headers["X-RateLimit-Limit"] = str(limit_val)
        response.headers["X-RateLimit-Remaining"] = remaining_hdr

    response.headers["X-Correlation-ID"] = corr_id
    return response


# Registered LAST so CORSMiddleware is the OUTERMOST wrapper:
# guarantees Access-Control-Allow-Origin on OPTIONS preflights, 429s, and 500 JSON errors.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-API-Key",
        "X-Correlation-ID",
        "X-Force-Rate-Limit",
        "X-LedgerPilot-Signature",
        "X-LedgerPilot-Timestamp",
    ],
    expose_headers=[
        "Retry-After",
        "X-Correlation-ID",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
    ],
)


@app.get("/", tags=["System"])
async def root_status() -> dict[str, str]:
    return {
        "service": "LedgerPilot",
        "status": "operational",
        "docs": "/docs",
        "health": "/health",
    }


app.include_router(health_router)
app.include_router(invoices_router)
app.include_router(webhooks_router)
app.include_router(contracts_router)
app.include_router(approvals_router)
app.include_router(demo_router)
app.include_router(security_ops_router)