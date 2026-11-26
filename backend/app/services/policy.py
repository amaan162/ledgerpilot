from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from app.db.models import UserRole
from app.schemas.extraction import InvoiceExtraction, SecurityScanReport, ThreeWayMatchReport
from app.schemas.rag import ContractComplianceReport

# Hard fraud, exploit & sanctions signals that ALWAYS trigger mandatory quarantine
HARD_QUARANTINE_FLAGS = {
    "PROMPT_INJECTION_DETECTED",
    "HIDDEN_WHITE_TEXT_DETECTED",
    "MICRO_FONT_TEXT_DETECTED",
    "OFF_PAGE_TEXT_DETECTED",
    "METADATA_INJECTION_DETECTED",
    "OBFUSCATED_TEXT_DETECTED",
    "PDF_ACTIVE_CONTENT_EXPLOIT",
    "IBAN_MISMATCH_FRAUD_RISK",
    "SANCTIONS_JURISDICTION_BLOCK",
    "VENDOR_FROZEN",
}

# OFAC / EU comprehensive sanctions & high-risk wire jurisdiction IBAN country prefixes
SANCTIONED_IBAN_PREFIXES = {"IR", "KP", "SY", "CU", "RU", "BY"}

# Elevated governance flags requiring Corporate Controller sign-off
CONTROLLER_ESCALATION_FLAGS = {
    "UNKNOWN_VENDOR",
    "PO_VENDOR_MISMATCH",
    "CONTRACT_POLICY_VIOLATION",
    "INSUFFICIENT_CONTRACT_EVIDENCE",
}

# Deterministic treasury FX reference table for USD-equivalent spend threshold enforcement
FX_TO_USD: dict[str, Decimal] = {
    "USD": Decimal("1.00"),
    "EUR": Decimal("1.09"),
    "GBP": Decimal("1.27"),
    "AED": Decimal("0.2723"),
    "CHF": Decimal("1.13"),
    "CAD": Decimal("0.72"),
    "AUD": Decimal("0.65"),
    "SGD": Decimal("0.74"),
    "INR": Decimal("0.012"),
    "JPY": Decimal("0.0067"),
}

AUTO_APPROVE_LIMIT = Decimal("1000.00")
FINANCE_MANAGER_LIMIT = Decimal("10000.00")


@dataclass(frozen=True)
class PolicyDecision:
    outcome: str  # QUARANTINE | REQUIRE_APPROVAL | AUTO_APPROVE
    required_role: UserRole | None
    sla_hours: int
    reason_summary: str
    combined_risk_flags: list[str] = field(default_factory=list)


