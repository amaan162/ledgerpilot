# LedgerPilot — 90-Second Recruiter & Hiring Manager Demo Script

**Setup before recording (Loom / OBS, 1080p):**
* Open the live LedgerPilot Command Center (`http://localhost:3000` or your Vercel URL).
* Set the top-right persona selector to **James Holloway — Finance Manager ($10k limit)**.

---

### 0:00 – 0:15 | The Hook & Architecture
> "Hi, I'm Amaan. This is **LedgerPilot**—an autonomous Accounts Payable, Contract Compliance, and Wire-Fraud Defense engine built with FastAPI, PostgreSQL + `pgvector`, LangGraph, n8n, and ISO 20022 wire settlement. Notice the live eval badge at the top: **100% routing accuracy and 100% fraud recall across 100 test PDFs**."

### 0:15 – 0:35 | Live Wire-Fraud & OWASP LLM01 Defense
*(Click **Hidden White-Text Wire Fraud**)*
> "Most AI invoice demos fail against stealth prompt injections. Here I'm generating a live invoice PDF containing hidden white-on-white override instructions and a hijacked Cyprus IBAN. Before the LLM even decides anything, my PyMuPDF forensics layer and deterministic `Decimal` 3-way match engine catch both attacks, score risk at 100/100, and hard-quarantine the invoice with zero wire XML generated."

### 0:35 – 0:60 | Durable LangGraph HITL Pause, RBAC & Resume
*(Click **Manager HITL Pause ($4,800)** -> switch to **HITL Approval Queue**)*
> "For legitimate high-value invoices—like this $4,800 advisory bill—the LangGraph state machine pauses durably inside PostgreSQL checkpoints at `AWAITING_APPROVAL`. Watch what happens if I switch personas to **Maya Patel (AP Clerk)** and try to approve..."
*(Switch to Maya Patel -> click **Approve & Stage Wire** -> point to red 403 banner)*
> "...the FastAPI backend enforces strict RBAC and blocks it with a 403. Now I switch back to **James Holloway (Finance Manager)** and approve."
*(Switch to James Holloway -> click **Approve & Stage Wire**)*

### 0:60 – 0:80 | Verified RAG Citations, ISO 20022 XML & Immutable Ledger
*(Scroll down the resumed invoice dossier)*
> "LangGraph resumes from its PostgreSQL checkpoint, shows the exact vendor-isolated `pgvector` MSA clause citations, and stages a bank-ready **ISO 20022 `pain.001` XML** wire file—always pulling the verified vendor master IBAN, never the raw PDF text. Every state transition is written to an append-only PostgreSQL audit ledger protected by a database trigger."

### 0:80 – 0:90 | Close
> "The entire system is backed by 32 automated tests—including 15 OWASP red-team security tests—exportable n8n edge workflows, a scoped MCP v2 server, and GitHub Actions CI. Links to the live demo and repo are below."
