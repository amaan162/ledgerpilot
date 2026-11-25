import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.approvals import router as approvals_router
from app.api.routes.contracts import router as contracts_router
from app.api.routes.demo import router as demo_router
from app.api.routes.health import router as health_router
from app.api.routes.invoices import router as invoices_router
from app.api.routes.security_ops import router as security_ops_router
from app.api.routes.webhooks import router as webhooks_router
from app.core.config import get_settings
from app.core.hardening import (
    SECURITY_HEADERS,
    api_rate_limiter,
    build_rate_limit_response,
    extract_client_bucket_key,
)
from app.core.logging import configure_logging, correlation_id_ctx, get_logger
from app.graph.checkpointer import checkpointer_manager

settings = get_settings()
configure_logging(settings.LOG_LEVEL)
logger = get_logger("ledgerpilot.api")

EXPENSIVE_PATH_PREFIXES = ("/api/v1/demo/run", "/api/v1/contracts/search", "/api/v1/invoices/ingest")


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_rate_limit_and_telemetry_middleware(request: Request, call_next):
    corr_id = request.headers.get("X-Correlation-ID", str(uuid.uuid4()))
    token = correlation_id_ctx.set(corr_id)
    start = time.perf_counter()

    # Enforce sliding-window rate limiting outside test runs (or when explicitly forced in tests)
    force_rl = request.headers.get("X-Force-Rate-Limit") == "true"
    remaining_hdr: str | None = None
    limit_val = 60 if request.url.path.startswith(EXPENSIVE_PATH_PREFIXES) else 180

    if request.url.path.startswith("/api/") and (settings.APP_ENV != "test" or force_rl):
        bucket_key = extract_client_bucket_key(request)
        if request.url.path.startswith(EXPENSIVE_PATH_PREFIXES):
            bucket_key = f"{bucket_key}:expensive"
        allowed, remaining, retry_after = api_rate_limiter.check(bucket_key, limit_override=limit_val)
        if not allowed:
            correlation_id_ctx.reset(token)
            return build_rate_limit_response(retry_after, limit_val)
        remaining_hdr = str(remaining)

    try:
        response = await call_next(request)
    finally:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.info(
            "http_request",
            extra={
                "extra_data": {
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": elapsed_ms,
                }
            },
        )
        correlation_id_ctx.reset(token)

    # Apply MNC security headers to every HTTP response
    for hdr, val in SECURITY_HEADERS.items():
        response.headers.setdefault(hdr, val)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    if remaining_hdr is not None:
        response.headers["X-RateLimit-Limit"] = str(limit_val)
        response.headers["X-RateLimit-Remaining"] = remaining_hdr

    response.headers["X-Correlation-ID"] = corr_id
    return response


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
