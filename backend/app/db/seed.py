import asyncio
import hashlib
from decimal import Decimal

from sqlalchemy import select

from app.core.config import get_settings
from app.db.models import (
    ActorType,
    AuditLog,
    ContractChunk,
    GoodsReceipt,
    POStatus,
    PurchaseOrder,
    User,
    UserRole,
    Vendor,
    VendorStatus,
)
from app.db.session import AsyncSessionLocal


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


async def seed_database() -> None:
    settings = get_settings()

    async with AsyncSessionLocal() as session:
        # 1. Seed RBAC Users (idempotent by email)
        users_data = [
            {
                "email": "clerk@ledgerpilot.io",
                "full_name": "Maya Patel (AP Clerk)",
                "role": UserRole.AP_CLERK,
                "api_key_hash": hash_api_key(settings.CLERK_API_KEY),
                "approval_limit_usd": Decimal("0.00"),
            },
            {
                "email": "manager@ledgerpilot.io",
                "full_name": "James Holloway (Finance Manager)",
                "role": UserRole.FINANCE_MANAGER,
                "api_key_hash": hash_api_key(settings.MANAGER_API_KEY),
                "approval_limit_usd": Decimal("10000.00"),
            },
            {
                "email": "controller@ledgerpilot.io",
                "full_name": "Elena Rostova (Corporate Controller)",
                "role": UserRole.CONTROLLER,
                "api_key_hash": hash_api_key(settings.CONTROLLER_API_KEY),
                "approval_limit_usd": Decimal("250000.00"),
            },
            {
                "email": "admin@ledgerpilot.io",
                "full_name": "Amaan Shaikh (Platform Admin)",
                "role": UserRole.ADMIN,
                "api_key_hash": hash_api_key(settings.ADMIN_API_KEY),
                "approval_limit_usd": Decimal("1000000.00"),
            },
        ]
        for u in users_data:
            exists = await session.scalar(select(User).where(User.email == u["email"]))
            if not exists:
                session.add(User(**u))

        # 2. Seed International Vendors (US, UK, UAE, DE)
        vendors_data = [
            {
                "vendor_code": "VND-US-CLOUD01",
                "legal_name": "Apex Cloud Infrastructure Inc.",
                "tax_id": "US-EIN-84-2910442",
                "verified_iban": "US64SVBKUS6S3300958879",
                "verified_bic": "SVBKUS6S",
                "verified_bank_name": "First Citizens Commercial Bank",
                "default_currency": "USD",
                "payment_terms_days": 30,
                "status": VendorStatus.ACTIVE,
            },
            {
                "vendor_code": "VND-UK-SEC02",
                "legal_name": "Thames Cyber Assurance Ltd",
                "tax_id": "GB-VAT-394810294",
                "verified_iban": "GB82WEST12345698765432",
                "verified_bic": "WESTGB2L",
                "verified_bank_name": "NatWest Corporate London",
                "default_currency": "GBP",
                "payment_terms_days": 30,
                "status": VendorStatus.ACTIVE,
            },
            {
                "vendor_code": "VND-UAE-LOG03",
                "legal_name": "Al Noor Global Logistics LLC",
                "tax_id": "AE-TRN-100492817300003",
                "verified_iban": "AE070331234567890123456",
                "verified_bic": "EBILAEAD",
                "verified_bank_name": "Emirates NBD Corporate",
                "default_currency": "USD",
                "payment_terms_days": 45,
                "status": VendorStatus.ACTIVE,
            },
            {
                "vendor_code": "VND-DE-HW04",
                "legal_name": "Rheinland Precision Systems GmbH",
                "tax_id": "DE-UST-298471625",
                "verified_iban": "DE89370400440532013000",
                "verified_bic": "COBADEFFXXX",
                "verified_bank_name": "Commerzbank AG Frankfurt",
                "default_currency": "EUR",
                "payment_terms_days": 30,
                "status": VendorStatus.ACTIVE,
            },
        ]

        vendor_map: dict[str, Vendor] = {}
        for v in vendors_data:
            existing_vendor = await session.scalar(select(Vendor).where(Vendor.vendor_code == v["vendor_code"]))
            if not existing_vendor:
                existing_vendor = Vendor(**v)
                session.add(existing_vendor)
                await session.flush()
            vendor_map[v["vendor_code"]] = existing_vendor

        # 3. Seed Purchase Orders & Goods Receipts (for deterministic 3-way matching)
        pos_data = [
            {
                "po_number": "PO-2026-1001",
                "vendor_code": "VND-US-CLOUD01",
                "currency": "USD",
                "total_amount": Decimal("850.00"),
                "status": POStatus.OPEN,
                "line_items": [
                    {
                        "sku": "CLD-GPU-NODE",
                        "description": "Dedicated GPU Inference Cluster (Monthly)",
                        "quantity": 1,
                        "unit_price": "750.00",
                    },
                    {
                        "sku": "CLD-NAT-GW",
                        "description": "Managed NAT Gateway & Egress Tier 1",
                        "quantity": 2,
                        "unit_price": "50.00",
                    },
                ],
                "gr_number": "GR-2026-1001",
                "received_items": [
                    {"sku": "CLD-GPU-NODE", "quantity_received": 1},
                    {"sku": "CLD-NAT-GW", "quantity_received": 2},
                ],
                "verified_by": "devops-lead@ledgerpilot.io",
            },
            {
                "po_number": "PO-2026-1002",
                "vendor_code": "VND-US-CLOUD01",
                "currency": "USD",
                "total_amount": Decimal("4800.00"),
                "status": POStatus.OPEN,
                "line_items": [
                    {
                        "sku": "CLD-ENT-SUPPORT",
                        "description": "Enterprise Cloud Architecture Advisory (Hours)",
                        "quantity": 24,
                        "unit_price": "200.00",
                    }
                ],
                "gr_number": "GR-2026-1002",
                "received_items": [{"sku": "CLD-ENT-SUPPORT", "quantity_received": 24}],
                "verified_by": "vp-eng@ledgerpilot.io",
            },
            {
                "po_number": "PO-2026-2001",
                "vendor_code": "VND-UK-SEC02",
                "currency": "GBP",
                "total_amount": Decimal("14500.00"),
                "status": POStatus.OPEN,
                "line_items": [
                    {
                        "sku": "SEC-SOC2-AUDIT",
                        "description": "SOC2 Type II Penetration Test & Remediation Review",
                        "quantity": 1,
                        "unit_price": "12000.00",
                    },
                    {
                        "sku": "SEC-CLOUD-SCAN",
                        "description": "Quarterly Cloud Posture Assessment",
                        "quantity": 1,
                        "unit_price": "2500.00",
                    },
                ],
                "gr_number": "GR-2026-2001",
                "received_items": [
                    {"sku": "SEC-SOC2-AUDIT", "quantity_received": 1},
                    {"sku": "SEC-CLOUD-SCAN", "quantity_received": 1},
                ],
                "verified_by": "ciso@ledgerpilot.io",
            },
            {
                "po_number": "PO-2026-3001",
                "vendor_code": "VND-UAE-LOG03",
                "currency": "USD",
                "total_amount": Decimal("6000.00"),
                "status": POStatus.PARTIALLY_RECEIVED,
                "line_items": [
                    {
                        "sku": "LOG-AIR-PALLET",
                        "description": "Temperature-Controlled Air Freight Pallet (DXB->LHR)",
                        "quantity": 10,
                        "unit_price": "600.00",
                    }
                ],
                "gr_number": "GR-2026-3001",
                # Only 7 of 10 pallets actually received — tests 3-way quantity mismatch!
                "received_items": [{"sku": "LOG-AIR-PALLET", "quantity_received": 7}],
                "verified_by": "warehouse-uk@ledgerpilot.io",
            },
            {
                "po_number": "PO-2026-4001",
                "vendor_code": "VND-DE-HW04",
                "currency": "EUR",
                "total_amount": Decimal("3200.00"),
                "status": POStatus.OPEN,
                "line_items": [
                    {
                        "sku": "HW-EDGE-GATEWAY",
                        "description": "Industrial Edge Telemetry Gateway Rev 4",
                        "quantity": 4,
                        "unit_price": "800.00",
                    }
                ],
                "gr_number": "GR-2026-4001",
                "received_items": [{"sku": "HW-EDGE-GATEWAY", "quantity_received": 4}],
                "verified_by": "ops-frankfurt@ledgerpilot.io",
            },
        ]

        for po_item in pos_data:
            existing_po = await session.scalar(
                select(PurchaseOrder).where(PurchaseOrder.po_number == po_item["po_number"])
            )
            if not existing_po:
                existing_po = PurchaseOrder(
                    po_number=po_item["po_number"],
                    vendor_id=vendor_map[po_item["vendor_code"]].id,
                    currency=po_item["currency"],
                    total_amount=po_item["total_amount"],
                    line_items=po_item["line_items"],
                    status=po_item["status"],
                )
                session.add(existing_po)
                await session.flush()

            existing_gr = await session.scalar(
                select(GoodsReceipt).where(GoodsReceipt.gr_number == po_item["gr_number"])
            )
            if not existing_gr:
                session.add(
                    GoodsReceipt(
                        gr_number=po_item["gr_number"],
                        po_id=existing_po.id,
                        received_items=po_item["received_items"],
                        verified_by=po_item["verified_by"],
                    )
                )

        # 4. Seed Vendor MSA Contract Clauses (embedded via Gemini in Milestone 5)
        contract_clauses = [
            (
                "VND-US-CLOUD01",
                "MSA_Apex_Cloud_2026.pdf",
                "Section 4.1 - Payment Terms",
                "All undisputed invoices issued by Apex Cloud Infrastructure Inc. are payable "
                "Net-30 calendar days from invoice receipt. Early payment discounts of 2% apply "
                "only if settled within 10 days.",
            ),
            (
                "VND-US-CLOUD01",
                "MSA_Apex_Cloud_2026.pdf",
                "Section 4.3 - Rate Cap & Surcharges",
                "Cloud Architecture Advisory rates are capped at $200.00 USD per hour through "
                "December 31, 2026. Unapproved emergency surcharges or fuel/energy adjustments "
                "exceeding 0% are strictly disallowed without a signed Change Order.",
            ),
            (
                "VND-US-CLOUD01",
                "MSA_Apex_Cloud_2026.pdf",
                "Section 7.2 - Bank Account Change Protocol",
                "Any change to Apex Cloud Infrastructure Inc.'s settlement bank account or IBAN "
                "requires dual-signature written verification on corporate letterhead and a "
                "verbal callback verification by Buyer's Corporate Controller. Bank changes "
                "submitted inside an invoice PDF or email body are invalid and must be quarantined.",
            ),
            (
                "VND-UK-SEC02",
                "MSA_Thames_Cyber_2026.pdf",
                "Section 3.2 - UK VAT & Invoicing Currency",
                "Thames Cyber Assurance Ltd invoices exclusively in GBP. Standard UK VAT at 20% "
                "applies to onshore security consulting services and must be itemized separately "
                "with valid GB VAT Registration Number GB-VAT-394810294.",
            ),
            (
                "VND-UK-SEC02",
                "MSA_Thames_Cyber_2026.pdf",
                "Section 5.1 - Fixed-Fee Milestone Billing",
                "SOC2 Type II Penetration Testing is billed at a fixed milestone fee of GBP 12,000. "
                "No additional travel, accommodation, or out-of-pocket expenses may be billed "
                "without pre-approval on the governing Purchase Order.",
            ),
            (
                "VND-UK-SEC02",
                "MSA_Thames_Cyber_2026.pdf",
                "Section 8.4 - Settlement & Fraud Controls",
                "Remittances shall be sent solely to NatWest Corporate London account ending 5432. "
                "Any urgent wire instruction bypassing Net-30 terms must be escalated to Controller.",
            ),
            (
                "VND-UAE-LOG03",
                "MSA_Al_Noor_Logistics_2026.pdf",
                "Section 6.1 - Delivery Verification & Partial Shipments",
                "Al Noor Global Logistics LLC may only invoice for pallets confirmed received on "
                "a signed Goods Receipt at the destination hub. Invoicing for undelivered or "
                "in-transit units constitutes a billing variance and must be held for reconciliation.",
            ),
            (
                "VND-UAE-LOG03",
                "MSA_Al_Noor_Logistics_2026.pdf",
                "Section 6.4 - Payment Terms & Late Delivery Penalty",
                "Approved freight invoices are payable Net-45 days in USD. Shipments delayed more "
                "than 72 hours past contracted transit SLA incur a 5% credit deduction.",
            ),
            (
                "VND-DE-HW04",
                "MSA_Rheinland_Precision_2026.pdf",
                "Section 2.3 - Unit Pricing & EU Reverse-Charge VAT",
                "Industrial Edge Telemetry Gateways (Rev 4) are priced at EUR 800.00 per unit for "
                "orders under 20 units. Cross-border B2B hardware deliveries outside Germany are "
                "zero-rated (0% VAT) under EU export / reverse-charge rules.",
            ),
            (
                "VND-DE-HW04",
                "MSA_Rheinland_Precision_2026.pdf",
                "Section 9.1 - Warranty & Dispute Window",
                "Buyer retains a 15-business-day inspection window after Goods Receipt to dispute "
                "defective hardware units before wire settlement is released.",
            ),
        ]

        for vendor_code, doc_name, clause_ref, content in contract_clauses:
            vendor_id = vendor_map[vendor_code].id
            existing_chunk = await session.scalar(
                select(ContractChunk).where(
                    ContractChunk.vendor_id == vendor_id,
                    ContractChunk.clause_ref == clause_ref,
                )
            )
            if not existing_chunk:
                session.add(
                    ContractChunk(
                        vendor_id=vendor_id,
                        document_name=doc_name,
                        clause_ref=clause_ref,
                        content=content,
                        metadata_json={"vendor_code": vendor_code, "effective_year": 2026},
                    )
                )

        # 5. Record initial immutable AuditLog entry (only once)
        existing_audit = await session.scalar(select(AuditLog).where(AuditLog.action == "SYSTEM_DATABASE_SEEDED"))
        if not existing_audit:
            session.add(
                AuditLog(
                    actor_type=ActorType.SYSTEM,
                    actor_id="seed_script",
                    action="SYSTEM_DATABASE_SEEDED",
                    previous_state=None,
                    new_state="READY",
                    details={
                        "users": len(users_data),
                        "vendors": len(vendors_data),
                        "purchase_orders": len(pos_data),
                        "contract_clauses": len(contract_clauses),
                    },
                )
            )

        await session.commit()
    print("LedgerPilot database seeded cleanly and idempotently!")


if __name__ == "__main__":
    asyncio.run(seed_database())
