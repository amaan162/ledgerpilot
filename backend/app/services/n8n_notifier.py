import json
import time
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import compute_hmac_signature
from app.services.resilience import CircuitBreakerOpenError, n8n_circuit

logger = get_logger("ledgerpilot.n8n_notifier")


async def emit_n8n_event(event_path: str, payload: dict[str, Any]) -> bool:
    """
    Sends an HMAC-SHA256 signed event to an n8n edge webhook (e.g., Slack approval card
    or fraud alert) protected by the n8n circuit breaker.

    Edge failures are logged and isolated so an n8n outage never interrupts the core
    FastAPI/LangGraph Accounts Payable state machine.
    """
    settings = get_settings()
    base_url = settings.N8N_WEBHOOK_BASE_URL.strip().rstrip("/")
    if not base_url or settings.APP_ENV == "test":
        return False

    try:
        n8n_circuit.allow_request()
    except CircuitBreakerOpenError as exc:
        logger.warning(
            "n8n_event_skipped_circuit_open",
            extra={"extra_data": {"event_path": event_path, "reason": str(exc)}},
        )
        return False

    url = f"{base_url}/{event_path.lstrip('/')}"
    body_bytes = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, timestamp, body_bytes)

    headers = {
        "Content-Type": "application/json",
        "X-LedgerPilot-Timestamp": timestamp,
        "X-LedgerPilot-Signature": signature,
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, content=body_bytes, headers=headers)

        if resp.status_code < 300:
            n8n_circuit.record_success()
            logger.info(
                "n8n_event_delivered",
                extra={
                    "extra_data": {
                        "event_path": event_path,
                        "status_code": resp.status_code,
                    }
                },
            )
            return True

        n8n_circuit.record_failure()
        logger.warning(
            "n8n_event_non_2xx",
            extra={
                "extra_data": {
                    "event_path": event_path,
                    "status_code": resp.status_code,
                    "body": resp.text[:300],
                }
            },
        )
        return False
    except Exception as exc:
        n8n_circuit.record_failure()
        logger.warning(
            "n8n_event_failed",
            extra={"extra_data": {"event_path": event_path, "error": str(exc)}},
        )
        return False
