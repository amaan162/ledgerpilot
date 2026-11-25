import io
from dataclasses import dataclass, field

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas


@dataclass
class InvoicePDFSpec:
    vendor_name: str
    vendor_code: str
    vendor_tax_id: str
    invoice_number: str
    po_number: str | None
    invoice_date: str
    due_date: str
    payment_terms: str
    currency: str
    iban: str
    bic: str
    line_items: list[dict]  # sku, description, quantity, unit_price, line_total
    subtotal: str
    tax_amount: str
    total_amount: str
    notes: str = ""
    # Adversarial test options (for red-teaming & 1-click fraud demos)
    hidden_white_text: str | None = None
    micro_font_text: str | None = None
    metadata_injection: str | None = None
    extra_visible_banner: bool = True
    extra_metadata: dict[str, str] = field(default_factory=dict)


def generate_invoice_pdf_bytes(spec: InvoicePDFSpec) -> bytes:
    """Renders a realistic enterprise invoice PDF (with optional red-team injection payloads)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    width, height = LETTER

    c.setTitle(f"Invoice {spec.invoice_number} - {spec.vendor_name}")
    c.setAuthor(spec.vendor_name)
    if spec.metadata_injection:
        c.setSubject(spec.metadata_injection)

    # 1. Legitimate Dark Corporate Header Banner (white text on dark navy — tests zero false positives!)
    if spec.extra_visible_banner:
        c.setFillColorRGB(0.08, 0.14, 0.28)
        c.rect(0, height - 95, width, 95, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 18)
        c.drawString(45, height - 48, spec.vendor_name)
        c.setFont("Helvetica", 10)
        c.drawString(45, height - 68, f"Vendor Code: {spec.vendor_code}  |  Tax ID: {spec.vendor_tax_id}")
        c.setFont("Helvetica-Bold", 16)
        c.drawRightString(width - 45, height - 55, "COMMERCIAL INVOICE")

    # 2. Invoice Metadata Block
    c.setFillColor(colors.black)
    y = height - 130
    c.setFont("Helvetica-Bold", 10)
    c.drawString(45, y, "Bill To:")
    c.setFont("Helvetica", 10)
    c.drawString(45, y - 15, "LedgerPilot Global Holdings Ltd")
    c.drawString(45, y - 30, "Accounts Payable Operations, London / New York")

    meta_rows = [
        ("Invoice Number:", spec.invoice_number),
        ("PO Number:", spec.po_number or "N/A"),
        ("Invoice Date:", spec.invoice_date),
        ("Due Date:", spec.due_date),
        ("Payment Terms:", spec.payment_terms),
        ("Currency:", spec.currency),
    ]
    my = y
    for label, val in meta_rows:
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(355, my, label)
        c.setFont("Helvetica", 9.5)
        c.drawString(455, my, val)
        my -= 15

    # 3. Line Items Table
    y = height - 245
    c.setFillColorRGB(0.93, 0.95, 0.98)
    c.rect(45, y - 5, width - 90, 22, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(52, y + 3, "SKU")
    c.drawString(135, y + 3, "Description")
    c.drawRightString(395, y + 3, "Qty")
    c.drawRightString(475, y + 3, "Unit Price")
    c.drawRightString(555, y + 3, "Line Total")

    y -= 24
    c.setFont("Helvetica", 9)
    for item in spec.line_items:
        c.drawString(52, y, str(item.get("sku") or "-"))
        c.drawString(135, y, str(item["description"])[:42])
        c.drawRightString(395, y, str(item["quantity"]))
        c.drawRightString(475, y, f"{spec.currency} {item['unit_price']}")
        c.drawRightString(555, y, f"{spec.currency} {item['line_total']}")
        y -= 18

    # 4. Totals Block
    y -= 15
    c.line(350, y + 10, 560, y + 10)
    c.setFont("Helvetica", 10)
    c.drawString(360, y - 6, "Subtotal:")
    c.drawRightString(555, y - 6, f"{spec.currency} {spec.subtotal}")
    c.drawString(360, y - 22, "Tax / VAT:")
    c.drawRightString(555, y - 22, f"{spec.currency} {spec.tax_amount}")
    c.setFont("Helvetica-Bold", 11)
    c.drawString(360, y - 42, "Total Due:")
    c.drawRightString(555, y - 42, f"{spec.currency} {spec.total_amount}")

    # 5. Bank Remittance Instructions
    y -= 85
    c.setFont("Helvetica-Bold", 10)
    c.drawString(45, y, "Wire Settlement Instructions:")
    c.setFont("Helvetica", 9.5)
    c.drawString(45, y - 16, f"Beneficiary IBAN: {spec.iban}")
    c.drawString(45, y - 31, f"SWIFT / BIC: {spec.bic}")
    if spec.notes:
        c.drawString(45, y - 52, f"Notes: {spec.notes}")

    # 6. Optional Adversarial Payloads (for OWASP LLM01 Red-Team Testing)
    if spec.hidden_white_text:
        c.setFillColor(colors.white)
        c.setFont("Helvetica", 8)
        c.drawString(45, 75, spec.hidden_white_text)

    if spec.micro_font_text:
        c.setFillColor(colors.black)
        c.setFont("Helvetica", 1.5)
        c.drawString(45, 50, spec.micro_font_text)

    c.showPage()
    c.save()
    return buf.getvalue()
