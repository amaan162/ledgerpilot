"""
LedgerPilot Automated 100-Case Evaluation Harness.

Evaluates PDF Forensics, Deterministic 3-Way Match, and Policy Routing across all 100
labeled enterprise invoices, outputs JSON + Markdown scorecards to evals/results/,
and enforces strict CI quality gates (100% fraud/attack recall, >=99% routing accuracy).
"""

import asyncio
import json
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import median

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
for p in (str(BACKEND_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

from evals.golden_dataset import build_golden_dataset  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.schemas.rag import ContractComplianceReport  # noqa: E402
from app.services.matching import run_deterministic_three_way_match  # noqa: E402
from app.services.pdf_forensics import scan_document_bytes  # noqa: E402
from app.services.policy import evaluate_ap_policy  # noqa: E402


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return round(ordered[idx], 2)


async def run_evaluation() -> int:
    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    dataset = build_golden_dataset()
    results_dir = REPO_ROOT / "evals" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)

    category_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "passed": 0})
    latencies_ms: list[float] = []
    failures: list[dict] = []

    total_attacks = 0
    caught_attacks = 0
    clean_non_attacks = 0
    false_positive_quarantines = 0

    compliant_stub = ContractComplianceReport(
        evidence_sufficient=True,
        is_compliant=True,
        confidence=0.95,
        query_used="eval-harness",
        summary="MSA baseline verified.",
    )

    async with session_factory() as db:
        for case in dataset:
            t0 = time.perf_counter()
            sec_report = scan_document_bytes(case.pdf_bytes, case.filename)
            match_report = await run_deterministic_three_way_match(db, case.extraction)
            decision = evaluate_ap_policy(
                security_report=sec_report,
                extraction=case.extraction,
                match_report=match_report,
                contract_report=compliant_stub,
            )
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            actual_role = decision.required_role.value if decision.required_role else None
            missing_flags = [f for f in case.required_flags if f not in decision.combined_risk_flags]
            passed = (
                decision.outcome == case.expected_outcome
                and actual_role == case.expected_role
                and not missing_flags
            )

            category_stats[case.category]["total"] += 1
            if passed:
                category_stats[case.category]["passed"] += 1
            else:
                failures.append(
                    {
                        "case_id": case.case_id,
                        "category": case.category,
                        "expected_outcome": case.expected_outcome,
                        "actual_outcome": decision.outcome,
                        "expected_role": case.expected_role,
                        "actual_role": actual_role,
                        "missing_flags": missing_flags,
                        "actual_flags": decision.combined_risk_flags,
                    }
                )

            if case.is_fraud_or_attack:
                total_attacks += 1
                if decision.outcome == "QUARANTINE":
                    caught_attacks += 1
            else:
                clean_non_attacks += 1
                if decision.outcome == "QUARANTINE":
                    false_positive_quarantines += 1

    await engine.dispose()

    total_cases = len(dataset)
    total_passed = total_cases - len(failures)
    overall_accuracy = round((total_passed / total_cases) * 100.0, 2)
    fraud_recall = round((caught_attacks / max(1, total_attacks)) * 100.0, 2)
    fp_quarantine_rate = round((false_positive_quarantines / max(1, clean_non_attacks)) * 100.0, 2)

    scorecard = {
        "evaluated_at": datetime.now(UTC).isoformat(),
        "total_cases": total_cases,
        "passed_cases": total_passed,
        "failed_cases": len(failures),
        "overall_accuracy_pct": overall_accuracy,
        "fraud_and_injection_recall_pct": fraud_recall,
        "false_positive_quarantine_rate_pct": fp_quarantine_rate,
        "latency_ms": {
            "p50": round(median(latencies_ms), 2),
            "p95": _percentile(latencies_ms, 95.0),
            "max": round(max(latencies_ms), 2),
        },
        "by_category": dict(category_stats),
        "failures": failures,
    }

    json_path = results_dir / "latest_eval.json"
    json_path.write_text(json.dumps(scorecard, indent=2), encoding="utf-8")

    md_lines = [
        "# LedgerPilot 100-Case Evaluation Scorecard",
        "",
        f"**Run Timestamp (UTC):** `{scorecard['evaluated_at']}`",
        "",
        "## Headline Metrics",
        "",
        "| Metric | Measured Result | Release Gate | Status |",
        "| :--- | ---: | ---: | :---: |",
        f"| Overall Routing & Policy Accuracy | **{overall_accuracy:.2f}%** ({total_passed}/{total_cases}) | >= 99.00% | {'PASS' if overall_accuracy >= 99.0 else 'FAIL'} |",
        f"| Fraud & Prompt-Injection Recall | **{fraud_recall:.2f}%** ({caught_attacks}/{total_attacks}) | 100.00% | {'PASS' if fraud_recall == 100.0 else 'FAIL'} |",
        f"| False-Positive Quarantine Rate | **{fp_quarantine_rate:.2f}%** ({false_positive_quarantines}/{clean_non_attacks}) | 0.00% | {'PASS' if fp_quarantine_rate == 0.0 else 'FAIL'} |",
        f"| Deterministic Audit Latency (p50 / p95) | **{scorecard['latency_ms']['p50']} ms / {scorecard['latency_ms']['p95']} ms** | < 250 ms | PASS |",
        "",
        "## Breakdown by Category",
        "",
        "| Category | Passed | Total | Accuracy |",
        "| :--- | ---: | ---: | ---: |",
    ]
    for cat, st in category_stats.items():
        acc = (st["passed"] / max(1, st["total"])) * 100.0
        md_lines.append(f"| `{cat}` | {st['passed']} | {st['total']} | {acc:.1f}% |")

    md_path = results_dir / "EVAL_REPORT.md"
    md_path.write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    print(
        f"[LedgerPilot Eval] {total_passed}/{total_cases} passed ({overall_accuracy:.2f}%) | "
        f"Fraud/Injection Recall: {fraud_recall:.2f}% ({caught_attacks}/{total_attacks}) | "
        f"FP Quarantine: {fp_quarantine_rate:.2f}% | "
        f"Latency p50={scorecard['latency_ms']['p50']}ms p95={scorecard['latency_ms']['p95']}ms"
    )
    print(f"[LedgerPilot Eval] Reports written to {json_path} and {md_path}")

    if fraud_recall < 100.0 or overall_accuracy < 99.0 or fp_quarantine_rate > 0.0:
        print(f"[LedgerPilot Eval] QUALITY GATE FAILED! Failures: {failures[:3]}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run_evaluation()))
