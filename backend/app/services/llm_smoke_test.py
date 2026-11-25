import asyncio

from app.services.llm import GeminiLLMService
from app.services.pdf_forensics import scan_document_bytes
from app.services.pdf_generator import InvoicePDFSpec, generate_invoice_pdf_bytes


async def main() -> None:
    spec = InvoicePDFSpec(
        vendor_name="Apex Cloud Infrastructure Inc.",
        vendor_code="VND-US-CLOUD01",
        vendor_tax_id="US-EIN-84-2910442",
        invoice_number="INV-SMOKE-2026-01",
        po_number="PO-2026-1001",
        invoice_date="2026-11-23",
        due_date="2026-12-23",
        payment_terms="Net-30",
        currency="USD",
        iban="US64SVBKUS6S3300958879",
        bic="SVBKUS6S",
        line_items=[
            {
                "sku": "CLD-GPU-NODE",
                "description": "Dedicated GPU Inference Cluster (Monthly)",
                "quantity": 1,
                "unit_price": "750.00",
                "line_total": "750.00",
            },
            {
                "sku": "CLD-NAT-GW",
                "description": "Managed NAT Gateway & Egress Tier 1",
                "quantity": 2,
                "unit_price": "50.00",
                "line_total": "100.00",
            },
        ],
        subtotal="850.00",
        tax_amount="0.00",
        total_amount="850.00",
    )
    pdf_bytes = generate_invoice_pdf_bytes(spec)
    scan = scan_document_bytes(pdf_bytes, "smoke_test.pdf")
    print(f"[Forensics] suspicious={scan.is_suspicious}, risk_score={scan.risk_score}")

    llm = GeminiLLMService()
    extraction, cost_usd, tokens = await llm.extract_invoice(pdf_bytes, "smoke_test.pdf")
    print(f"[Gemini Multimodal] vendor={extraction.vendor_name} | inv={extraction.invoice_number}")
    print(f"[Gemini Multimodal] po={extraction.po_number} | total={extraction.currency} {extraction.total_amount}")
    print(f"[Gemini Multimodal] iban={extraction.bank_iban} | line_items={len(extraction.line_items)}")
    print(f"[Telemetry] tokens={tokens} | estimated_cost_usd=${cost_usd}")


if __name__ == "__main__":
    asyncio.run(main())
