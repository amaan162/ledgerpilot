# ADR-001: LedgerPilot Architectural Boundaries, MNC Security Invariants & Trade-Offs

**Status:** Accepted  
**Author:** Amaan Shaikh  
**Date:** 2026-11-25  

## 1. Context
Accounts Payable (AP) automation initiates irreversible outbound bank wires while ingesting untrusted external vendor PDFs. Standard LLM-first agent prototypes fail enterprise FinOps and SOC 2 / SOX 404 audits because they delegate financial math, sanctions screening, policy enforcement, and authorization to probabilistic models vulnerable to indirect prompt injection (OWASP LLM01), weaponized documents, and floating-point drift.

## 2. Core Architectural Decisions

### Decision A: Strict Deterministic Core vs. Probabilistic Extraction
* **Choice:** LLMs (Gemini 4 Hydrogen with automatic multi-model failover) are restricted strictly to *unstructured multimodal extraction* and *grounded MSA compliance reasoning*. All financial math (`Decimal` 3-way matching), IBAN verification, OFAC/EU sanctions jurisdiction screening (`IR`, `KP`, `SY`, `CU`, `RU`, `BY`), spend caps, and quarantine routing execute in pure Python.
* **Consequence:** Even a fully compromised LLM returning `is_compliant=true` cannot override `HIDDEN_WHITE_TEXT_DETECTED`, `PDF_ACTIVE_CONTENT_EXPLOIT`, `SANCTIONS_JURISDICTION_BLOCK`, or `IBAN_MISMATCH_FRAUD_RISK`. Fraud/injection recall remains **100.00%** across the 100-case golden suite.

### Decision B: Defense-in-Depth Pre-LLM Document & Active-Exploit Gate
* **Choice:** Every upload passes magic-byte verification, anti-polyglot signature checks (blocking PE/EXE, ELF, ZIP, shell, and HTML/script payloads disguised as PDFs), and filename path-traversal sanitization before touching disk. PyMuPDF then inspects PDF xref dictionaries for weaponized active content (`/JavaScript`, `/JS`, `/Launch`, `/OpenAction`, `/AA`, `/EmbeddedFile`, `/RichMedia`) and extracts the unclipped coordinate plane (`TEXTFLAGS_DICT & ~TEXT_MEDIABOX_CLIP` with `INFINITE_RECT()`) to catch off-page text, microscopic fonts (`<= 3.0pt`), banner-aware white-on-white text, metadata/annotation payloads, and zero-width Unicode obfuscation.
* **Consequence:** Zero false-positive quarantines (`0.00%`) on branded corporate PDFs alongside deterministic blocking of both prompt injections and PDF-layer exploits.

### Decision C: Vendor-Isolated Hybrid `pgvector` RAG + Citation Verification
* **Choice:** Contract clauses live in PostgreSQL `pgvector` (768-dim L2-normalized embeddings, HNSW cosine index) with mandatory SQL `WHERE vendor_id = :id` isolation, 85/15 cosine+lexical hybrid scoring, a `0.45` low-evidence escalation floor, and pure-Python citation verification that strips any fabricated clause ID.
* **Consequence:** Prevents cross-tenant contract leakage and eliminates hallucinated compliance justifications.

### Decision D: Durable LangGraph Checkpoints, SOX 404 SoD & Self-Healing ISO 20022 Settlement
* **Choice:** Invoices `>= $1,000` or with match/contract exceptions pause durably via LangGraph `interrupt()` backed by `langgraph-checkpoint-postgres`. Resuming requires backend-enforced RBAC role rank, per-role spend caps, and **SOX 404 Segregation of Duties** (blocking any user from self-approving an invoice they ingested). Approved wires generate an idempotent ISO 20022 `pain.001.001.03` XML file pulling **only** the verified vendor master IBAN/BIC—and `GET /settlement.xml` deterministically reconstructs the XML from PostgreSQL records if ephemeral cloud storage is recycled.
* **Consequence:** Survives restarts and ephemeral container disk wipes with zero duplicate payments and zero unverified IBAN leakage.

### Decision E: Dual-Layer Tamper-Evident Audit Ledger & Operational Resilience
* **Choice:** Every `HUMAN`, `AGENT`, `SYSTEM`, `N8N`, and `MCP` event is written to `audit_logs`, guarded both by a PostgreSQL `BEFORE UPDATE OR DELETE` trigger and per-row **HMAC-SHA256 cryptographic seals** verifiable live via `GET /api/v1/security/audit-integrity`. Upstream Gemini and n8n calls are wrapped in `CLOSED → OPEN → HALF_OPEN` circuit breakers, paired with a daily FinOps LLM spend guard, sliding-window API rate limiting, strict HTTP security headers (`HSTS`, `CSP`, `X-Frame-Options: DENY`, `Cache-Control: no-store`), and auditable Dead-Letter Queue triage.
* **Consequence:** Protects against cascading upstream failures, cloud AI bill DoS attacks, and even out-of-band database tampering.

### Decision F: Edge Orchestration (n8n) & Scoped MCP v2 Server
* **Choice:** n8n handles strictly edge triggers (Gmail intake, Slack Block Kit cards, 15-minute SLA sweeps) over HMAC-SHA256 replay-protected webhooks (300s window) with DLQ fallback. The MCP v2 server holds zero database credentials, calling role-scoped FastAPI endpoints and requiring explicit human confirmation (`confirm_hold=True`) before mutating state.
* **Consequence:** Edge outages never corrupt core AP ledger integrity.

## 3. Known Architectural Trade-Offs (Single-Node Portfolio vs. Multi-Replica MNC Production)
* **In-Process State vs. Distributed Redis:** The sliding-window rate limiter, circuit breakers, daily LLM budget counter, and audit seal chain head currently use thread-safe in-process locks to keep single-container deployment zero-cost. Scaling horizontally across multiple FastAPI replicas moves these counters to Redis and chains audit seals via a PostgreSQL advisory lock.
* **Sandbox Persona API Keys vs. Enterprise OIDC/SSO:** The live demo uses static sandbox persona keys so reviewers can test RBAC, spend limits, and SOX 404 blocks without provisioning an IdP. Enterprise deployment replaces API keys with short-lived OIDC/JWT bearer tokens from Microsoft Entra ID or Okta.
