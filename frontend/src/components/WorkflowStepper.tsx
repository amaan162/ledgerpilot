"use client";

import { Fragment } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
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
    done: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    paused: "border-cyan-500/50 bg-cyan-500/12 text-cyan-700 dark:text-cyan-200",
    danger: "border-rose-500/45 bg-rose-500/12 text-rose-700 dark:text-rose-200",
    idle: "border-slate-200 bg-white/75 text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400",
  };

  return (
    <div className="tactile-well rounded-xl p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          LangGraph PostgreSQL-Checkpointed State Machine
        </span>
        <span className="rounded-md bg-white/85 px-2 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-900/5 dark:bg-slate-900 dark:text-slate-400 dark:ring-white/10">
          thread: {invoice.thread_id}
        </span>
      </div>

      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr]">
        {nodes.map((node, index) => {
          const Icon = node.Icon;
          return (
            <Fragment key={`${invoice.id}-${node.id}`}>
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.045, duration: 0.18, ease: "easeOut" }}
                className={`relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-xl border px-3 py-2.5 transition-colors ${badgeStyles[node.status]}`}
              >
                {node.status === "paused" && (
                  <motion.span
                    animate={{ opacity: [0.35, 1, 0.35] }}
                    transition={{ repeat: Infinity, duration: 1.8 }}
                    className="absolute top-2.5 right-2.5 h-2 w-2 rounded-full bg-cyan-500"
                  />
                )}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-xs font-bold">{node.title}</span>
                  </div>
                  {node.status !== "paused" && (
                    <span className="shrink-0 font-mono text-[9px] opacity-55">
                      0{index + 1}
                    </span>
                  )}
                </div>
                <span className="truncate font-mono text-[10px] opacity-80">{node.sub}</span>
              </motion.div>

              {index < nodes.length - 1 && (
                <div className="hidden items-center justify-center sm:flex">
                  <ArrowRight className="h-3.5 w-3.5 text-slate-400 dark:text-slate-600" />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}