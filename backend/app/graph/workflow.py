import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.logging import get_logger
from app.db.models import (
    ActorType,
    ApprovalRequest,
    ApprovalStatus,
    Invoice,
    InvoiceStatus,
    UserRole,
    Vendor,
)
from app.db.session import AsyncSessionLocal
from app.graph.checkpointer import checkpointer_manager
from app.graph.state import InvoiceWorkflowState
from app.schemas.extraction import InvoiceExtraction, SecurityScanReport, ThreeWayMatchReport
from app.schemas.rag import ContractComplianceLLM, ContractComplianceReport
from app.services.audit import write_audit_log
from app.services.llm import GeminiLLMService
from app.services.matching import run_deterministic_three_way_match
from app.services.n8n_notifier import emit_n8n_event
from app.services.pdf_forensics import scan_document_bytes
from app.services.policy import evaluate_ap_policy
from app.services.rag import evaluate_contract_compliance
from app.services.settlement import generate_iso20022_pain001

logger = get_logger("ledgerpilot.workflow")

DUPLICATE_INVOICE_FLAG = "DUPLICATE_INVOICE_NUMBER_FRAUD_RISK"
TERMINAL_OR_PAUSED_STATUSES = {
    InvoiceStatus.PAYMENT_STAGED,
    InvoiceStatus.AUTO_APPROVED,
    InvoiceStatus.AWAITING_APPROVAL,
    InvoiceStatus.ESCALATED_SLA,
    InvoiceStatus.QUARANTINED_FRAUD_RISK,
    InvoiceStatus.REJECTED,
    InvoiceStatus.CANCELLED,
}


class WorkflowLLMProtocol(Protocol):
    async def extract_invoice(
        self, file_bytes: bytes, filename: str
    ) -> tuple[InvoiceExtraction, Decimal, dict[str, Any]]: ...

    async def embed_texts(self, texts: list[str]) -> list[list[float]]: ...

    async def audit_contract_compliance(
        self, prompt_text: str
    ) -> tuple[ContractComplianceLLM, Decimal, dict[str, Any]]: ...


