import re
from difflib import SequenceMatcher
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GoodsReceipt, PurchaseOrder, Vendor, VendorStatus
from app.schemas.extraction import (
    InvoiceExtraction,
    LineItemVariance,
    ThreeWayMatchReport,
)
from app.services.pdf_forensics import scan_text_for_prompt_injection

MONEY_TOLERANCE = Decimal("0.01")

_LEGAL_SUFFIXES = {
    "inc",
    "incorporated",
    "ltd",
    "limited",
    "llc",
    "llp",
    "gmbh",
    "corp",
    "corporation",
    "co",
    "company",
    "plc",
    "ag",
    "sa",
    "fzco",
    "fze",
}

_STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "per",
    "from",
    "into",
    "monthly",
    "quarterly",
    "annual",
    "fee",
    "fees",
    "service",
    "services",
    "unit",
    "units",
    "qty",
    "hours",
    "hour",
    "rev",
    "tier",
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
    "2025",
    "2026",
    "2027",
}

_CURRENCY_ALIASES = {
    "$": "USD",
    "US$": "USD",
    "USD": "USD",
    "€": "EUR",
    "EUR": "EUR",
    "£": "GBP",
    "GBP": "GBP",
    "AED": "AED",
    "DHS": "AED",
    "INR": "INR",
    "₹": "INR",
    "CHF": "CHF",
    "CAD": "CAD",
    "AUD": "AUD",
    "SGD": "SGD",
    "JPY": "JPY",
    "¥": "JPY",
}


def _q2(val: Decimal) -> Decimal:
    return val.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _alnum_upper(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value.upper() if ch.isalnum())


def _normalize_iban(iban: str | None) -> str:
    return _alnum_upper(iban)


def _normalize_currency(currency: str | None) -> str:
    if not currency:
        return "USD"
    cleaned = currency.strip().upper()
    return _CURRENCY_ALIASES.get(cleaned, cleaned)


def _normalize_po_number(po_number: str | None) -> str:
    if not po_number:
        return ""
    cleaned = re.sub(r"^(P\.?\s*O\.?|PURCHASE\s*ORDER)\s*[#:\-\s]*", "", po_number.strip(), flags=re.IGNORECASE)
    return _alnum_upper(cleaned)


def _normalize_company_name(name: str | None) -> str:
    if not name:
        return ""
    tokens = re.findall(r"[a-z0-9]+", name.lower())
    filtered = [t for t in tokens if t not in _LEGAL_SUFFIXES]
    return " ".join(filtered or tokens)


def _semantic_tokens(text: str | None) -> set[str]:
    if not text:
        return set()
    raw = re.findall(r"[a-z0-9]+", text.lower())
    tokens: set[str] = set()
    for tok in raw:
        if len(tok) < 2 or tok in _STOPWORDS:
            continue
        # Light singularization so "pallets" matches "pallet", "gateways" matches "gateway"
        if len(tok) > 4 and tok.endswith("s") and not tok.endswith("ss"):
            tok = tok[:-1]
        tokens.add(tok)
    return tokens


def _description_similarity(a: str, b: str) -> tuple[float, int]:
    tok_a = _semantic_tokens(a)
    tok_b = _semantic_tokens(b)
    shared = len(tok_a & tok_b)
    union = len(tok_a | tok_b)
    jaccard = (shared / union) if union else 0.0
    seq = SequenceMatcher(None, a.strip().lower(), b.strip().lower()).ratio()
    return (0.65 * jaccard + 0.35 * seq), shared


