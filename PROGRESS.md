# LedgerPilot Build Tracker

- [x] **M0:** Environment setup (`git`, `node`, `npm`, `uv`, Python 3.12, Docker Desktop)
- [x] **M1:** Repo scaffold, `.gitignore`, `.env`, Docker Compose (`postgres+pgvector`, `n8n`)
- [x] **M2:** SQLAlchemy 2.0 ORM models, Alembic migrations, immutable audit trigger, realistic seed data
- [x] **M3:** FastAPI core, RBAC, HMAC webhook verification, idempotency guard & dead-letter queue
- [x] **M4:** PDF forensics (hidden white-text prompt-injection scanner) + multimodal extractor + `Decimal` 3-way match
- [x] **M5:** Contract RAG (`pgvector` + clause citations + low-evidence escalation)
- [x] **M6:** LangGraph Postgres-checkpointed workflow + HITL pause/resume + ISO 20022 (`pain.001`) wire settlement engine
- [x] **M7:** n8n edge workflows (Gmail intake, Slack Block Kit approvals, SLA watchdog) + scoped FastMCP server
- [x] **M8:** 100-case golden dataset + 15 OWASP red-team security tests + eval harness + GitHub Actions CI
- [x] **M9:** Next.js Live Command Center (1-click demo presets, workflow graph, citations, approval queue)
- [x] **M10:** Cloud deployment (Neon + Render + Vercel) + ADR + README + 90-second recruiter walkthrough