def build_invoice_workflow(
    *,
    llm_service: WorkflowLLMProtocol | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
    checkpointer: Any | None = None,
):
    """Compiles the stateful, PostgreSQL-checkpointed LedgerPilot AP workflow graph."""
    db_factory = session_factory or AsyncSessionLocal
    saver = checkpointer or checkpointer_manager.get_saver()

    def _get_llm() -> WorkflowLLMProtocol:
        return llm_service or GeminiLLMService()

    async def scan_security_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        stored_path = Path(state["stored_file_path"])
        if not stored_path.is_file():
            raise FileNotFoundError(f"Stored invoice file not found: {stored_path}")
        file_bytes = stored_path.read_bytes()
        report = scan_document_bytes(file_bytes, state["filename"])
        report_dict = report.model_dump(mode="json")

        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.SCANNING_SECURITY
                inv.security_report = report_dict
                inv.risk_flags = sorted(set(inv.risk_flags) | set(report.risk_flags))
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.SYSTEM,
                    actor_id="pdf_forensics_scanner",
                    action="SECURITY_SCAN_COMPLETED",
                    previous_state=prev,
                    new_state=InvoiceStatus.SCANNING_SECURITY.value,
                    details={
                        "is_suspicious": report.is_suspicious,
                        "risk_score": report.risk_score,
                        "risk_flags": report.risk_flags,
                    },
                )
                await db.commit()

        return {
            "status": InvoiceStatus.SCANNING_SECURITY.value,
            "security_report": report_dict,
            "risk_flags": report.risk_flags,
        }

    async def extract_invoice_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        stored_path = Path(state["stored_file_path"])
        if not stored_path.is_file():
            raise FileNotFoundError(f"Stored invoice file not found: {stored_path}")
        file_bytes = stored_path.read_bytes()

        extraction, cost_usd, meta = await _get_llm().extract_invoice(file_bytes, state["filename"])
        extraction_dict = extraction.model_dump(mode="json")
        total_cost = Decimal(state.get("llm_cost_usd", "0.000000")) + cost_usd

        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.EXTRACTING
                inv.invoice_number = extraction.invoice_number
                inv.po_number = extraction.po_number
                inv.currency = extraction.currency
                inv.subtotal_amount = extraction.subtotal
                inv.tax_amount = extraction.tax_amount
                inv.total_amount = extraction.total_amount
                inv.extracted_iban = extraction.bank_iban
                inv.extracted_payload = {
                    **(inv.extracted_payload or {}),
                    "extraction": extraction_dict,
                    "llm_extraction_meta": meta,
                }
                inv.llm_cost_usd = total_cost
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.AGENT,
                    actor_id=f"extractor:{meta.get('model', 'gemini-4-hydrogen')}",
                    action="INVOICE_EXTRACTED",
                    previous_state=prev,
                    new_state=InvoiceStatus.EXTRACTING.value,
                    details={
                        "invoice_number": extraction.invoice_number,
                        "po_number": extraction.po_number,
                        "total": f"{extraction.currency} {extraction.total_amount}",
                        "cost_usd": str(cost_usd),
                    },
                )
                await db.commit()

        return {
            "status": InvoiceStatus.EXTRACTING.value,
            "extraction": extraction_dict,
            "llm_cost_usd": str(total_cost),
        }

    async def match_three_way_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        extraction = InvoiceExtraction.model_validate(state["extraction"])

        async with db_factory() as db:
            match_report = await run_deterministic_three_way_match(db, extraction)
            match_dict = match_report.model_dump(mode="json")

            # Cross-file duplicate-payment shield: detects an altered PDF reusing an active
            # (vendor_id, invoice_number) without tripping uq_invoices_vendor_number_active.
            duplicate_inv: Invoice | None = None
            if match_report.vendor_id and extraction.invoice_number:
                vendor_uuid = uuid.UUID(match_report.vendor_id)
                duplicate_inv = await db.scalar(
                    select(Invoice).where(
                        Invoice.id != inv_uuid,
                        Invoice.vendor_id == vendor_uuid,
                        Invoice.invoice_number == extraction.invoice_number,
                        Invoice.status.not_in([InvoiceStatus.REJECTED, InvoiceStatus.CANCELLED]),
                    )
                )

            if duplicate_inv is not None:
                flags = sorted(set(match_dict.get("risk_flags") or []) | {DUPLICATE_INVOICE_FLAG})
                match_dict["risk_flags"] = flags
                match_dict["is_clean_match"] = False
                variances = list(match_dict.get("line_variances") or [])
                variances.append(
                    {
                        "sku": None,
                        "description": f"Invoice {extraction.invoice_number}",
                        "issue": DUPLICATE_INVOICE_FLAG,
                        "expected_value": "Unique active invoice number per vendor",
                        "actual_value": (
                            f"Duplicates active record {str(duplicate_inv.id)[:8]} "
                            f"({duplicate_inv.status.value})"
                        ),
                    }
                )
                match_dict["line_variances"] = variances
                match_dict["summary"] = (
                    f"Duplicate invoice number '{extraction.invoice_number}' blocked: "
                    f"already active on record {str(duplicate_inv.id)[:8]} ({duplicate_inv.status.value})."
                )

            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.MATCHING_DETERMINISTIC
                # Only bind vendor_id if no active duplicate exists (keeps DB unique constraint intact)
                if match_report.vendor_id and duplicate_inv is None:
                    inv.vendor_id = uuid.UUID(match_report.vendor_id)
                inv.match_report = match_dict
                inv.risk_flags = sorted(set(inv.risk_flags) | set(match_dict.get("risk_flags") or []))
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.SYSTEM,
                    actor_id="deterministic_3way_engine",
                    action="THREE_WAY_MATCH_COMPLETED",
                    previous_state=prev,
                    new_state=InvoiceStatus.MATCHING_DETERMINISTIC.value,
                    details={
                        "is_clean_match": match_dict.get("is_clean_match"),
                        "iban_verified": match_report.iban_verified,
                        "duplicate_of_invoice_id": str(duplicate_inv.id) if duplicate_inv else None,
                        "risk_flags": match_dict.get("risk_flags", []),
                    },
                )
                try:
                    await db.commit()
                except IntegrityError:
                    # Race-condition fallback if two identical invoice numbers committed concurrently
                    await db.rollback()
                    inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
                    if inv:
                        match_dict["is_clean_match"] = False
                        match_dict["risk_flags"] = sorted(
                            set(match_dict.get("risk_flags") or []) | {DUPLICATE_INVOICE_FLAG}
                        )
                        match_dict["summary"] = (
                            f"Concurrent duplicate invoice number '{extraction.invoice_number}' "
                            "blocked by PostgreSQL unique-payment shield."
                        )
                        inv.vendor_id = None
                        inv.status = InvoiceStatus.MATCHING_DETERMINISTIC
                        inv.match_report = match_dict
                        inv.risk_flags = sorted(set(inv.risk_flags) | set(match_dict["risk_flags"]))
                        write_audit_log(
                            db,
                            invoice_id=inv.id,
                            actor_type=ActorType.SYSTEM,
                            actor_id="deterministic_3way_engine",
                            action="DUPLICATE_INVOICE_RACE_BLOCKED",
                            previous_state=prev,
                            new_state=InvoiceStatus.MATCHING_DETERMINISTIC.value,
                            details={"risk_flags": match_dict["risk_flags"]},
                        )
                        await db.commit()

        return {
            "status": InvoiceStatus.MATCHING_DETERMINISTIC.value,
            "match_report": match_dict,
            "risk_flags": sorted(set(state.get("risk_flags", [])) | set(match_dict.get("risk_flags") or [])),
        }

    async def check_contract_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        extraction = InvoiceExtraction.model_validate(state["extraction"])
        match_report = ThreeWayMatchReport.model_validate(state["match_report"])

        async with db_factory() as db:
            contract_report = await evaluate_contract_compliance(
                db, _get_llm(), extraction=extraction, match_report=match_report
            )
            contract_dict = contract_report.model_dump(mode="json")
            total_cost = Decimal(state.get("llm_cost_usd", "0.000000")) + contract_report.llm_cost_usd

            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.CHECKING_CONTRACT
                inv.rag_citations = contract_dict.get("citations", [])
                inv.risk_flags = sorted(set(inv.risk_flags) | set(contract_report.risk_flags))
                inv.llm_cost_usd = total_cost
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.AGENT,
                    actor_id=f"contract_rag:{contract_report.model_used or 'deterministic_gate'}",
                    action="CONTRACT_COMPLIANCE_CHECKED",
                    previous_state=prev,
                    new_state=InvoiceStatus.CHECKING_CONTRACT.value,
                    details={
                        "evidence_sufficient": contract_report.evidence_sufficient,
                        "is_compliant": contract_report.is_compliant,
                        "citations_count": len(contract_report.citations),
                        "risk_flags": contract_report.risk_flags,
                    },
                )
                await db.commit()

        return {
            "status": InvoiceStatus.CHECKING_CONTRACT.value,
            "contract_report": contract_dict,
            "llm_cost_usd": str(total_cost),
            "risk_flags": sorted(set(state.get("risk_flags", [])) | set(contract_report.risk_flags)),
        }

    async def evaluate_policy_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        security_report = SecurityScanReport.model_validate(state["security_report"])
        extraction = InvoiceExtraction.model_validate(state["extraction"])
        match_report = ThreeWayMatchReport.model_validate(state["match_report"])
        contract_report = ContractComplianceReport.model_validate(state["contract_report"])

        decision = evaluate_ap_policy(
            security_report=security_report,
            extraction=extraction,
            match_report=match_report,
            contract_report=contract_report,
        )

        combined_flags = sorted(set(decision.combined_risk_flags) | set(state.get("risk_flags", [])))
        if DUPLICATE_INVOICE_FLAG in combined_flags:
            return {
                "policy_outcome": "QUARANTINE",
                "required_role": None,
                "sla_hours": None,
                "policy_reason": (
                    "Duplicate active invoice number detected for this vendor; "
                    "quarantined to prevent cross-file double payment."
                ),
                "risk_flags": combined_flags,
            }

        return {
            "policy_outcome": decision.outcome,
            "required_role": decision.required_role.value if decision.required_role else None,
            "sla_hours": decision.sla_hours,
            "policy_reason": decision.reason_summary,
            "risk_flags": combined_flags,
        }

    def route_after_policy(state: InvoiceWorkflowState) -> str:
        outcome = state["policy_outcome"]
        if outcome == "QUARANTINE":
            return "quarantine_invoice"
        if outcome == "AUTO_APPROVE":
            return "auto_approve_invoice"
        return "human_approval_gate"

    async def quarantine_invoice_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.QUARANTINED_FRAUD_RISK
                inv.risk_flags = state.get("risk_flags", inv.risk_flags)
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.SYSTEM,
                    actor_id="policy_security_gate",
                    action="INVOICE_QUARANTINED_FRAUD_RISK",
                    previous_state=prev,
                    new_state=InvoiceStatus.QUARANTINED_FRAUD_RISK.value,
                    details={
                        "reason": state.get("policy_reason"),
                        "risk_flags": state.get("risk_flags", []),
                    },
                )
                await db.commit()

        await emit_n8n_event(
            "ledgerpilot-fraud-alert",
            {
                "invoice_id": state["invoice_id"],
                "filename": state["filename"],
                "reason": state.get("policy_reason"),
                "risk_flags": state.get("risk_flags", []),
            },
        )
        return {"status": InvoiceStatus.QUARANTINED_FRAUD_RISK.value}

    async def auto_approve_invoice_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.AUTO_APPROVED
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.SYSTEM,
                    actor_id="policy_engine",
                    action="INVOICE_AUTO_APPROVED",
                    previous_state=prev,
                    new_state=InvoiceStatus.AUTO_APPROVED.value,
                    details={"reason": state.get("policy_reason")},
                )
                await db.commit()
        return {"status": InvoiceStatus.AUTO_APPROVED.value}

    async def human_approval_gate_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        """
        Idempotent Human-in-the-Loop pause node.
        Creates a PENDING ApprovalRequest once, then suspends execution via LangGraph interrupt().
        When resumed via Command(resume=...), returns the verified human decision.
        """
        inv_uuid = uuid.UUID(state["invoice_id"])
        required_role = UserRole(state.get("required_role") or UserRole.FINANCE_MANAGER.value)
        sla_hours = int(state.get("sla_hours") or 24)
        notify_payload: dict[str, Any] | None = None

        async with db_factory() as db:
            existing_req = await db.scalar(
                select(ApprovalRequest)
                .where(ApprovalRequest.invoice_id == inv_uuid)
                .order_by(ApprovalRequest.created_at.desc())
            )
            if existing_req:
                approval_id = str(existing_req.id)
            else:
                inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
                req = ApprovalRequest(
                    invoice_id=inv_uuid,
                    required_role=required_role,
                    status=ApprovalStatus.PENDING,
                    reason_summary=state.get("policy_reason") or "Manual AP review required.",
                    sla_due_at=datetime.now(UTC) + timedelta(hours=sla_hours),
                )
                db.add(req)
                await db.flush()
                approval_id = str(req.id)
                if inv:
                    prev = inv.status.value
                    inv.status = InvoiceStatus.AWAITING_APPROVAL
                    write_audit_log(
                        db,
                        invoice_id=inv.id,
                        actor_type=ActorType.SYSTEM,
                        actor_id="hitl_gate",
                        action="APPROVAL_REQUESTED",
                        previous_state=prev,
                        new_state=InvoiceStatus.AWAITING_APPROVAL.value,
                        details={
                            "approval_request_id": approval_id,
                            "required_role": required_role.value,
                            "reason": req.reason_summary,
                            "sla_due_at": req.sla_due_at.isoformat(),
                        },
                    )
                await db.commit()
                notify_payload = {
                    "approval_id": approval_id,
                    "invoice_id": state["invoice_id"],
                    "invoice_number": inv.invoice_number if inv else None,
                    "currency": inv.currency if inv else None,
                    "total_amount": str(inv.total_amount) if inv and inv.total_amount else None,
                    "required_role": required_role.value,
                    "reason": req.reason_summary,
                    "risk_flags": state.get("risk_flags", []),
                    "sla_due_at": req.sla_due_at.isoformat(),
                }

        if notify_payload:
            await emit_n8n_event("ledgerpilot-approval-needed", notify_payload)

        human_decision = interrupt(
            {
                "invoice_id": state["invoice_id"],
                "approval_request_id": approval_id,
                "required_role": required_role.value,
                "reason": state.get("policy_reason"),
                "risk_flags": state.get("risk_flags", []),
            }
        )

        return {
            "approval_request_id": approval_id,
            "human_decision": human_decision,
        }

    def route_after_human_decision(state: InvoiceWorkflowState) -> str:
        decision = state.get("human_decision") or {}
        if str(decision.get("decision", "")).upper() == "APPROVED":
            return "stage_settlement"
        return "reject_invoice"

    async def reject_invoice_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        decision = state.get("human_decision") or {}
        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if inv:
                prev = inv.status.value
                inv.status = InvoiceStatus.REJECTED
                write_audit_log(
                    db,
                    invoice_id=inv.id,
                    actor_type=ActorType.HUMAN,
                    actor_id=str(decision.get("actor_email", "approver")),
                    action="INVOICE_REJECTED",
                    previous_state=prev,
                    new_state=InvoiceStatus.REJECTED.value,
                    details={"reason": decision.get("reason", "Rejected during AP review.")},
                )
                await db.commit()
        return {"status": InvoiceStatus.REJECTED.value}

    async def stage_settlement_node(state: InvoiceWorkflowState) -> dict[str, Any]:
        inv_uuid = uuid.UUID(state["invoice_id"])
        async with db_factory() as db:
            inv = await db.scalar(select(Invoice).where(Invoice.id == inv_uuid))
            if not inv or not inv.vendor_id:
                raise RuntimeError("Cannot stage ISO 20022 settlement: missing invoice or verified vendor.")
            vendor = await db.scalar(select(Vendor).where(Vendor.id == inv.vendor_id))
            if not vendor:
                raise RuntimeError("Cannot stage ISO 20022 settlement: vendor record not found.")

            artifact = generate_iso20022_pain001(inv, vendor)
            prev = inv.status.value
            inv.status = InvoiceStatus.PAYMENT_STAGED
            inv.settlement_reference = artifact.settlement_reference
            inv.settlement_xml_path = artifact.xml_path

            write_audit_log(
                db,
                invoice_id=inv.id,
                actor_type=ActorType.SYSTEM,
                actor_id="iso20022_settlement_engine",
                action="ISO20022_PAYMENT_STAGED",
                previous_state=prev,
                new_state=InvoiceStatus.PAYMENT_STAGED.value,
                details={
                    "settlement_reference": artifact.settlement_reference,
                    "xml_sha256": artifact.xml_sha256,
                    "creditor_iban": vendor.verified_iban,
                    "amount": f"{inv.currency} {inv.total_amount}",
                },
            )
            await db.commit()

        return {
            "status": InvoiceStatus.PAYMENT_STAGED.value,
            "settlement_reference": artifact.settlement_reference,
            "settlement_xml_path": artifact.xml_path,
        }

    builder = StateGraph(InvoiceWorkflowState)
    builder.add_node("scan_security", scan_security_node)
    builder.add_node("extract_invoice", extract_invoice_node)
    builder.add_node("match_three_way", match_three_way_node)
    builder.add_node("check_contract", check_contract_node)
    builder.add_node("evaluate_policy", evaluate_policy_node)
    builder.add_node("quarantine_invoice", quarantine_invoice_node)
    builder.add_node("auto_approve_invoice", auto_approve_invoice_node)
    builder.add_node("human_approval_gate", human_approval_gate_node)
    builder.add_node("reject_invoice", reject_invoice_node)
    builder.add_node("stage_settlement", stage_settlement_node)

    builder.add_edge(START, "scan_security")
    builder.add_edge("scan_security", "extract_invoice")
    builder.add_edge("extract_invoice", "match_three_way")
    builder.add_edge("match_three_way", "check_contract")
    builder.add_edge("check_contract", "evaluate_policy")

    builder.add_conditional_edges(
        "evaluate_policy",
        route_after_policy,
        {
            "quarantine_invoice": "quarantine_invoice",
            "auto_approve_invoice": "auto_approve_invoice",
            "human_approval_gate": "human_approval_gate",
        },
    )
    builder.add_edge("quarantine_invoice", END)
    builder.add_edge("auto_approve_invoice", "stage_settlement")
    builder.add_conditional_edges(
        "human_approval_gate",
        route_after_human_decision,
        {
            "stage_settlement": "stage_settlement",
            "reject_invoice": "reject_invoice",
        },
    )
    builder.add_edge("reject_invoice", END)
    builder.add_edge("stage_settlement", END)

    return builder.compile(checkpointer=saver)


