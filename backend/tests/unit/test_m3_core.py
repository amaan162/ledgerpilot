import base64
import json
import time
import uuid

import pytest
from httpx import AsyncClient

from app.core.config import get_settings
from app.core.security import compute_hmac_signature

settings = get_settings()


def _unique_pdf_bytes() -> bytes:
    return f"%PDF-1.4\n% LedgerPilot Test Doc {uuid.uuid4()}\n%%EOF\n".encode()


@pytest.mark.asyncio
async def test_health_and_pgvector(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["database"] == "connected"
    assert body["pgvector_enabled"] is True
    assert "X-Correlation-ID" in resp.headers


@pytest.mark.asyncio
async def test_auth_and_rbac_enforcement(client: AsyncClient) -> None:
    # Missing & invalid keys -> 401
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers={"X-API-Key": "wrong_key"})).status_code == 401

    # Valid AP Clerk key -> 200 on /me, but 403 on Controller/Admin-only /dead-letters
    clerk_headers = {"X-API-Key": settings.CLERK_API_KEY}
    me_resp = await client.get("/api/v1/auth/me", headers=clerk_headers)
    assert me_resp.status_code == 200
    assert me_resp.json()["role"] == "AP_CLERK"

    dlq_forbidden = await client.get("/api/v1/dead-letters", headers=clerk_headers)
    assert dlq_forbidden.status_code == 403

    # Controller key -> 200 on /dead-letters
    controller_headers = {"X-API-Key": settings.CONTROLLER_API_KEY}
    dlq_allowed = await client.get("/api/v1/dead-letters", headers=controller_headers)
    assert dlq_allowed.status_code == 200


@pytest.mark.asyncio
async def test_invoice_ingest_idempotency_and_audit_trail(client: AsyncClient) -> None:
    headers = {
        "X-API-Key": settings.CLERK_API_KEY,
        "Idempotency-Key": f"idem-{uuid.uuid4().hex}",
    }
    pdf_bytes = _unique_pdf_bytes()

    # First upload -> 201 Created
    resp1 = await client.post(
        "/api/v1/invoices/ingest",
        headers=headers,
        files={"file": ("apex_invoice.pdf", pdf_bytes, "application/pdf")},
    )
    assert resp1.status_code == 201
    body1 = resp1.json()
    assert body1["duplicate"] is False
    invoice_id = body1["invoice"]["id"]

    # Second upload with identical file -> 200 OK, duplicate=True, SAME invoice ID
    resp2 = await client.post(
        "/api/v1/invoices/ingest",
        headers={"X-API-Key": settings.CLERK_API_KEY, "Idempotency-Key": f"diff-{uuid.uuid4()}"},
        files={"file": ("apex_invoice_resent.pdf", pdf_bytes, "application/pdf")},
    )
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["duplicate"] is True
    assert body2["invoice"]["id"] == invoice_id

    # Verify immutable audit trail recorded both receipt and ignored replay
    detail = await client.get(
        f"/api/v1/invoices/{invoice_id}",
        headers={"X-API-Key": settings.CLERK_API_KEY},
    )
    assert detail.status_code == 200
    actions = [log["action"] for log in detail.json()["audit_logs"]]
    assert "INVOICE_RECEIVED" in actions
    assert "IDEMPOTENT_REPLAY_IGNORED" in actions


@pytest.mark.asyncio
async def test_n8n_hmac_security_and_dead_letter_queue(client: AsyncClient) -> None:
    payload_bytes = json.dumps(
        {
            "filename": "vendor_email_inv.pdf",
            "content_base64": base64.b64encode(_unique_pdf_bytes()).decode("ascii"),
            "idempotency_key": f"n8n-{uuid.uuid4().hex}",
            "sender_email": "billing@apexcloud.example",
            "subject": "Invoice #2026-88",
        }
    ).encode("utf-8")

    # 1. Missing signature -> 401
    assert (await client.post("/api/v1/webhooks/n8n/intake", content=payload_bytes)).status_code == 401

    # 2. Expired timestamp (> 5 mins ago) -> 401 replay protection
    old_ts = str(int(time.time()) - 600)
    old_sig = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, old_ts, payload_bytes)
    resp_expired = await client.post(
        "/api/v1/webhooks/n8n/intake",
        content=payload_bytes,
        headers={"X-LedgerPilot-Timestamp": old_ts, "X-LedgerPilot-Signature": old_sig},
    )
    assert resp_expired.status_code == 401

    # 3. Valid fresh HMAC signature -> 201 Created
    fresh_ts = str(int(time.time()))
    fresh_sig = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, fresh_ts, payload_bytes)
    resp_ok = await client.post(
        "/api/v1/webhooks/n8n/intake",
        content=payload_bytes,
        headers={"X-LedgerPilot-Timestamp": fresh_ts, "X-LedgerPilot-Signature": fresh_sig},
    )
    assert resp_ok.status_code == 201
    assert resp_ok.json()["duplicate"] is False

    # 4. Valid HMAC signature but corrupt base64 -> 422 + captured in Dead-Letter Queue
    bad_payload = json.dumps({"filename": "corrupt.pdf", "content_base64": "!!!NOT-VALID-BASE64!!!"}).encode(
        "utf-8"
    )
    bad_sig = compute_hmac_signature(settings.WEBHOOK_HMAC_SECRET, fresh_ts, bad_payload)
    resp_dlq = await client.post(
        "/api/v1/webhooks/n8n/intake",
        content=bad_payload,
        headers={"X-LedgerPilot-Timestamp": fresh_ts, "X-LedgerPilot-Signature": bad_sig},
    )
    assert resp_dlq.status_code == 422
    dlq_id = resp_dlq.json()["detail"]["dead_letter_id"]

    # Confirm Admin can inspect the captured dead-letter job
    dlq_list = await client.get("/api/v1/dead-letters", headers={"X-API-Key": settings.ADMIN_API_KEY})
    assert dlq_list.status_code == 200
    assert any(job["id"] == dlq_id for job in dlq_list.json())
