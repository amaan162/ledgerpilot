"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { SpotlightCard } from "@/components/PrecisionUI";

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);

  const staged = metrics?.payment_staged_count ?? 0;
  const awaiting = (metrics?.awaiting_approval_count ?? 0) + (metrics?.escalated_sla_count ?? 0);
  const fraud = metrics?.quarantined_fraud_count ?? 0;
  const rejected = metrics?.rejected_count ?? 0;
  const rawTotal = staged + awaiting + fraud + rejected;
  const total = Math.max(1, rawTotal);

  const slices = [
    { label: "ISO 20022 Staged", short: "Settled", value: staged, color: "#10b981", dot: "bg-emerald-500" },
    { label: "HITL / Escalated", short: "In HITL", value: awaiting, color: "#06b6d4", dot: "bg-cyan-500" },
    { label: "Fraud Quarantined", short: "Blocked", value: fraud, color: "#f43f5e", dot: "bg-rose-500" },
    { label: "Rejected", short: "Rejected", value: rejected, color: "#64748b", dot: "bg-slate-400" },
  ];

  const radius = 56;
  const circumference = round2(2 * Math.PI * radius);
  const segments = slices.reduce<
    Array<{ label: string; color: string; dash: number; offset: number }>
  >((acc, slice) => {
    const prevSum = acc.reduce((s, item) => s + item.dash, 0);
    const dash = round2((slice.value / total) * circumference);
    acc.push({ label: slice.label, color: slice.color, dash, offset: round2(-prevSum) });
    return acc;
  }, []);

  const activeSlice = slices.find((s) => s.label === hoveredSlice) ?? null;
  const centerPct = activeSlice
    ? Math.round((activeSlice.value / total) * 100)
    : rawTotal > 0
      ? Math.round((staged / total) * 100)
      : 0;
  const centerLabel = activeSlice ? activeSlice.short : "Settled";

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
    <div className="space-y-5">
      {/* Row 1: MNC Security Posture & Cryptographic Audit Verifier */}
      <SpotlightCard tone="emerald" className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              MNC Security Posture, Circuit Breakers &amp; Cryptographic Audit Verifier
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Live SOC 2 / SOX 404 controls, OFAC screening, HMAC-SHA256 ledger integrity, and
              upstream resilience telemetry.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {securityPosture && !postureForbidden && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${
                  securityPosture.status === "HEALTHY"
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    securityPosture.status === "HEALTHY" ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                />
                POSTURE: {securityPosture.status}
              </span>
            )}
            {!postureForbidden && (
              <button
                type="button"
                disabled={verifyingAudit}
                onClick={() => void onVerifyAudit()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-sky-500/35 bg-sky-500/12 px-3 py-1.5 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-500/20 active:opacity-90 disabled:opacity-50 dark:text-sky-200"
              >
                {verifyingAudit ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5 text-sky-500" />
                )}
                {verifyingAudit ? "Verifying HMAC Seals..." : "Verify Cryptographic Audit Chain"}
              </button>
            )}
          </div>
        </div>

        {postureForbidden ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-amber-500/35 bg-amber-500/8 p-6 text-center">
            <Lock className="mb-2 h-6 w-6 text-amber-500" />
            <div className="text-sm font-bold text-amber-800 dark:text-amber-200">
              Controller / Admin Clearance Required (HTTP 403)
            </div>
            <p className="mt-1 max-w-lg text-xs text-amber-800/80 dark:text-amber-200/75">
              Security posture telemetry and cryptographic HMAC verification are restricted to{" "}
              <strong>Elena Rostova (Corporate Controller)</strong> and{" "}
              <strong>Amaan Shaikh (Platform Admin)</strong>. Switch roles in the top bar to inspect
              circuit breakers and run the ledger verifier.
            </p>
          </div>
        ) : !securityPosture ? (
          <div className="tactile-well rounded-xl p-4 text-xs text-slate-500 dark:text-slate-400">
            Loading live security posture...
          </div>
        ) : (
          <div className="space-y-4">
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

            <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
              <div className="tactile-well flex h-full flex-col justify-between rounded-xl p-4 lg:col-span-7">
                <div>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      <Cpu className="h-3.5 w-3.5 text-sky-500" />
                      Upstream Circuit Breakers
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      Buckets: {securityPosture.controls.rate_limiter_active_buckets} &middot;
                      Replay: {securityPosture.controls.hmac_webhook_replay_window_s}s
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {securityPosture.reliability.circuit_breakers.map((cb) => {
                      const closed = cb.state === "CLOSED";
                      return (
                        <div
                          key={cb.name}
                          className="rounded-xl border border-slate-200/80 bg-white/80 p-3 dark:border-slate-800 dark:bg-slate-900/75"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                              {cb.name}
                            </span>
                            <span
                              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                                closed
                                  ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                  : "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300"
                              }`}
                            >
                              {cb.state}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-slate-500 dark:text-slate-400">
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
              </div>

              <div className="tactile-well flex h-full flex-col justify-between rounded-xl p-4 lg:col-span-5">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      <Activity className="h-3.5 w-3.5 text-emerald-500" />
                      Daily LLM Spend Ceiling
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {budget?.utc_date || "UTC"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between font-mono">
                    <span className="text-lg font-bold text-emerald-600 tabular-nums dark:text-emerald-300">
                      ${Number(budget?.spent_today_usd || 0).toFixed(4)}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      / ${budget?.daily_limit_usd || "25.00"} daily cap
                    </span>
                  </div>
                  <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(2, budgetPct)}%` }}
                      transition={{ duration: 0.45, ease: "easeOut" }}
                      className="h-full rounded-full bg-linear-to-r from-emerald-500 to-sky-400"
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2.5 font-mono text-[11px] text-slate-500 dark:border-slate-800/80 dark:text-slate-400">
                  <span>
                    pgvector HNSW:{" "}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {securityPosture.reliability.pgvector_extension ? "ONLINE" : "OFFLINE"}
                    </strong>
                  </span>
                  <span>Remaining: ${Number(budget?.remaining_usd || 25).toFixed(4)}</span>
                </div>
              </div>
            </div>

            {auditReport && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.16 }}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 text-xs ${
                  auditReport.verified
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                    : "border-rose-500/45 bg-rose-500/12 text-rose-800 dark:text-rose-200"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {auditReport.verified ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 shrink-0 text-rose-500" />
                  )}
                  <div>
                    <span className="font-bold">
                      {auditReport.verified
                        ? "Cryptographic Audit Chain Verified \u2014 Zero Tampering Detected"
                        : `TAMPER ALERT \u2014 ${auditReport.tampered_row_ids.length} corrupted row(s)!`}
                    </span>
                    <span className="ml-2 font-mono text-[11px] opacity-80">
                      Checked {auditReport.total_rows_checked} rows &middot;{" "}
                      {auditReport.signed_rows_valid} valid HMAC-SHA256 seals &middot;{" "}
                      {auditReport.legacy_unsigned_rows} pre-seal legacy rows
                    </span>
                  </div>
                </div>
                <span className="rounded bg-white/70 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase dark:bg-slate-950/60">
                  HMAC-SHA256
                </span>
              </motion.div>
            )}
          </div>
        )}
      </SpotlightCard>

      {/* Row 2: Equal-Height Interactive Outcome Donut + Golden Eval Scorecard */}
      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-12">
        <SpotlightCard
          tone="fuchsia"
          className="flex h-full flex-col justify-between p-5 lg:col-span-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
              <BarChart3 className="h-4 w-4 text-fuchsia-500" />
              Live Pipeline Outcome Mix
            </h3>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
              {metrics?.total_invoices ?? 0} total
            </span>
          </div>

          <div className="my-auto flex flex-col items-center gap-6 sm:flex-row">
            <div
              className="relative h-40 w-40 shrink-0"
              onMouseLeave={() => setHoveredSlice(null)}
            >
              <svg viewBox="0 0 144 144" className="h-full w-full -rotate-90">
                <circle
                  cx="72"
                  cy="72"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.14}
                  strokeWidth="16"
                  className="text-slate-400 dark:text-slate-600"
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
                      strokeWidth={hoveredSlice === seg.label ? 19 : 16}
                      strokeDasharray={`${seg.dash} ${circumference}`}
                      strokeDashoffset={seg.offset}
                      strokeLinecap="butt"
                      onMouseEnter={() => setHoveredSlice(seg.label)}
                      className="cursor-pointer transition-[stroke-width] duration-150"
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity:
                          hoveredSlice === null || hoveredSlice === seg.label ? 1 : 0.3,
                      }}
                      transition={{ delay: idx * 0.05, duration: 0.2 }}
                    />
                  ) : null
                )}
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={centerLabel}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    className="flex flex-col items-center"
                  >
                    <span className="font-mono text-xl leading-6 font-bold text-slate-950 tabular-nums dark:text-white">
                      {centerPct}%
                    </span>
                    <span className="text-[10px] leading-4 font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      {centerLabel}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            <div className="w-full space-y-1.5">
              {slices.map((s) => {
                const isFocused = hoveredSlice === s.label;
                return (
                  <div
                    key={s.label}
                    onMouseEnter={() => setHoveredSlice(s.label)}
                    onMouseLeave={() => setHoveredSlice(null)}
                    className={`flex cursor-pointer items-center justify-between rounded-lg px-2 py-1 text-xs transition-colors ${
                      isFocused
                        ? "bg-slate-900/5 dark:bg-white/6"
                        : "hover:bg-slate-900/4 dark:hover:bg-white/4"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                      <span className="text-slate-600 dark:text-slate-300">{s.label}</span>
                    </div>
                    <span className="font-mono font-bold text-slate-900 tabular-nums dark:text-white">
                      {s.value}
                    </span>
                  </div>
                );
              })}
              <div className="mt-2.5 border-t border-slate-200/80 px-2 pt-2.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                Unit economics:{" "}
                <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300">
                  ~$
                  {metrics && metrics.total_invoices > 0
                    ? (Number(metrics.total_llm_cost_usd) / metrics.total_invoices).toFixed(4)
                    : "0.0016"}{" "}
                  / invoice
                </span>
              </div>
            </div>
          </div>
        </SpotlightCard>

        <SpotlightCard
          tone="violet"
          className="flex h-full flex-col justify-between p-5 lg:col-span-7"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
              <Sparkles className="h-4 w-4 text-violet-500" />
              Automated Golden Eval &amp; OWASP Red-Team Gate
            </h3>
            {evalScorecard?.latency_ms && (
              <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                p50 {evalScorecard.latency_ms.p50}ms &middot; p95 {evalScorecard.latency_ms.p95}ms
              </span>
            )}
          </div>

          {categories.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Run evals/run_eval.py to populate the category scorecard.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {categories.map(([cat, stats], idx) => {
                const pct = Math.round((stats.passed / Math.max(1, stats.total)) * 100);
                const isAttack = cat.includes("FRAUD") || cat.includes("INJECTION");
                return (
                  <div key={cat} className="tactile-well rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 truncate font-mono text-[11px] font-bold text-slate-800 dark:text-slate-200">
                        {isAttack ? (
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        )}
                        {cat}
                      </span>
                      <span className="font-mono text-xs font-bold text-emerald-700 tabular-nums dark:text-emerald-300">
                        {stats.passed}/{stats.total}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: idx * 0.04, duration: 0.45, ease: "easeOut" }}
                        className={`h-full rounded-full ${
                          isAttack
                            ? "bg-linear-to-r from-rose-500 to-emerald-400"
                            : "bg-emerald-500"
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SpotlightCard>
      </div>

      {/* Row 3: RBAC-Protected Dead-Letter Queue */}
      <SpotlightCard tone="amber" className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
              <Inbox className="h-4 w-4 text-amber-500" />
              Webhook Dead-Letter Queue (DLQ) &mdash; Poison-Payload Capture
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Restricted to Corporate Controller &amp; Platform Admin roles via FastAPI RBAC.
            </p>
          </div>
          <span className="tactile-well rounded-lg px-2.5 py-1 font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-300">
            Active Role: {persona.key}
          </span>
        </div>

        {dlqForbidden ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-amber-500/35 bg-amber-500/8 p-8 text-center">
            <Lock className="mb-2 h-7 w-7 text-amber-500" />
            <div className="text-sm font-bold text-amber-800 dark:text-amber-200">
              HTTP 403 Forbidden &mdash; Backend RBAC Enforced
            </div>
            <p className="mt-1 max-w-md text-xs text-amber-800/80 dark:text-amber-200/75">
              <strong>{persona.label}</strong> ({persona.roleTitle}) does not have clearance to
              inspect dead-letter payloads. Switch the top-right identity to{" "}
              <strong>Elena Rostova (Corporate Controller)</strong> or{" "}
              <strong>Amaan Shaikh (Admin)</strong> to unlock this queue.
            </p>
          </div>
        ) : deadLetters.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Zero poison webhook payloads in the Dead-Letter Queue.
          </div>
        ) : (
          <div className="space-y-2.5">
            {deadLetters.map((job) => (
              <div key={job.id} className="tactile-well rounded-xl p-3.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-700 dark:text-amber-300">
                        {job.source}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                          job.resolved
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                        }`}
                      >
                        {job.resolved ? "RESOLVED" : "UNRESOLVED"}
                      </span>
                      <span className="truncate font-mono font-semibold text-slate-900 dark:text-slate-200">
                        {job.idempotency_key}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-rose-600 dark:text-rose-300">
                      {job.error_message}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">
                    {new Date(job.created_at).toLocaleString()}
                  </span>
                </div>

                {!job.resolved && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2.5 dark:border-slate-800/80">
                    <input
                      type="text"
                      value={resolveNotes[job.id] || ""}
                      onChange={(e) =>
                        setResolveNotes((prev) => ({ ...prev, [job.id]: e.target.value }))
                      }
                      placeholder="Audit resolution note (optional)..."
                      className="min-w-56 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500"
                    />
                    <button
                      type="button"
                      disabled={resolvingId === job.id}
                      onClick={() => void handleResolveClick(job.id)}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-800 transition-colors hover:bg-emerald-500/25 active:opacity-90 disabled:opacity-50 dark:text-emerald-200"
                    >
                      {resolvingId === job.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      Mark Resolved
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SpotlightCard>
    </div>
  );
}

function ControlBadge({ label, status }: { label: string; status: string }) {
  const ok = status === "ENFORCED" || status === "VERIFIED";
  return (
    <div className="tactile-well flex items-center justify-between gap-2 rounded-xl px-3 py-2.5">
      <span className="truncate text-[11px] font-semibold text-slate-700 dark:text-slate-300">
        {label}
      </span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
          ok
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-rose-500/20 text-rose-700 dark:text-rose-300"
        }`}
      >
        {status}
      </span>
    </div>
  );
}