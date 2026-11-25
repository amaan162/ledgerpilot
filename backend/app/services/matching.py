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


def _q2(val: Decimal) -> Decimal:
    return val.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _normalize_iban(iban: str | None) -> str:
    if not iban:
        return ""
    return "".join(ch for ch in iban.upper() if ch.isalnum())


async def _resolve_vendor(db: AsyncSession, extraction: InvoiceExtraction) -> Vendor | None:
    if extraction.vendor_code:
        v = await db.scalar(select(Vendor).where(Vendor.vendor_code == extraction.vendor_code))
        if v:
            return v
    if extraction.vendor_tax_id:
        v = await db.scalar(select(Vendor).where(Vendor.tax_id == extraction.vendor_tax_id))
        if v:
            return v
    # Case-insensitive exact legal name match, then substring fallback
    v = await db.scalar(select(Vendor).where(func.lower(Vendor.legal_name) == extraction.vendor_name.lower()))
    if v:
        return v
    all_vendors = (await db.scalars(select(Vendor))).all()
    target = extraction.vendor_name.lower()
    for candidate in all_vendors:
        cand_name = candidate.legal_name.lower()
        if cand_name in target or target in cand_name:
            return candidate
    return None


async def run_deterministic_three_way_match(
    db: AsyncSession, extraction: InvoiceExtraction
) -> ThreeWayMatchReport:
    """
    100% Pure-Python Decimal financial verification (ZERO LLM math).
    Audits arithmetic, Vendor master record, IBAN wire-fraud match, PO pricing, and Goods Receipts.
    """
    risk_flags: set[str] = set()
    variances: list[LineItemVariance] = []

    # 1. Cross-check extracted text fields for image-based or OCR prompt injections
    text_to_check = f"{extraction.notes or ''} {extraction.suspicious_text_found or ''}".strip()
    if extraction.suspicious_text_found or scan_text_for_prompt_injection(text_to_check):
        risk_flags.add("PROMPT_INJECTION_DETECTED")

    # 2. Pure Decimal Arithmetic Audit
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

    # 4. Purchase Order Lookup & 2-Way Line-Item / Price Verification
    po: PurchaseOrder | None = None
    po_matched = False
    goods_receipt_matched = False
    currency_valid = True
    po_total: Decimal | None = None
    total_variance: Decimal | None = None

    if extraction.po_number:
        po = await db.scalar(select(PurchaseOrder).where(PurchaseOrder.po_number == extraction.po_number))

    if not po:
        risk_flags.add("MISSING_PO")
    else:
        po_matched = True
        po_total = _q2(Decimal(po.total_amount))
        total_variance = _q2(extraction.subtotal - po_total)

        if vendor and po.vendor_id != vendor.id:
            risk_flags.add("PO_VENDOR_MISMATCH")

        if extraction.currency != po.currency.upper():
            currency_valid = False
            risk_flags.add("CURRENCY_MISMATCH")

        if extraction.subtotal > po_total + MONEY_TOLERANCE:
            risk_flags.add("PO_TOTAL_EXCEEDED")

        # Index PO line items by SKU (fallback to normalized description)
        po_by_sku: dict[str, dict] = {}
        po_by_desc: dict[str, dict] = {}
        for po_line in po.line_items:
            if po_line.get("sku"):
                po_by_sku[str(po_line["sku"]).upper()] = po_line
            if po_line.get("description"):
                po_by_desc[str(po_line["description"]).strip().lower()] = po_line

        # 5. Goods Receipt 3-Way Quantity Aggregation
        receipts = (await db.scalars(select(GoodsReceipt).where(GoodsReceipt.po_id == po.id))).all()
        received_by_sku: dict[str, Decimal] = {}
        for gr in receipts:
            for rec in gr.received_items:
                sku_key = str(rec.get("sku", "")).upper()
                received_by_sku[sku_key] = received_by_sku.get(sku_key, Decimal("0")) + Decimal(
                    str(rec.get("quantity_received", 0))
                )

        if not receipts:
            risk_flags.add("MISSING_GOODS_RECEIPT")
        else:
            goods_receipt_matched = True

        # Audit each billed invoice line item against PO + Goods Receipt
        for inv_item in extraction.line_items:
            matched_po_line = None
            if inv_item.sku and inv_item.sku in po_by_sku:
                matched_po_line = po_by_sku[inv_item.sku]
            elif inv_item.description.lower() in po_by_desc:
                matched_po_line = po_by_desc[inv_item.description.lower()]

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

            po_sku = str(matched_po_line.get("sku", "")).upper()
            po_unit_price = _q2(Decimal(str(matched_po_line["unit_price"])))
            po_qty = Decimal(str(matched_po_line["quantity"]))

            if inv_item.unit_price > po_unit_price + MONEY_TOLERANCE:
                risk_flags.add("UNIT_PRICE_OVERCHARGE")
                variances.append(
                    LineItemVariance(
                        sku=po_sku or inv_item.sku,
                        description=inv_item.description,
                        issue="UNIT_PRICE_EXCEEDS_PO",
                        expected_value=str(po_unit_price),
                        actual_value=str(inv_item.unit_price),
                    )
                )

            if inv_item.quantity > po_qty:
                risk_flags.add("QTY_EXCEEDS_PO")
                variances.append(
                    LineItemVariance(
                        sku=po_sku or inv_item.sku,
                        description=inv_item.description,
                        issue="QTY_EXCEEDS_ORDERED_PO",
                        expected_value=str(po_qty),
                        actual_value=str(inv_item.quantity),
                    )
                )

            if receipts and po_sku in received_by_sku:
                rec_qty = received_by_sku[po_sku]
                if inv_item.quantity > rec_qty:
                    goods_receipt_matched = False
                    risk_flags.add("QTY_EXCEEDS_GOODS_RECEIPT")
                    variances.append(
                        LineItemVariance(
                            sku=po_sku,
                            description=inv_item.description,
                            issue="BILLED_QTY_EXCEEDS_DELIVERED_GR",
                            expected_value=str(rec_qty),
                            actual_value=str(inv_item.quantity),
                        )
                    )

    is_clean_match = (
        vendor_matched
        and po_matched
        and goods_receipt_matched
        and arithmetic_valid
        and iban_verified
        and currency_valid
        and len(risk_flags) == 0
    )

    if is_clean_match:
        summary = (
            f"Clean 3-way match verified against {extraction.po_number} "
            f"for {vendor.legal_name if vendor else extraction.vendor_name} "
            f"({extraction.currency} {extraction.total_amount})."
        )
    else:
        summary = f"Deterministic 3-way audit flagged {len(risk_flags)} issue(s): {', '.join(sorted(risk_flags))}."

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
