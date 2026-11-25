from typing import Any, TypedDict


class InvoiceWorkflowState(TypedDict, total=False):
    invoice_id: str
    filename: str
    stored_file_path: str
    status: str

    # Serialized JSON dicts (strictly msgpack-safe for LangGraph PostgreSQL checkpoints)
    security_report: dict[str, Any]
    extraction: dict[str, Any]
    match_report: dict[str, Any]
    contract_report: dict[str, Any]

    # Policy & HITL routing
    policy_outcome: str  # QUARANTINE | REQUIRE_APPROVAL | AUTO_APPROVE
    required_role: str | None
    sla_hours: int
    policy_reason: str
    risk_flags: list[str]

    approval_request_id: str | None
    human_decision: dict[str, Any] | None

    # Settlement & Telemetry
    settlement_reference: str | None
    settlement_xml_path: str | None
    llm_cost_usd: str
    error_message: str | None
