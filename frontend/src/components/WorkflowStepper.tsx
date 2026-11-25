"use client";

import { motion } from "framer-motion";
import {
  CheckCircle2,
  Clock,
  FileCode2,
  FileSearch,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { InvoiceDetail } from "@/lib/api";

interface WorkflowStepperProps {
  invoice: InvoiceDetail;
}

type NodeStatus = "done" | "warn" | "danger" | "paused" | "idle";

export function WorkflowStepper({ invoice }: WorkflowStepperProps) {
  const secSuspicious = Boolean(invoice.security_report?.is_suspicious);
  const matchClean = Boolean(invoice.match_report?.is_clean_match);
  const hasRag = (invoice.rag_citations?.length ?? 0) > 0;

  let terminalLabel = "ISO 20022 Wire";
  let terminalStatus: NodeStatus = "idle";
  let TerminalIcon = FileCode2;

  if (invoice.status === "PAYMENT_STAGED") {
    terminalLabel = "ISO 20022 Staged";
    terminalStatus = "done";
    TerminalIcon = CheckCircle2;
  } else if (invoice.status === "QUARANTINED_FRAUD_RISK") {
    terminalLabel = "Quarantined";
    terminalStatus = "danger";
    TerminalIcon = ShieldAlert;
  } else if (invoice.status === "AWAITING_APPROVAL" || invoice.status === "ESCALATED_SLA") {
    terminalLabel = "HITL Paused";
    terminalStatus = "paused";
    TerminalIcon = Clock;
  } else if (invoice.status === "REJECTED") {
    terminalLabel = "Rejected";
    terminalStatus = "danger";
    TerminalIcon = XCircle;
  }

  const nodes: Array<{
    id: string;
    title: string;
    sub: string;
    status: NodeStatus;
    Icon: typeof ShieldCheck;
  }> = [
    {
      id: "forensics",
      title: "PDF Forensics",
      sub: secSuspicious
        ? `Risk ${invoice.security_report?.risk_score ?? 100}/100`
        : "Clean Scan",
      status: secSuspicious ? "danger" : "done",
      Icon: secSuspicious ? ShieldAlert : ShieldCheck,
    },
    {
      id: "extract",
      title: "Gemini Vision",
      sub: invoice.invoice_number || "Structured JSON",
      status: invoice.invoice_number ? "done" : "idle",
      Icon: Sparkles,
    },
    {
      id: "match",
      title: "Decimal 3-Way",
      sub: matchClean ? "Exact Match" : `${invoice.match_report?.risk_flags?.length ?? 0} Flags`,
      status: matchClean
        ? "done"
        : invoice.match_report?.iban_verified === false
          ? "danger"
          : "warn",
      Icon: Scale,
    },
    {
      id: "rag",
      title: "pgvector RAG",
      sub: hasRag ? `${invoice.rag_citations.length} MSA Clause(s)` : "Escalated",
      status: hasRag ? "done" : "warn",
      Icon: FileSearch,
    },
    {
      id: "terminal",
      title: terminalLabel,
      sub: invoice.settlement_reference
        ? invoice.settlement_reference.slice(-12)
        : invoice.status.replaceAll("_", " "),
      status: terminalStatus,
      Icon: TerminalIcon,
    },
  ];

  const badgeStyles: Record<NodeStatus, string> = {
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_20px_-8px_rgba(16,185,129,0.5)]",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    paused:
      "border-sky-400/60 bg-sky-500/15 text-sky-200 shadow-[0_0_24px_-6px_rgba(56,189,248,0.6)]",
    danger:
      "border-rose-500/60 bg-rose-500/15 text-rose-200 shadow-[0_0_24px_-6px_rgba(244,63,94,0.55)]",
    idle: "border-slate-800 bg-slate-900/60 text-slate-400",
  };

  return (
    <div className="rounded-xl border border-slate-800/90 bg-slate-950/70 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          LangGraph PostgreSQL-Checkpointed State Machine
        </span>
        <span className="rounded bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-400">
          thread: {invoice.thread_id}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
        {nodes.map((node, index) => {
          const Icon = node.Icon;
          return (
            <motion.div
              key={`${invoice.id}-${node.id}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.06, duration: 0.25 }}
              whileHover={{ y: -2 }}
              className="relative flex items-center"
            >
              <div
                className={`relative flex w-full flex-col gap-1 overflow-hidden rounded-lg border px-3 py-2.5 transition-colors ${badgeStyles[node.status]}`}
              >
                {node.status === "paused" && (
                  <motion.span
                    animate={{ opacity: [0.35, 1, 0.35] }}
                    transition={{ repeat: Infinity, duration: 1.8 }}
                    className="absolute top-2 right-2 h-2 w-2 rounded-full bg-sky-400"
                  />
                )}
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate text-xs font-semibold">{node.title}</span>
                </div>
                <span className="truncate font-mono text-[11px] opacity-80">{node.sub}</span>
              </div>
              {index < nodes.length - 1 && (
                <div className="hidden px-1 font-mono text-xs text-slate-600 sm:block">→</div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
