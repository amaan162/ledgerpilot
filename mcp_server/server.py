"""
LedgerPilot Scoped MCP Server.

Security Architecture:
- Never connects directly to PostgreSQL or holds database credentials.
- Delegates every operation to FastAPI over HTTP using an explicit role-scoped API key.
- State-changing tools (place_fraud_hold) enforce explicit human consent (confirm_hold=True)
  AND backend RBAC enforcement (FINANCE_MANAGER / CONTROLLER / ADMIN).
"""

import json
import os
from typing import Any

import httpx
from mcp.server.mcpserver import MCPServer

API_BASE_URL = os.getenv("LEDGERPILOT_API_URL", "http://127.0.0.1:8000").rstrip("/")
API_KEY = os.getenv("LEDGERPILOT_API_KEY", "lp_manager_dev_key_003")

mcp = MCPServer("LedgerPilot-FinOps")


class LedgerPilotMCPClient:
    """Thin HTTP client wrapper (supports ASGI transport injection in automated tests)."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or API_BASE_URL).rstrip("/")
        self.api_key = api_key or API_KEY
        self.transport = transport

    async def request(
        self, method: str, path: str, *, json_body: dict[str, Any] | None = None
    ) -> dict[str, Any] | list[Any]:
        headers = {"X-API-Key": self.api_key}
        async with httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            transport=self.transport,
            timeout=15.0,
        ) as client:
            resp = await client.request(method, path, json=json_body)
            if resp.status_code >= 400:
                return {
                    "error": True,
                    "status_code": resp.status_code,
                    "detail": resp.text,
                }
            return resp.json()


_default_client = LedgerPilotMCPClient()


def set_mcp_client(client: LedgerPilotMCPClient) -> None:
    """Allows integration tests to bind the MCP tools directly to FastAPI's ASGI app."""
    global _default_client
    _default_client = client


@mcp.tool()
async def get_ap_metrics() -> str:
    """Returns real-time Accounts Payable KPIs, fraud blocks, latency, and LLM operating costs."""
    data = await _default_client.request("GET", "/api/v1/metrics/overview")
    return json.dumps(data, indent=2)


@mcp.tool()
async def list_pending_approvals() -> str:
    """Lists all pending or SLA-escalated Human-in-the-Loop approval requests."""
    data = await _default_client.request("GET", "/api/v1/approvals?only_pending=true")
    return json.dumps(data, indent=2)


@mcp.tool()
async def get_invoice_audit(invoice_id: str) -> str:
    """
    Retrieves the complete audit dossier for an invoice: PDF forensics report,
    deterministic 3-way match variances, verified MSA contract citations, and immutable audit logs.
    """
    data = await _default_client.request("GET", f"/api/v1/invoices/{invoice_id}")
    return json.dumps(data, indent=2)


@mcp.tool()
async def search_vendor_contract(vendor_code: str, query: str, top_k: int = 3) -> str:
    """
    Runs vendor-isolated pgvector semantic search over a vendor's Master Services Agreement (MSA)
    and returns exact governing clause citations.
    """
    safe_k = max(1, min(top_k, 5))
    data = await _default_client.request(
        "POST",
        "/api/v1/contracts/search",
        json_body={"vendor_code": vendor_code, "query": query, "top_k": safe_k},
    )
    return json.dumps(data, indent=2)


@mcp.tool()
async def place_fraud_hold(invoice_id: str, reason: str, confirm_hold: bool = False) -> str:
    """
    Places a hard QUARANTINED_FRAUD_RISK hold on a suspicious invoice.
    Requires explicit human confirmation (confirm_hold=True) and FINANCE_MANAGER+ backend RBAC.
    """
    if not confirm_hold:
        return json.dumps(
            {
                "action_required": "EXPLICIT_USER_CONFIRMATION",
                "message": (
                    f"Dry-run preview: ready to quarantine invoice '{invoice_id}' for reason: "
                    f"'{reason}'. Ask the user to confirm and re-invoke with confirm_hold=True."
                ),
            },
            indent=2,
        )

    data = await _default_client.request(
        "POST",
        f"/api/v1/invoices/{invoice_id}/fraud-hold",
        json_body={"reason": reason, "actor_channel": "MCP"},
    )
    return json.dumps(data, indent=2)


if __name__ == "__main__":
    mcp.run()
