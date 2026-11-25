"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Cpu,
  Inbox,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import type {
  AuditIntegrityReport,
  DeadLetterItem,
  EvalScorecard,
  MetricsOverview,
  Persona,
  SecurityPosture,
} from "@/lib/api";

export function FinOpsAnalytics({
  metrics,
  evalScorecard,
  deadLetters,
  dlqForbidden,
  securityPosture,
  postureForbidden,
  auditReport,
  verifyingAudit,
  onVerifyAudit,
  onResolveDlq,
  persona,
}: {
  metrics: MetricsOverview | null;
  evalScorecard: EvalScorecard | null;
  deadLetters: DeadLetterItem[];
  dlqForbidden: boolean;
  securityPosture: SecurityPosture | null;
  postureForbidden: boolean;
  auditReport: AuditIntegrityReport | null;
  verifyingAudit: boolean;
  onVerifyAudit: () => Promise<void>;
  onResolveDlq: (jobId: string, note: string) => Promise<void>;
  persona: Persona;
}) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveNotes, setResolveNotes] = useState<Record<string, string>>({});

  const staged = metrics?.payment_staged_count ?? 0;
  const awaiting = (metrics?.awaiting_approval_count ?? 0) + (metrics?.escalated_sla_count ?? 0);
  const fraud = metrics?.quarantined_fraud_count ?? 0;
  const rejected = metrics?.rejected_count ?? 0;
  const total = Math.max(1, staged + awaiting + fraud + rejected);

  const slices = [
    { label: "ISO 20022 Staged", value: staged, color: "#10b981", dot: "bg-emerald-400" },
    { label: "HITL / Escalated", value: awaiting, color: "#38bdf8", dot: "bg-sky-400" },
    { label: "Fraud Quarantined", value: fraud, color: "#f43f5e", dot: "bg-rose-400" },
    { label: "Rejected", value: rejected, color: "#64748b", dot: "bg-slate-400" },
  ];

  // SVG Donut Geometry
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const segments = slices.reduce<
    Array<{ label: string; color: string; dash: number; offset: number }>
  >((acc, slice) => {
    const prevSum = acc.reduce((s, item) => s + item.dash, 0);
    const dash = (slice.value / total) * circumference;
    acc.push({ label: slice.label, color: slice.color, dash, offset: -prevSum });
    return acc;
  }, []);

  const categories = Object.entries(evalScorecard?.by_category || {});

  const budget = securityPosture?.reliability.daily_llm_budget;
  const spentNum = Number(budget?.spent_today_usd || 0);
  const limitNum = Math.max(0.01, Number(budget?.daily_limit_usd || 25));
  const budgetPct = Math.min(100, (spentNum / limitNum) * 100);

  const handleResolveClick = async (jobId: string) => {
    const note =
      resolveNotes[jobId]?.trim() ||
      `Triaged and resolved via Control Plane by ${persona.label} (${persona.roleTitle}).`;
    setResolvingId(jobId);
    try {
      await onResolveDlq(jobId, note);
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Row 1: MNC Security & Reliability Posture + Cryptographic Audit Verifier */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              MNC Security Posture, Circuit Breakers &amp; Cryptographic Audit Verifier
            </h3>
            <p className="text-xs text-slate-400">
              Live SOC 2 / SOX 404 controls, OFAC screening, HMAC-SHA256 ledger integrity, and
              upstream resilience telemetry.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {securityPosture && !postureForbidden && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${
                  securityPosture.status === "HEALTHY"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                POSTURE: {securityPosture.status}
              </span>
            )}
            {!postureForbidden && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                disabled={verifyingAudit}
                onClick={() => void onVerifyAudit()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50"
              >
                {verifyingAudit ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5 text-sky-400" />
                )}
                {verifyingAudit ? "Verifying HMAC Seals..." : "Verify Cryptographic Audit Chain"}
              </motion.button>
            )}
          </div>
        </div>

        {postureForbidden ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-amber-500/30 bg-amber-950/20 p-6 text-center">
            <Lock className="mb-2 h-6 w-6 text-amber-400" />
            <div className="text-sm font-semibold text-amber-200">
              Controller / Admin Clearance Required (HTTP 403)
            </div>
            <p className="mt-1 max-w-lg text-xs text-amber-200/75">
              Security posture telemetry and cryptographic HMAC audit verification are restricted to{" "}
              <strong>Elena Rostova (Corporate Controller)</strong> and{" "}
              <strong>Amaan Shaikh (Platform Admin)</strong>. Switch personas in the header to
              inspect live circuit breakers and run the ledger verifier.
            </p>
          </div>
        ) : !securityPosture ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">
            Loading live security posture...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Control Enforcement Pills */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              <ControlBadge
                label="SOX 404 Segregation of Duties"
                status={securityPosture.controls.sox_404_segregation_of_duties}
              />
              <ControlBadge
                label="OFAC Sanctions IBAN Block"
                status={securityPosture.controls.ofac_sanctions_iban_screening}
              />
              <ControlBadge
                label="Append-Only Audit Trigger"
                status={securityPosture.controls.immutable_audit_trigger}
              />
              <ControlBadge
                label="HMAC-SHA256 Audit Seals"
                status={securityPosture.controls.cryptographic_audit_seals}
              />
            </div>

            {/* Circuit Breakers + Daily LLM Budget Guard */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 lg:col-span-7">
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                    <Cpu className="h-3.5 w-3.5 text-sky-400" />
                    Upstream Circuit Breakers
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    Rate-Limit Buckets: {securityPosture.controls.rate_limiter_active_buckets} ·
                    HMAC Replay: {securityPosture.controls.hmac_webhook_replay_window_s}s
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {securityPosture.reliability.circuit_breakers.map((cb) => {
                    const closed = cb.state === "CLOSED";
                    return (
                      <div
                        key={cb.name}
                        className="rounded-lg border border-slate-800 bg-slate-900/70 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold text-white">
                            {cb.name}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                              closed
                                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                                : "border-rose-500/40 bg-rose-500/15 text-rose-300"
                            }`}
                          >
                            {cb.state}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-slate-400">
                          <span>
                            Failures: {cb.failure_count}/{cb.failure_threshold}
                          </span>
                          <span>Trips: {cb.total_trips}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 lg:col-span-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                    <Activity className="h-3.5 w-3.5 text-emerald-400" />
                    FinOps Daily LLM Spend Ceiling
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    {budget?.utc_date || "UTC"}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline justify-between font-mono">
                  <span className="text-lg font-bold text-emerald-300">
                    ${Number(budget?.spent_today_usd || 0).toFixed(4)}
                  </span>
                  <span className="text-xs text-slate-400">
                    / ${budget?.daily_limit_usd || "25.00"} daily cap
                  </span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(2, budgetPct)}%` }}
                    transition={{ duration: 0.45 }}
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-sky-400"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-slate-400">
                  <span>pgvector HNSW: {securityPosture.reliability.pgvector_extension ? "ONLINE" : "OFFLINE"}</span>
                  <span>Remaining: ${Number(budget?.remaining_usd || 25).toFixed(4)}</span>
                </div>
              </div>
            </div>

            {/* Live Cryptographic Audit Integrity Report */}
            {auditReport && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 text-xs ${
                  auditReport.verified
                    ? "border-emerald-500/40 bg-emerald-950/25 text-emerald-200"
                    : "border-rose-500/50 bg-rose-950/35 text-rose-200"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {auditReport.verified ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
                  )}
                  <div>
                    <span className="font-semibold">
                      {auditReport.verified
                        ? "Cryptographic Audit Chain Verified — Zero Tampering Detected"
                        : `TAMPER ALERT — ${auditReport.tampered_row_ids.length} corrupted row(s)!`}
                    </span>
                    <span className="ml-2 font-mono text-[11px] opacity-80">
                      Checked {auditReport.total_rows_checked} rows ·{" "}
                      {auditReport.signed_rows_valid} valid HMAC-SHA256 seals ·{" "}
                      {auditReport.legacy_unsigned_rows} pre-seal legacy rows
                    </span>
                  </div>
                </div>
                <span className="rounded bg-slate-950/60 px-2 py-0.5 font-mono text-[10px] uppercase">
                  HMAC-SHA256
                </span>
              </motion.div>
            )}
          </div>
        )}
      </div>

      {/* Row 2: Outcome Distribution Donut + 100-Case Eval Breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Donut Card */}
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5 lg:col-span-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <BarChart3 className="h-4 w-4 text-emerald-400" />
              Live Pipeline Outcome Mix
            </h3>
            <span className="font-mono text-xs text-slate-400">
              {metrics?.total_invoices ?? 0} total
            </span>
          </div>

          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <div className="relative h-40 w-40 shrink-0">
              <svg viewBox="0 0 144 144" className="h-full w-full -rotate-90">
                <circle
                  cx="72"
                  cy="72"
                  r={radius}
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth="16"
                />
                {segments.map((seg, idx) =>
                  seg.dash > 0 ? (
                    <motion.circle
                      key={seg.label}
                      cx="72"
                      cy="72"
                      r={radius}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth="16"
                      strokeDasharray={`${seg.dash} ${circumference}`}
                      strokeDashoffset={seg.offset}
                      strokeLinecap="butt"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: idx * 0.1, duration: 0.45 }}
                    />
                  ) : null
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-xl font-bold text-white">
                  {Math.round((staged / total) * 100)}%
                </span>
                <span className="text-[10px] uppercase tracking-wider text-slate-400">
                  Settled
                </span>
              </div>
            </div>

            <div className="w-full space-y-2.5">
              {slices.map((s) => (
                <div key={s.label} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                    <span className="text-slate-300">{s.label}</span>
                  </div>
                  <span className="font-mono font-semibold text-white">{s.value}</span>
                </div>
              ))}
              <div className="mt-3 border-t border-slate-800 pt-2.5 text-[11px] text-slate-400">
                Operating unit economics:{" "}
                <span className="font-mono text-emerald-300">
                  ~$
                  {metrics && metrics.total_invoices > 0
                    ? (Number(metrics.total_llm_cost_usd) / metrics.total_invoices).toFixed(4)
                    : "0.0016"}{" "}
                  / invoice
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 100-Case Eval Scorecard Breakdown */}
        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5 lg:col-span-7">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="h-4 w-4 text-sky-400" />
              Automated 100-Case Golden Eval &amp; OWASP Red-Team Gate
            </h3>
            {evalScorecard?.latency_ms && (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] text-emerald-300">
                p50 {evalScorecard.latency_ms.p50}ms · p95 {evalScorecard.latency_ms.p95}ms
              </span>
            )}
          </div>

          {categories.length === 0 ? (
            <p className="text-xs text-slate-400">
              Run evals/run_eval.py to populate the category scorecard.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {categories.map(([cat, stats], idx) => {
                const pct = Math.round((stats.passed / Math.max(1, stats.total)) * 100);
                const isAttack = cat.includes("FRAUD") || cat.includes("INJECTION");
                return (
                  <div
                    key={cat}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate font-mono text-[11px] font-semibold text-slate-200">
                        {isAttack ? (
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        )}
                        {cat}
                      </span>
                      <span className="font-mono text-xs font-bold text-emerald-300">
                        {stats.passed}/{stats.total}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: idx * 0.05, duration: 0.5 }}
                        className={`h-full rounded-full ${
                          isAttack
                            ? "bg-gradient-to-r from-rose-500 to-emerald-400"
                            : "bg-emerald-500"
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Row 3: RBAC-Protected Dead-Letter Queue Monitor with Auditable Resolution */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Inbox className="h-4 w-4 text-amber-400" />
              Webhook Dead-Letter Queue (DLQ) — Reliability &amp; Poison-Payload Capture
            </h3>
            <p className="text-xs text-slate-400">
              Restricted to Corporate Controller &amp; Platform Admin roles via backend FastAPI RBAC.
            </p>
          </div>
          <span className="rounded bg-slate-800 px-2.5 py-1 font-mono text-[11px] text-slate-300">
            Active Role: {persona.key}
          </span>
        </div>

        {dlqForbidden ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-amber-500/30 bg-amber-950/20 p-8 text-center">
            <Lock className="mb-2 h-7 w-7 text-amber-400" />
            <div className="text-sm font-semibold text-amber-200">
              HTTP 403 Forbidden — Backend RBAC Enforced
            </div>
            <p className="mt-1 max-w-md text-xs text-amber-200/75">
              <strong>{persona.label}</strong> ({persona.roleTitle}) does not have clearance to
              inspect webhook dead-letter payloads. Switch the top-right persona to{" "}
              <strong>Elena Rostova (Corporate Controller)</strong> or{" "}
              <strong>Amaan Shaikh (Admin)</strong> to unlock this queue live.
            </p>
          </div>
        ) : deadLetters.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Zero poison webhook payloads in the Dead-Letter Queue.
          </div>
        ) : (
          <div className="space-y-2.5">
            {deadLetters.map((job) => (
              <div
                key={job.id}
                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-300">
                        {job.source}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          job.resolved
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {job.resolved ? "RESOLVED" : "UNRESOLVED"}
                      </span>
                      <span className="truncate font-mono text-slate-200">
                        {job.idempotency_key}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-rose-300">
                      {job.error_message}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500">
                    {new Date(job.created_at).toLocaleString()}
                  </span>
                </div>

                {!job.resolved && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-2.5">
                    <input
                      type="text"
                      value={resolveNotes[job.id] || ""}
                      onChange={(e) =>
                        setResolveNotes((prev) => ({ ...prev, [job.id]: e.target.value }))
                      }
                      placeholder="Audit resolution note (optional)..."
                      className="min-w-[220px] flex-1 rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      disabled={resolvingId === job.id}
                      onClick={() => void handleResolveClick(job.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      {resolvingId === job.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      Mark Resolved
                    </motion.button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ControlBadge({ label, status }: { label: string; status: string }) {
  const ok = status === "ENFORCED" || status === "VERIFIED";
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/75 px-3 py-2.5">
      <span className="truncate text-[11px] font-medium text-slate-300">{label}</span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
          ok
            ? "bg-emerald-500/15 text-emerald-300"
            : "bg-rose-500/20 text-rose-300"
        }`}
      >
        {status}
      </span>
    </div>
  );
}
