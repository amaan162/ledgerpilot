# LedgerPilot 100-Case Evaluation Scorecard

**Run Timestamp (UTC):** `2026-11-25T10:59:53.185662+00:00`

## Headline Metrics

| Metric | Measured Result | Release Gate | Status |
| :--- | ---: | ---: | :---: |
| Overall Routing & Policy Accuracy | **100.00%** (100/100) | >= 99.00% | PASS |
| Fraud & Prompt-Injection Recall | **100.00%** (25/25) | 100.00% | PASS |
| False-Positive Quarantine Rate | **0.00%** (0/75) | 0.00% | PASS |
| Deterministic Audit Latency (p50 / p95) | **5.53 ms / 7.23 ms** | < 250 ms | PASS |

## Breakdown by Category

| Category | Passed | Total | Accuracy |
| :--- | ---: | ---: | ---: |
| `CLEAN_AUTO_APPROVE` | 20 | 20 | 100.0% |
| `CLEAN_MANAGER_HITL` | 15 | 15 | 100.0% |
| `CLEAN_CONTROLLER_HITL` | 10 | 10 | 100.0% |
| `GR_OVERBILLING` | 10 | 10 | 100.0% |
| `PRICE_OR_SURCHARGE_VARIANCE` | 10 | 10 | 100.0% |
| `ARITHMETIC_TAMPERING` | 10 | 10 | 100.0% |
| `IBAN_WIRE_FRAUD` | 10 | 10 | 100.0% |
| `OWASP_PROMPT_INJECTION` | 15 | 15 | 100.0% |