async def _resolve_vendor(db: AsyncSession, extraction: InvoiceExtraction) -> Vendor | None:
    all_vendors = list((await db.scalars(select(Vendor))).all())

    # 1. Exact or normalized vendor code
    if extraction.vendor_code:
        v = await db.scalar(select(Vendor).where(Vendor.vendor_code == extraction.vendor_code))
        if v:
            return v
        norm_code = _alnum_upper(extraction.vendor_code)
        for cand in all_vendors:
            if _alnum_upper(cand.vendor_code) == norm_code:
                return cand

    # 2. Exact or normalized Tax ID (allows omitted country prefix like "84-2910442")
    if extraction.vendor_tax_id:
        v = await db.scalar(select(Vendor).where(Vendor.tax_id == extraction.vendor_tax_id))
        if v:
            return v
        norm_tax = _alnum_upper(extraction.vendor_tax_id)
        if len(norm_tax) >= 7:
            for cand in all_vendors:
                cand_tax = _alnum_upper(cand.tax_id)
                if cand_tax and (norm_tax == cand_tax or norm_tax in cand_tax or cand_tax in norm_tax):
                    return cand

    # 3. Case-insensitive exact legal name match
    if extraction.vendor_name:
        v = await db.scalar(
            select(Vendor).where(func.lower(Vendor.legal_name) == extraction.vendor_name.strip().lower())
        )
        if v:
            return v

        # 4. Normalized corporate name (ignores Inc/LLC/Ltd/GmbH + punctuation) & fuzzy similarity
        target_norm = _normalize_company_name(extraction.vendor_name)
        best_vendor: Vendor | None = None
        best_score = 0.0

        for cand in all_vendors:
            cand_norm = _normalize_company_name(cand.legal_name)
            if not cand_norm or not target_norm:
                continue
            if cand_norm == target_norm or cand_norm in target_norm or target_norm in cand_norm:
                return cand
            score, shared = _description_similarity(target_norm, cand_norm)
            if shared >= 1 and score >= 0.78 and score > best_score:
                best_score = score
                best_vendor = cand

        if best_vendor:
            return best_vendor

    return None


async def _resolve_po(db: AsyncSession, po_number: str | None) -> tuple[PurchaseOrder | None, bool]:
    """Resolves PO strictly by exact number first, then via normalized format (PO-2026-1001 == PO 2026 1001)."""
    if not po_number or not po_number.strip():
        return None, False

    raw = po_number.strip()
    exact = await db.scalar(select(PurchaseOrder).where(PurchaseOrder.po_number == raw))
    if exact:
        return exact, False

    norm_target = _normalize_po_number(raw)
    if not norm_target:
        return None, False

    all_pos = (await db.scalars(select(PurchaseOrder))).all()
    for candidate in all_pos:
        if _normalize_po_number(candidate.po_number) == norm_target:
            return candidate, True

    return None, False


def _match_po_line(
    inv_item,
    po_lines: list[dict],
    po_by_sku: dict[str, dict],
    po_by_desc: dict[str, dict],
    single_line_invoice: bool,
) -> tuple[dict | None, str]:
    """
    Neuro-symbolic line matcher:
    1) Normalized SKU match -> 2) Exact description -> 3) Token/semantic description alignment.
    Financial pricing and quantity checks remain 100% strict Decimal downstream.
    """
    if inv_item.sku:
        norm_sku = _alnum_upper(inv_item.sku)
        if norm_sku in po_by_sku:
            return po_by_sku[norm_sku], "sku"

    desc_key = inv_item.description.strip().lower()
    if desc_key in po_by_desc:
        return po_by_desc[desc_key], "exact_desc"

    best_line: dict | None = None
    best_score = 0.0
    best_shared = 0
    for po_line in po_lines:
        po_desc = str(po_line.get("description", ""))
        score, shared = _description_similarity(inv_item.description, po_desc)
        if score > best_score:
            best_score = score
            best_shared = shared
            best_line = po_line

    if best_line is not None and best_shared >= 1 and best_score >= 0.45:
        return best_line, "semantic"

    # Controlled single-line fallback: requires BOTH shared domain token AND exact unit-price match
    if len(po_lines) == 1 and single_line_invoice and best_line is not None and best_shared >= 1:
        po_price = _q2(Decimal(str(best_line["unit_price"])))
        if abs(inv_item.unit_price - po_price) <= MONEY_TOLERANCE:
            return best_line, "semantic_price"

    return None, "none"