async def run_invoice_workflow(
    invoice_id: uuid.UUID,
    *,
    llm_service: WorkflowLLMProtocol | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> dict[str, Any]:
    """Starts the LangGraph AP pipeline for an ingested invoice and records processing latency."""
    db_factory = session_factory or AsyncSessionLocal
    async with db_factory() as db:
        inv = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
        if not inv or inv.status == InvoiceStatus.CANCELLED:
            raise ValueError(f"Invoice {invoice_id} not found.")
        stored_path = (inv.extracted_payload or {}).get("stored_file_path")
        if not stored_path:
            raise ValueError(f"Invoice {invoice_id} has no stored file path.")
        initial_state: InvoiceWorkflowState = {
            "invoice_id": str(inv.id),
            "filename": inv.original_filename,
            "stored_file_path": stored_path,
            "status": inv.status.value,
            "llm_cost_usd": str(inv.llm_cost_usd),
        }
        thread_id = inv.thread_id

    graph = build_invoice_workflow(llm_service=llm_service, session_factory=db_factory)
    config = {"configurable": {"thread_id": thread_id}}

    start_ts = time.perf_counter()
    try:
        result = await graph.ainvoke(initial_state, config=config)
    except Exception as exc:
        # Transition cleanly to FAILED so the invoice never remains stranded in an intermediate state
        try:
            async with db_factory() as db:
                inv = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
                if inv and inv.status not in TERMINAL_OR_PAUSED_STATUSES:
                    prev = inv.status.value
                    inv.status = InvoiceStatus.FAILED
                    write_audit_log(
                        db,
                        invoice_id=inv.id,
                        actor_type=ActorType.SYSTEM,
                        actor_id="workflow_supervisor",
                        action="WORKFLOW_EXECUTION_FAILED",
                        previous_state=prev,
                        new_state=InvoiceStatus.FAILED.value,
                        details={"error_type": type(exc).__name__},
                    )
                    await db.commit()
        except Exception:
            logger.exception("workflow_failure_state_persist_failed")
        raise

    elapsed_ms = int((time.perf_counter() - start_ts) * 1000)

    async with db_factory() as db:
        inv = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
        if inv:
            inv.processing_ms = elapsed_ms
            await db.commit()

    return result


async def resume_invoice_workflow(
    invoice_id: uuid.UUID,
    *,
    decision: str,
    actor_email: str,
    reason: str,
    llm_service: WorkflowLLMProtocol | None = None,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> dict[str, Any]:
    """Resumes a paused LangGraph checkpoint with a verified human approval or rejection."""
    db_factory = session_factory or AsyncSessionLocal
    async with db_factory() as db:
        inv = await db.scalar(select(Invoice).where(Invoice.id == invoice_id))
        if not inv or inv.status == InvoiceStatus.CANCELLED:
            raise ValueError(f"Invoice {invoice_id} not found.")
        if inv.status not in (InvoiceStatus.AWAITING_APPROVAL, InvoiceStatus.ESCALATED_SLA):
            raise ValueError(
                f"Invoice {invoice_id} is in '{inv.status.value}' state and cannot be resumed."
            )
        thread_id = inv.thread_id

    graph = build_invoice_workflow(llm_service=llm_service, session_factory=db_factory)
    config = {"configurable": {"thread_id": thread_id}}

    resume_payload = {
        "decision": decision.upper(),
        "actor_email": actor_email,
        "reason": reason,
    }
    return await graph.ainvoke(Command(resume=resume_payload), config=config)