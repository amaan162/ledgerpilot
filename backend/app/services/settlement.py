import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from app.core.config import get_settings
from app.db.models import Invoice, Vendor

ISO20022_NS = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"


@dataclass(frozen=True)
class SettlementArtifact:
    settlement_reference: str
    xml_path: str
    xml_sha256: str
    xml_content: str


def _clean_iso_text(value: str, max_len: int = 70) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 /\-\?:()\.,'+]", " ", value or "")
    return " ".join(cleaned.split())[:max_len] or "N/A"


def generate_iso20022_pain001(
    invoice: Invoice,
    vendor: Vendor,
    *,
    output_dir: Path | None = None,
) -> SettlementArtifact:
    """
    Generates a standards-compliant ISO 20022 pain.001.001.03 Customer Credit Transfer XML file.
    Strictly idempotent: reuses existing reference/file if invoice was already staged.
    """
    settings = get_settings()
    target_dir = output_dir or settings.settlement_dir_path
    target_dir.mkdir(parents=True, exist_ok=True)

    # Idempotency guard: never generate a second wire instruction for an already-staged invoice
    if invoice.settlement_reference and invoice.settlement_xml_path:
        existing_path = Path(invoice.settlement_xml_path)
        if existing_path.exists():
            xml_text = existing_path.read_text(encoding="utf-8")
            return SettlementArtifact(
                settlement_reference=invoice.settlement_reference,
                xml_path=str(existing_path),
                xml_sha256=hashlib.sha256(xml_text.encode("utf-8")).hexdigest(),
                xml_content=xml_text,
            )

    if invoice.total_amount is None:
        raise ValueError("Cannot stage ISO 20022 wire settlement without a verified total_amount.")

    now = datetime.now(UTC)
    amount = Decimal(invoice.total_amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    currency = (invoice.currency or vendor.default_currency or "USD").upper()[:3]

    short_id = invoice.id.hex[:12].upper()
    settlement_ref = f"LP-PAIN001-{now.strftime('%Y%m%d')}-{short_id}"
    end_to_end_id = _clean_iso_text(f"E2E-{invoice.invoice_number or short_id}", 35)

    ET.register_namespace("", ISO20022_NS)

    def tag(name: str) -> str:
        return f"{{{ISO20022_NS}}}{name}"

    doc = ET.Element(tag("Document"))
    cstmr = ET.SubElement(doc, tag("CstmrCdtTrfInitn"))

    # 1. Group Header (GrpHdr)
    grp_hdr = ET.SubElement(cstmr, tag("GrpHdr"))
    ET.SubElement(grp_hdr, tag("MsgId")).text = settlement_ref
    ET.SubElement(grp_hdr, tag("CreDtTm")).text = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    ET.SubElement(grp_hdr, tag("NbOfTxs")).text = "1"
    ET.SubElement(grp_hdr, tag("CtrlSum")).text = f"{amount:.2f}"
    initg_pty = ET.SubElement(grp_hdr, tag("InitgPty"))
    ET.SubElement(initg_pty, tag("Nm")).text = _clean_iso_text(settings.DEBTOR_COMPANY_NAME)

    # 2. Payment Information (PmtInf)
    pmt_inf = ET.SubElement(cstmr, tag("PmtInf"))
    ET.SubElement(pmt_inf, tag("PmtInfId")).text = f"PMT-{short_id}"
    ET.SubElement(pmt_inf, tag("PmtMtd")).text = "TRF"
    ET.SubElement(pmt_inf, tag("NbOfTxs")).text = "1"
    ET.SubElement(pmt_inf, tag("CtrlSum")).text = f"{amount:.2f}"
    ET.SubElement(pmt_inf, tag("ReqdExctnDt")).text = now.strftime("%Y-%m-%d")

    # Debtor (Our Company)
    dbtr = ET.SubElement(pmt_inf, tag("Dbtr"))
    ET.SubElement(dbtr, tag("Nm")).text = _clean_iso_text(settings.DEBTOR_COMPANY_NAME)
    dbtr_acct = ET.SubElement(pmt_inf, tag("DbtrAcct"))
    dbtr_acct_id = ET.SubElement(dbtr_acct, tag("Id"))
    ET.SubElement(dbtr_acct_id, tag("IBAN")).text = settings.DEBTOR_IBAN.replace(" ", "").upper()
    dbtr_agt = ET.SubElement(pmt_inf, tag("DbtrAgt"))
    dbtr_fin = ET.SubElement(dbtr_agt, tag("FinInstnId"))
    ET.SubElement(dbtr_fin, tag("BIC")).text = settings.DEBTOR_BIC.replace(" ", "").upper()

    # 3. Credit Transfer Transaction (CdtTrfTxInf) — ALWAYS uses verified vendor master IBAN/BIC!
    tx = ET.SubElement(pmt_inf, tag("CdtTrfTxInf"))
    pmt_id = ET.SubElement(tx, tag("PmtId"))
    ET.SubElement(pmt_id, tag("EndToEndId")).text = end_to_end_id

    amt = ET.SubElement(tx, tag("Amt"))
    instd_amt = ET.SubElement(amt, tag("InstdAmt"), {"Ccy": currency})
    instd_amt.text = f"{amount:.2f}"

    cdtr_agt = ET.SubElement(tx, tag("CdtrAgt"))
    cdtr_fin = ET.SubElement(cdtr_agt, tag("FinInstnId"))
    ET.SubElement(cdtr_fin, tag("BIC")).text = vendor.verified_bic.replace(" ", "").upper()

    cdtr = ET.SubElement(tx, tag("Cdtr"))
    ET.SubElement(cdtr, tag("Nm")).text = _clean_iso_text(vendor.legal_name)

    cdtr_acct = ET.SubElement(tx, tag("CdtrAcct"))
    cdtr_acct_id = ET.SubElement(cdtr_acct, tag("Id"))
    ET.SubElement(cdtr_acct_id, tag("IBAN")).text = vendor.verified_iban.replace(" ", "").upper()

    rmt_inf = ET.SubElement(tx, tag("RmtInf"))
    ET.SubElement(rmt_inf, tag("Ustrd")).text = _clean_iso_text(
        f"Invoice {invoice.invoice_number or 'N/A'} | PO {invoice.po_number or 'N/A'} | "
        f"Vendor {vendor.vendor_code}",
        140,
    )

    ET.indent(doc, space="  ")
    xml_bytes = ET.tostring(doc, encoding="utf-8", xml_declaration=True)
    xml_text = xml_bytes.decode("utf-8")

    xml_file = target_dir / f"{settlement_ref}.xml"
    xml_file.write_text(xml_text, encoding="utf-8")

    return SettlementArtifact(
        settlement_reference=settlement_ref,
        xml_path=str(xml_file.resolve()),
        xml_sha256=hashlib.sha256(xml_bytes).hexdigest(),
        xml_content=xml_text,
    )