def _to_usd_equivalent(amount: Decimal, currency: str | None) -> tuple[Decimal, str]:
    code = (currency or "USD").strip().upper()
    rate = FX_TO_USD.get(code, Decimal("1.00"))
    usd_val = (amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return usd_val, code


def _format_amount_with_fx(amount: Decimal, currency_code: str, usd_equiv: Decimal) -> str:
    if currency_code == "USD":
        return f"USD {amount:.2f}"
    return f"{currency_code} {amount:.2f} (~USD {usd_equiv:.2f})"


def evaluate_ap_policy(
    *,
    security_report: SecurityScanReport,
    extraction: InvoiceExtraction,
    match_report: ThreeWayMatchReport,
    contract_report: ContractComplianceReport,
) -> PolicyDecision:
    """
    100% deterministic backend policy engine.
    Enforces hard wire-fraud quarantine, OFAC sanctions blocks, FX-normalized USD spend limits,
    Non-PO governance routing, and SOX 404 RBAC authority gates.
    """
    flag_set = set(security_report.risk_flags) | set(match_report.risk_flags) | set(contract_report.risk_flags)

    # Deterministic OFAC / Sanctions IBAN jurisdiction check
    if extraction.bank_iban:
        norm_iban = "".join(ch for ch in extraction.bank_iban.upper() if ch.isalnum())
        if len(norm_iban) >= 2 and norm_iban[:2] in SANCTIONED_IBAN_PREFIXES:
            flag_set.add("SANCTIONS_JURISDICTION_BLOCK")

    combined_flags = sorted(flag_set)
    usd_equiv, currency_code = _to_usd_equivalent(extraction.total_amount, extraction.currency)
    amt_label = _format_amount_with_fx(extraction.total_amount, currency_code, usd_equiv)

    # Tier 1: Hard Fraud, Sanctions, or Active-Exploit Quarantine (zero bypass permitted)
    quarantine_hits = [f for f in combined_flags if f in HARD_QUARANTINE_FLAGS]
    if quarantine_hits or security_report.prompt_injection_detected:
        return PolicyDecision(
            outcome="QUARANTINE",
            required_role=UserRole.CONTROLLER,
            sla_hours=4,
            reason_summary=(
                "Hard security quarantine triggered by deterministic defense gate: "
                f"{', '.join(quarantine_hits or ['PROMPT_INJECTION_DETECTED'])}."
            ),
            combined_risk_flags=combined_flags,
        )

    # Tier 2: High-Value (>= USD 10,000 FX-equivalent) or Governance/Contract Violations -> Controller
    controller_hits = [f for f in combined_flags if f in CONTROLLER_ESCALATION_FLAGS]
    if usd_equiv >= FINANCE_MANAGER_LIMIT or controller_hits:
        reasons: list[str] = []
        if usd_equiv >= FINANCE_MANAGER_LIMIT:
            reasons.append(f"{amt_label} >= Controller threshold (USD {FINANCE_MANAGER_LIMIT:.2f})")
        if "UNKNOWN_VENDOR" in controller_hits and "MISSING_PO" in flag_set:
            reasons.append("unregistered vendor / Non-PO spend requires vendor onboarding")
            remaining_hits = [f for f in controller_hits if f != "UNKNOWN_VENDOR"]
            if remaining_hits:
                reasons.append(f"governance flags: {', '.join(remaining_hits)}")
        elif controller_hits:
            reasons.append(f"governance flags: {', '.join(controller_hits)}")
        return PolicyDecision(
            outcome="REQUIRE_APPROVAL",
            required_role=UserRole.CONTROLLER,
            sla_hours=24,
            reason_summary="Controller approval required: " + "; ".join(reasons) + ".",
            combined_risk_flags=combined_flags,
        )

    # Tier 3: Mid-Value (>= USD 1,000 FX-equivalent) or Any 3-Way Match Variance -> Finance Manager
    if (
        usd_equiv >= AUTO_APPROVE_LIMIT
        or not match_report.is_clean_match
        or not contract_report.is_compliant
        or bool(combined_flags)
    ):
        reasons = []
        if usd_equiv >= AUTO_APPROVE_LIMIT:
            reasons.append(f"{amt_label} >= auto-approve cap (USD {AUTO_APPROVE_LIMIT:.2f})")
        if combined_flags:
            reasons.append(f"audit exceptions: {', '.join(combined_flags)}")
        if not reasons:
            reasons.append("manual verification required by AP policy")
        return PolicyDecision(
            outcome="REQUIRE_APPROVAL",
            required_role=UserRole.FINANCE_MANAGER,
            sla_hours=24,
            reason_summary="Finance Manager approval required: " + "; ".join(reasons) + ".",
            combined_risk_flags=combined_flags,
        )

    # Tier 4: Clean 3-Way Match + Verified IBAN + Contract Compliant + < USD 1,000 -> Auto-Approve
    return PolicyDecision(
        outcome="AUTO_APPROVE",
        required_role=None,
        sla_hours=0,
        reason_summary=(
            f"Auto-approved cleanly: 3-way match verified, master IBAN matched, MSA compliant, "
            f"and {amt_label} < USD {AUTO_APPROVE_LIMIT:.2f}."
        ),
        combined_risk_flags=[],
    )