async def run_deterministic_three_way_match(
    db: AsyncSession, extraction: InvoiceExtraction
) -> ThreeWayMatchReport:
    """
    Neuro-symbolic AP verification:
    Resilient normalization & semantic line pairing paired with 100% strict Pure-Python Decimal math,
    aggregate split-line GR auditing, and locked master IBAN wire-fraud defense.
    """
    risk_flags: set[str] = set()
    variances: list[LineItemVariance] = []
    smart_notes: list[str] = []

    inv_currency = _normalize_currency(extraction.currency)

    # 1. Cross-check extracted text fields for image-based or OCR prompt injections
    text_to_check = f"{extraction.notes or ''} {extraction.suspicious_text_found or ''}".strip()
    if extraction.suspicious_text_found or scan_text_for_prompt_injection(text_to_check):
        risk_flags.add("PROMPT_INJECTION_DETECTED")

    # 2. Pure Decimal Arithmetic Audit (ZERO LLM math)
    arithmetic_valid = True
    computed_subtotal = Decimal("0.00")

    for item in extraction.line_items:
        expected_line = _q2(item.quantity * item.unit_price)
        computed_subtotal += expected_line
        if abs(expected_line - item.line_total) > MONEY_TOLERANCE:
            arithmetic_valid = False
            risk_flags.add("ARITHMETIC_ERROR")
            variances.append(
                LineItemVariance(
                    sku=item.sku,
                    description=item.description,
                    issue="LINE_TOTAL_MATH_MISMATCH",
                    expected_value=str(expected_line),
                    actual_value=str(item.line_total),
                )
            )

    computed_subtotal = _q2(computed_subtotal)
    if extraction.line_items and abs(computed_subtotal - extraction.subtotal) > MONEY_TOLERANCE:
        arithmetic_valid = False
        risk_flags.add("ARITHMETIC_ERROR")
        variances.append(
            LineItemVariance(
                sku=None,
                description="Invoice Subtotal",
                issue="SUBTOTAL_SUM_MISMATCH",
                expected_value=str(computed_subtotal),
                actual_value=str(extraction.subtotal),
            )
        )

    computed_total = _q2(extraction.subtotal + extraction.tax_amount)
    if abs(computed_total - extraction.total_amount) > MONEY_TOLERANCE:
        arithmetic_valid = False
        risk_flags.add("ARITHMETIC_ERROR")
        variances.append(
            LineItemVariance(
                sku=None,
                description="Invoice Grand Total",
                issue="GRAND_TOTAL_MATH_MISMATCH",
                expected_value=str(computed_total),
                actual_value=str(extraction.total_amount),
            )
        )

    # 3. Vendor Master Verification & IBAN Wire-Fraud Shield
    vendor = await _resolve_vendor(db, extraction)
    vendor_matched = vendor is not None
    iban_verified = False

    if not vendor:
        risk_flags.add("UNKNOWN_VENDOR")
    else:
        if vendor.status == VendorStatus.FROZEN:
            risk_flags.add("VENDOR_FROZEN")

        inv_iban = _normalize_iban(extraction.bank_iban)
        verified_iban = _normalize_iban(vendor.verified_iban)
        if not inv_iban:
            risk_flags.add("MISSING_IBAN")
        elif inv_iban != verified_iban:
            # CRITICAL WIRE-FRAUD SIGNAL — deterministic hard quarantine downstream
            risk_flags.add("IBAN_MISMATCH_FRAUD_RISK")
            variances.append(
                LineItemVariance(
                    sku=None,
                    description="Settlement IBAN",
                    issue="UNAUTHORIZED_BANK_CHANGE",
                    expected_value=vendor.verified_iban,
                    actual_value=extraction.bank_iban or "NONE",
                )
            )
        else:
            iban_verified = True

    # 4. Purchase Order Lookup & 3-Way Line-Item / Price / Aggregate GR Verification
    po, po_was_normalized = await _resolve_po(db, extraction.po_number)
    po_matched = False
    goods_receipt_matched = False
    currency_valid = True
    po_total: Decimal | None = None
    total_variance: Decimal | None = None
    is_partial_shipment = False
    semantic_pairs = 0

    if not po:
        risk_flags.add("MISSING_PO")
    else:
        po_matched = True
        if po_was_normalized:
            smart_notes.append(f"normalized PO reference '{extraction.po_number}' -> {po.po_number}")

        po_total = _q2(Decimal(po.total_amount))
        total_variance = _q2(extraction.subtotal - po_total)
        po_currency = _normalize_currency(po.currency)

        if vendor and po.vendor_id != vendor.id:
            risk_flags.add("PO_VENDOR_MISMATCH")

        if inv_currency != po_currency:
            currency_valid = False
            risk_flags.add("CURRENCY_MISMATCH")

        if extraction.subtotal > po_total + MONEY_TOLERANCE:
            risk_flags.add("PO_TOTAL_EXCEEDED")

        # Index PO line items by normalized SKU and normalized description
        po_by_sku: dict[str, dict] = {}
        po_by_desc: dict[str, dict] = {}
        po_meta_by_sku: dict[str, dict] = {}
        for po_line in po.line_items:
            raw_sku = str(po_line.get("sku", "")).strip()
            if raw_sku:
                norm_sku = _alnum_upper(raw_sku)
                po_by_sku[norm_sku] = po_line
                po_meta_by_sku[norm_sku] = po_line
            if po_line.get("description"):
                po_by_desc[str(po_line["description"]).strip().lower()] = po_line

        # 5. Goods Receipt 3-Way Quantity Aggregation
        receipts = (await db.scalars(select(GoodsReceipt).where(GoodsReceipt.po_id == po.id))).all()
        received_by_sku: dict[str, Decimal] = {}
        for gr in receipts:
            for rec in gr.received_items:
                sku_key = _alnum_upper(str(rec.get("sku", "")))
                if sku_key:
                    received_by_sku[sku_key] = received_by_sku.get(sku_key, Decimal("0")) + Decimal(
                        str(rec.get("quantity_received", 0))
                    )

        if not receipts:
            risk_flags.add("MISSING_GOODS_RECEIPT")
        else:
            goods_receipt_matched = True

        # Aggregate billed quantities per PO SKU to defeat split-line overbilling attacks
        billed_qty_by_sku: dict[str, Decimal] = {}
        billed_desc_by_sku: dict[str, str] = {}

        for inv_item in extraction.line_items:
            matched_po_line, match_mode = _match_po_line(
                inv_item,
                po.line_items,
                po_by_sku,
                po_by_desc,
                single_line_invoice=(len(extraction.line_items) == 1),
            )

            if not matched_po_line:
                risk_flags.add("UNAPPROVED_LINE_ITEM")
                variances.append(
                    LineItemVariance(
                        sku=inv_item.sku,
                        description=inv_item.description,
                        issue="ITEM_NOT_ON_PO",
                        expected_value="Not authorized on PO",
                        actual_value=f"qty={inv_item.quantity} @ {inv_item.unit_price}",
                    )
                )
                continue

            if match_mode in ("semantic", "semantic_price"):
                semantic_pairs += 1

            raw_po_sku = str(matched_po_line.get("sku", "")).upper()
            norm_po_sku = _alnum_upper(raw_po_sku)
            po_unit_price = _q2(Decimal(str(matched_po_line["unit_price"])))

            if inv_item.unit_price > po_unit_price + MONEY_TOLERANCE:
                risk_flags.add("UNIT_PRICE_OVERCHARGE")
                variances.append(
                    LineItemVariance(
                        sku=raw_po_sku or inv_item.sku,
                        description=inv_item.description,
                        issue="UNIT_PRICE_EXCEEDS_PO",
                        expected_value=str(po_unit_price),
                        actual_value=str(inv_item.unit_price),
                    )
                )

            if norm_po_sku:
                billed_qty_by_sku[norm_po_sku] = billed_qty_by_sku.get(norm_po_sku, Decimal("0")) + inv_item.quantity
                billed_desc_by_sku.setdefault(norm_po_sku, inv_item.description)

        # Enforce aggregate PO and Goods Receipt quantity caps per SKU
        for norm_sku, total_billed_qty in billed_qty_by_sku.items():
            po_line = po_meta_by_sku.get(norm_sku)
            if not po_line:
                continue
            display_sku = str(po_line.get("sku", norm_sku)).upper()
            display_desc = billed_desc_by_sku.get(norm_sku, str(po_line.get("description", display_sku)))
            po_qty = Decimal(str(po_line["quantity"]))

            if total_billed_qty > po_qty:
                risk_flags.add("QTY_EXCEEDS_PO")
                variances.append(
                    LineItemVariance(
                        sku=display_sku,
                        description=display_desc,
                        issue="QTY_EXCEEDS_ORDERED_PO",
                        expected_value=str(po_qty),
                        actual_value=str(total_billed_qty),
                    )
                )
            elif total_billed_qty < po_qty:
                is_partial_shipment = True

            if receipts and norm_sku in received_by_sku:
                rec_qty = received_by_sku[norm_sku]
                if total_billed_qty > rec_qty:
                    goods_receipt_matched = False
                    risk_flags.add("QTY_EXCEEDS_GOODS_RECEIPT")
                    variances.append(
                        LineItemVariance(
                            sku=display_sku,
                            description=display_desc,
                            issue="BILLED_QTY_EXCEEDS_DELIVERED_GR",
                            expected_value=str(rec_qty),
                            actual_value=str(total_billed_qty),
                        )
                    )

        if semantic_pairs > 0:
            smart_notes.append(f"semantically aligned {semantic_pairs} rephrased line item(s)")

    is_clean_match = (
        vendor_matched
        and po_matched
        and goods_receipt_matched
        and arithmetic_valid
        and iban_verified
        and currency_valid
        and len(risk_flags) == 0
    )

    # Build executive-grade plain-English audit summary
    if is_clean_match:
        match_kind = "partial-shipment 3-way match" if is_partial_shipment else "3-way match"
        note_suffix = f" ({'; '.join(smart_notes)})" if smart_notes else ""
        tax_note = f" incl. {inv_currency} {extraction.tax_amount} tax" if extraction.tax_amount > 0 else ""
        summary = (
            f"Clean {match_kind} verified against {po.po_number if po else extraction.po_number} "
            f"for {vendor.legal_name if vendor else extraction.vendor_name} "
            f"({inv_currency} {extraction.total_amount}{tax_note}){note_suffix}."
        )
    elif not vendor_matched and not po_matched and arithmetic_valid and "PROMPT_INJECTION_DETECTED" not in risk_flags:
        summary = (
            f"Unregistered vendor / Non-PO spend detected for '{extraction.vendor_name}' "
            f"({inv_currency} {extraction.total_amount}). Line-item Decimal math passed; "
            f"routed for vendor onboarding and Controller review."
        )
    else:
        summary = (
            f"Deterministic 3-way audit flagged {len(risk_flags)} issue(s): "
            f"{', '.join(sorted(risk_flags))}."
        )

    return ThreeWayMatchReport(
        is_clean_match=is_clean_match,
        vendor_matched=vendor_matched,
        vendor_code=vendor.vendor_code if vendor else None,
        vendor_id=str(vendor.id) if vendor else None,
        po_matched=po_matched,
        goods_receipt_matched=goods_receipt_matched,
        arithmetic_valid=arithmetic_valid,
        iban_verified=iban_verified,
        currency_valid=currency_valid,
        computed_subtotal=computed_subtotal,
        computed_total=computed_total,
        po_total_amount=po_total,
        total_variance_amount=total_variance,
        line_variances=variances,
        risk_flags=sorted(risk_flags),
        summary=summary,
    )