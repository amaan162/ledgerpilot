"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileCode2,
  FileUp,
  History,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Sparkles,
  UserCheck,
  XCircle,
} from "lucide-react";
import {
  api,
  ApiError,
  DEMO_PERSONAS,
  type ApprovalRequestItem,
  type AuditIntegrityReport,
  type DeadLetterItem,
  type DemoPreset,
  type EvalScorecard,
  type InvoiceDetail,
  type InvoiceSummary,
  type MetricsOverview,
  type Persona,
  type SecurityPosture,
  type VendorRecord,
} from "@/lib/api";
import { FinOpsAnalytics } from "@/components/FinOpsAnalytics";
import { ToastStack, type ToastItem } from "@/components/ToastStack";
import { VendorContractHub } from "@/components/VendorContractHub";
import { WorkflowStepper } from "@/components/WorkflowStepper";

const STATUS_BADGE: Record<string, string> = {
  PAYMENT_STAGED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  AUTO_APPROVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  AWAITING_APPROVAL: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  ESCALATED_SLA: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  QUARANTINED_FRAUD_RISK: "bg-rose-500/20 text-rose-300 border-rose-500/50",
  REJECTED: "bg-slate-700/60 text-slate-300 border-slate-600",
  RECEIVED: "bg-slate-800 text-slate-300 border-slate-700",
};

const PRESET_CARDS: Array<{
  id: DemoPreset;
  title: string;
  subtitle: string;
  tag: string;
  tagStyle: string;
  accent: string;
}> = [
  {
    id: "clean_auto",
    title: "Clean Auto-Approve ($850)",
    subtitle: "Apex Cloud · Verified IBAN · Exact 3-Way Match → ISO 20022 XML",
    tag: "AUTO-SETTLE",
    tagStyle: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    accent: "hover:border-emerald-500/60 hover:shadow-[0_0_28px_-12px_rgba(16,185,129,0.6)]",
  },
  {
    id: "hitl_manager",
    title: "Manager HITL Pause ($4,800)",
    subtitle: "Apex Cloud · Exceeds $1k cap → Pauses in PostgreSQL Checkpoint",
    tag: "HITL PAUSE",
    tagStyle: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    accent: "hover:border-sky-500/60 hover:shadow-[0_0_28px_-12px_rgba(56,189,248,0.6)]",
  },
  {
    id: "gr_overbill",
    title: "3-Way GR Variance ($6,000)",
    subtitle: "Al Noor Logistics · Bills 10 pallets vs 7 delivered + MSA Clause 6.1",
    tag: "VARIANCE",
    tagStyle: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    accent: "hover:border-amber-500/60 hover:shadow-[0_0_28px_-12px_rgba(245,158,11,0.55)]",
  },
  {
    id: "fraud_white_text",
    title: "Hidden White-Text Wire Fraud",
    subtitle: "OWASP LLM01 Prompt Injection + Hijacked Cyprus IBAN → Hard Quarantine",
    tag: "RED-TEAM",
    tagStyle: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    accent: "hover:border-rose-500/60 hover:shadow-[0_0_28px_-12px_rgba(244,63,94,0.65)]",
  },
];

const PIPELINE_STAGES = [
  "Scanning PDF bytes for active exploits, white text & metadata injections...",
  "Running Gemini Multimodal Vision extraction with automatic failover...",
  "Executing deterministic Decimal 3-Way Match, OFAC & IBAN verification...",
  "Retrieving vendor-isolated pgvector MSA contract clauses...",
  "Applying Policy Gate & persisting LangGraph PostgreSQL checkpoint...",
];

type NavTab = "ledger" | "approvals" | "vendors" | "analytics";
type StatusFilter =
  | "ALL"
  | "PAYMENT_STAGED"
  | "AWAITING_APPROVAL"
  | "QUARANTINED_FRAUD_RISK"
  | "REJECTED";

export default function CommandCenterPage() {
  const [persona, setPersona] = useState<Persona>(DEMO_PERSONAS[0]);
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);
  const [evalScorecard, setEvalScorecard] = useState<EvalScorecard | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequestItem[]>([]);
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetterItem[]>([]);
  const [dlqForbidden, setDlqForbidden] = useState(false);

  const [securityPosture, setSecurityPosture] = useState<SecurityPosture | null>(null);
  const [postureForbidden, setPostureForbidden] = useState(false);
  const [auditReport, setAuditReport] = useState<AuditIntegrityReport | null>(null);
  const [verifyingAudit, setVerifyingAudit] = useState(false);

  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceDetail | null>(null);
  const [settlementXml, setSettlementXml] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>("ledger");

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [isDragging, setIsDragging] = useState(false);
  const [copiedXml, setCopiedXml] = useState(false);

  const [backendWaking, setBackendWaking] = useState(false);
  const [wakeAttempts, setWakeAttempts] = useState(0);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [liveStageIdx, setLiveStageIdx] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});

  // Manual Fraud Hold Modal
  const [holdModalOpen, setHoldModalOpen] = useState(false);
  const [holdReason, setHoldReason] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pushToast = useCallback((type: ToastItem["type"], title: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, type, title, detail }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Animate live stage ticker while a real backend pipeline is running
  useEffect(() => {
    if (!busyAction) {
      setLiveStageIdx(0);
      return;
    }
    const timer = setInterval(() => {
      setLiveStageIdx((prev) => (prev + 1) % PIPELINE_STAGES.length);
    }, 850);
    return () => clearInterval(timer);
  }, [busyAction]);

  const loadWorkspace = useCallback(
    async (selectId?: string) => {
      try {
        const [m, invList, appList, ev, vendorList] = await Promise.all([
          api.getMetrics(persona.apiKey),
          api.listInvoices(persona.apiKey),
          api.listPendingApprovals(persona.apiKey),
          api.getEvalScorecard(persona.apiKey),
          api.listVendors(persona.apiKey),
        ]);
        setBackendWaking(false);
        setWakeAttempts(0);
        setMetrics(m);
        setInvoices(invList);
        setApprovals(appList);
        setEvalScorecard(ev);
        setVendors(vendorList);

        // Fetch RBAC-protected Dead-Letter Queue
        try {
          const dlq = await api.listDeadLetters(persona.apiKey);
          setDeadLetters(dlq);
          setDlqForbidden(false);
        } catch (dlqErr) {
          if (dlqErr instanceof ApiError && dlqErr.status === 403) {
            setDlqForbidden(true);
            setDeadLetters([]);
          }
        }

        // Fetch RBAC-protected MNC Security & Reliability Posture
        try {
          const posture = await api.getSecurityPosture(persona.apiKey);
          setSecurityPosture(posture);
          setPostureForbidden(false);
        } catch (secErr) {
          if (secErr instanceof ApiError && secErr.status === 403) {
            setPostureForbidden(true);
            setSecurityPosture(null);
            setAuditReport(null);
          }
        }

        const targetId = selectId || selectedInvoice?.id || invList[0]?.id;
        if (targetId) {
          const detail = await api.getInvoiceDetail(persona.apiKey, targetId);
          setSelectedInvoice(detail);
          if (detail.settlement_reference) {
            const xml = await api.getSettlementXml(persona.apiKey, detail.id);
            setSettlementXml(xml);
          } else {
            setSettlementXml(null);
          }
        }
      } catch (err) {
        if (err instanceof ApiError) {
          pushToast("error", `API Error (${err.status})`, err.message);
        } else {
          // Graceful Render free-tier cold-start / network wakeup state
          setBackendWaking(true);
        }
      }
    },
    [persona.apiKey, pushToast, selectedInvoice?.id]
  );

  // Auto-poll /health while cloud API is waking from cold start
  useEffect(() => {
    if (!backendWaking) return;
    let cancelled = false;
    const poll = setInterval(async () => {
      setWakeAttempts((n) => n + 1);
      const healthy = await api.pingHealth();
      if (healthy && !cancelled) {
        setBackendWaking(false);
        setWakeAttempts(0);
        pushToast(
          "ok",
          "FinOps Control Plane Online",
          "Cloud API booted and synchronized live PostgreSQL state."
        );
        void loadWorkspace();
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [backendWaking, loadWorkspace, pushToast]);

  useEffect(() => {
    void loadWorkspace();
  }, [persona.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredInvoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return invoices.filter((inv) => {
      const matchesStatus =
        statusFilter === "ALL" ||
        inv.status === statusFilter ||
        (statusFilter === "AWAITING_APPROVAL" && inv.status === "ESCALATED_SLA");
      if (!matchesStatus) return false;
      if (!q) return true;
      return (
        (inv.invoice_number || "").toLowerCase().includes(q) ||
        (inv.po_number || "").toLowerCase().includes(q) ||
        inv.original_filename.toLowerCase().includes(q) ||
        inv.status.toLowerCase().includes(q)
      );
    });
  }, [invoices, searchQuery, statusFilter]);

  const handleSelectInvoice = async (invoiceId: string) => {
    try {
      const detail = await api.getInvoiceDetail(persona.apiKey, invoiceId);
      setSelectedInvoice(detail);
      if (detail.settlement_reference) {
        const xml = await api.getSettlementXml(persona.apiKey, detail.id);
        setSettlementXml(xml);
      } else {
        setSettlementXml(null);
      }
    } catch (err) {
      pushToast(
        "error",
        "Unable to Load Dossier",
        err instanceof Error ? err.message : "Failed to fetch invoice details."
      );
    }
  };

  const handleRunPreset = async (preset: DemoPreset) => {
    setBusyAction(preset);
    try {
      const detail = await api.runDemoPreset(persona.apiKey, preset);
      setSelectedInvoice(detail);
      if (detail.settlement_reference) {
        const xml = await api.getSettlementXml(persona.apiKey, detail.id);
        setSettlementXml(xml);
      } else {
        setSettlementXml(null);
      }
      pushToast(
        detail.status === "QUARANTINED_FRAUD_RISK" ? "error" : "ok",
        `Pipeline Complete → ${detail.status.replaceAll("_", " ")}`,
        `${detail.invoice_number || detail.original_filename} processed in ${detail.processing_ms}ms ($${Number(detail.llm_cost_usd).toFixed(5)}).`
      );
      setActiveTab("ledger");
      await loadWorkspace(detail.id);
    } catch (err) {
      pushToast(
        "error",
        "Pipeline Execution Failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyAction(null);
    }
  };

  const processUploadedFile = async (file: File) => {
    setBusyAction("upload");
    try {
      const detail = await api.uploadAndProcessInvoice(persona.apiKey, file);
      setSelectedInvoice(detail);
      pushToast("ok", `Processed ${file.name}`, `Outcome: ${detail.status.replaceAll("_", " ")}`);
      setActiveTab("ledger");
      await loadWorkspace(detail.id);
    } catch (err) {
      pushToast("error", "Upload Blocked / Failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void processUploadedFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void processUploadedFile(file);
  };

  const handleApprovalDecision = async (
    req: ApprovalRequestItem,
    decision: "APPROVED" | "REJECTED"
  ) => {
    const reason =
      decisionReason[req.id]?.trim() ||
      (decision === "APPROVED"
        ? `Verified and approved by ${persona.label} (${persona.roleTitle}).`
        : `Rejected by ${persona.label} pending vendor reconciliation.`);

    setBusyAction(req.id);
    try {
      const res = await api.decideApproval(persona.apiKey, req.id, decision, reason);
      pushToast(
        "ok",
        decision === "APPROVED"
          ? `Checkpoint Resumed → ${res.invoice_status}`
          : "Checkpoint Resumed → REJECTED",
        res.settlement_reference
          ? `ISO 20022 wire staged: ${res.settlement_reference}`
          : "Decision logged immutably to PostgreSQL."
      );
      await loadWorkspace(req.invoice_id);
      setActiveTab("ledger");
    } catch (err) {
      pushToast(
        "error",
        "Backend Governance Guard Blocked Action",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleEscalateSla = async (req: ApprovalRequestItem) => {
    setBusyAction(`esc-${req.id}`);
    try {
      await api.escalateApproval(persona.apiKey, req.id);
      pushToast(
        "info",
        "SLA Escalated to Corporate Controller",
        `Approval ${req.id.slice(0, 8)} moved to ESCALATED_SLA.`
      );
      await loadWorkspace(req.invoice_id);
    } catch (err) {
      pushToast(
        "error",
        "SLA Escalation Blocked",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmFraudHold = async () => {
    if (!selectedInvoice || holdReason.trim().length < 5) return;
    setBusyAction("fraud-hold");
    try {
      await api.placeFraudHold(persona.apiKey, selectedInvoice.id, holdReason.trim());
      pushToast(
        "error",
        "Manual Fraud Quarantine Applied",
        `${selectedInvoice.invoice_number || selectedInvoice.original_filename} locked by ${persona.label}.`
      );
      setHoldModalOpen(false);
      setHoldReason("");
      await loadWorkspace(selectedInvoice.id);
    } catch (err) {
      pushToast(
        "error",
        "RBAC Blocked Fraud Hold",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryInvoice = async (invoiceId: string) => {
    setBusyAction("retry");
    try {
      const updated = await api.retryInvoice(persona.apiKey, invoiceId);
      pushToast(
        "ok",
        `Self-Healing Retry Complete → ${updated.status.replaceAll("_", " ")}`,
        "Workflow re-executed idempotently and audited to PostgreSQL."
      );
      await loadWorkspace(invoiceId);
    } catch (err) {
      pushToast("error", "Retry Blocked", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyAudit = async () => {
    setVerifyingAudit(true);
    try {
      const report = await api.verifyAuditIntegrity(persona.apiKey);
      setAuditReport(report);
      pushToast(
        report.verified ? "ok" : "error",
        report.verified ? "HMAC-SHA256 Audit Chain Verified" : "Audit Chain Tamper Detected",
        `${report.signed_rows_valid} valid cryptographic seals checked across ${report.total_rows_checked} rows.`
      );
    } catch (err) {
      pushToast(
        "error",
        "Audit Verification Failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setVerifyingAudit(false);
    }
  };

  const handleResolveDlq = async (jobId: string, note: string) => {
    try {
      await api.resolveDeadLetter(persona.apiKey, jobId, note);
      pushToast("ok", "Dead-Letter Job Resolved", "Logged immutably to the PostgreSQL audit ledger.");
      await loadWorkspace();
    } catch (err) {
      pushToast("error", "DLQ Resolution Failed", err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyXml = async () => {
    if (!settlementXml) return;
    await navigator.clipboard.writeText(settlementXml);
    setCopiedXml(true);
    pushToast("ok", "Copied ISO 20022 XML", "pain.001.001.03 payload copied to clipboard.");
    setTimeout(() => setCopiedXml(false), 2000);
  };

  const handleDownloadXml = () => {
    if (!settlementXml || !selectedInvoice?.settlement_reference) return;
    const blob = new Blob([settlementXml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedInvoice.settlement_reference}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const navItems: Array<{ id: NavTab; label: string; badge?: number; Icon: typeof Activity }> = [
    { id: "ledger", label: "Invoice Ledger & Dossier", badge: invoices.length, Icon: Activity },
    { id: "approvals", label: "HITL Approval Queue", badge: approvals.length, Icon: Clock },
    { id: "vendors", label: "Vendors & MSA RAG", badge: vendors.length, Icon: Building2 },
    { id: "analytics", label: "Security, Analytics & DLQ", Icon: BarChart3 },
  ];

  return (
    <div className="finops-backdrop min-h-screen text-slate-100">
      {/* Top Glass Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <motion.div
              whileHover={{ rotate: 6, scale: 1.05 }}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/25 to-sky-500/20 ring-1 ring-emerald-500/40"
            >
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            </motion.div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white">LedgerPilot</h1>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      backendWaking ? "animate-ping bg-amber-400" : "animate-pulse bg-emerald-400"
                    }`}
                  />
                  {backendWaking ? "WAKING CLOUD ENGINE" : "LIVE FINOPS CONTROL PLANE"}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                ISO 20022 Settlement · pgvector Contract RAG · LangGraph Checkpoints · OWASP + SOX
                404 Defense
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {evalScorecard?.available && (
              <div className="hidden items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/35 px-3 py-1.5 text-xs xl:flex">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span className="font-mono font-semibold text-emerald-300">
                  {evalScorecard.overall_accuracy_pct}% Acc ·{" "}
                  {evalScorecard.fraud_and_injection_recall_pct}% Fraud Recall (
                  {evalScorecard.total_cases} PDFs)
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-900/90 px-3 py-1.5 shadow-inner">
              <UserCheck className={`h-4 w-4 ${persona.badgeColor}`} />
              <select
                aria-label="Active RBAC Persona"
                value={persona.key}
                onChange={(e) => {
                  const found = DEMO_PERSONAS.find((p) => p.key === e.target.value);
                  if (found) {
                    setPersona(found);
                    pushToast(
                      "info",
                      `Switched Persona → ${found.label}`,
                      `${found.roleTitle} (${found.limitLabel}) active on all API requests.`
                    );
                  }
                }}
                className="bg-transparent text-xs font-medium text-slate-100 focus:outline-none"
              >
                {DEMO_PERSONAS.map((p) => (
                  <option key={p.key} value={p.key} className="bg-slate-900 text-slate-100">
                    {p.label} — {p.roleTitle} ({p.limitLabel})
                  </option>
                ))}
              </select>
            </div>

            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={() => void loadWorkspace()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Sync
            </motion.button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {/* Cloud Cold-Start Auto-Wakeup Banner */}
        <AnimatePresence>
          {backendWaking && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-950/35 px-4 py-3.5 backdrop-blur">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                  <div>
                    <div className="text-xs font-semibold text-amber-200">
                      Waking Cloud FinOps Backend Engine...
                    </div>
                    <div className="font-mono text-[11px] text-amber-200/80">
                      Free-tier Render instances sleep after 15m idle (~30–60s cold boot). Auto-retrying
                      health check{wakeAttempts > 0 ? ` (attempt #${wakeAttempts})` : ""}...
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => void loadWorkspace()}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
                >
                  Retry Now
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Live Pipeline Execution Banner */}
        <AnimatePresence>
          {busyAction && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="flex items-center justify-between gap-4 rounded-xl border border-sky-500/40 bg-sky-950/40 px-4 py-3 backdrop-blur">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                  <div>
                    <div className="text-xs font-semibold text-sky-200">
                      Live LangGraph Pipeline Executing...
                    </div>
                    <div className="font-mono text-[11px] text-sky-300/80">
                      {PIPELINE_STAGES[liveStageIdx]}
                    </div>
                  </div>
                </div>
                <div className="hidden gap-1 sm:flex">
                  {PIPELINE_STAGES.map((_, idx) => (
                    <span
                      key={idx}
                      className={`h-1.5 w-6 rounded-full transition-colors ${
                        idx <= liveStageIdx ? "bg-sky-400" : "bg-slate-800"
                      }`}
                    />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Animated KPI Strip */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <KpiCard
            delay={0.0}
            label="Total Processed"
            value={String(metrics?.total_invoices ?? "—")}
            sub="Idempotent Ledger"
          />
          <KpiCard
            delay={0.04}
            label="Payments Staged"
            value={
              metrics
                ? `$${Number(metrics.total_staged_amount).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "—"
            }
            sub={`${metrics?.payment_staged_count ?? 0} ISO 20022 XMLs`}
            accent="text-emerald-400"
          />
          <KpiCard
            delay={0.08}
            label="Pending HITL"
            value={String(metrics?.pending_approvals_count ?? "—")}
            sub="Paused Checkpoints"
            accent="text-sky-400"
          />
          <KpiCard
            delay={0.12}
            label="Fraud Blocked"
            value={String(metrics?.quarantined_fraud_count ?? "—")}
            sub="0% Wire Leakage"
            accent="text-rose-400"
          />
          <KpiCard
            delay={0.16}
            label="Avg Latency"
            value={metrics ? `${metrics.avg_processing_ms} ms` : "—"}
            sub="End-to-End Graph"
          />
          <KpiCard
            delay={0.2}
            label="Total LLM Cost"
            value={metrics ? `$${Number(metrics.total_llm_cost_usd).toFixed(4)}` : "—"}
            sub="Gemini Flash Economics"
          />
        </section>

        {/* Interactive Launchpad: 4 1-Click Live Scenarios + Drag-and-Drop Dropzone */}
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`rounded-2xl border p-5 backdrop-blur-sm transition-all ${
            isDragging
              ? "border-sky-400 bg-sky-950/30 shadow-[0_0_40px_-10px_rgba(56,189,248,0.6)]"
              : "border-slate-800/90 bg-slate-900/50"
          }`}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Interactive AP Pipeline Launchpad
              </h2>
              <p className="text-xs text-slate-400">
                Click any live enterprise scenario below or{" "}
                <span className="text-sky-300">drag &amp; drop a real invoice PDF/PNG</span>{" "}
                directly onto this panel.
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={handleFileChange}
                className="hidden"
              />
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => fileInputRef.current?.click()}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3.5 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50"
              >
                <FileUp className="h-4 w-4 text-sky-400" />
                {busyAction === "upload" ? "Processing PDF..." : "Upload / Drop Invoice"}
              </motion.button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {PRESET_CARDS.map((card) => {
              const isRunning = busyAction === card.id;
              return (
                <motion.button
                  key={card.id}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => void handleRunPreset(card.id)}
                  disabled={busyAction !== null}
                  className={`group flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/75 p-4 text-left transition-all ${card.accent} disabled:opacity-50`}
                >
                  <div>
                    <div className="mb-2.5 flex items-center justify-between">
                      <span
                        className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold ${card.tagStyle}`}
                      >
                        {card.tag}
                      </span>
                      {isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                      ) : (
                        <Play className="h-3.5 w-3.5 text-slate-500 transition-transform group-hover:translate-x-0.5 group-hover:text-white" />
                      )}
                    </div>
                    <div className="text-sm font-semibold text-white">{card.title}</div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{card.subtitle}</p>
                  </div>
                  <div className="mt-3 font-mono text-[11px] text-sky-400">
                    {isRunning ? "Executing live graph..." : "Run live scenario →"}
                  </div>
                </motion.button>
              );
            })}
          </div>
        </section>

        {/* Animated Segmented Tab Bar */}
        <nav className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-800/90 bg-slate-900/60 p-1.5">
          {navItems.map((tab) => {
            const active = activeTab === tab.id;
            const Icon = tab.Icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                  active ? "text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="activeNavPill"
                    transition={{ type: "spring", stiffness: 450, damping: 32 }}
                    className="absolute inset-0 rounded-lg border border-slate-700/80 bg-slate-800/90"
                  />
                )}
                <Icon className="relative z-10 h-4 w-4" />
                <span className="relative z-10">{tab.label}</span>
                {typeof tab.badge === "number" && (
                  <span
                    className={`relative z-10 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
                      tab.id === "approvals" && tab.badge > 0
                        ? "bg-sky-500/25 text-sky-300"
                        : "bg-slate-950/80 text-slate-300"
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Tab View Content with Smooth Fade Transition */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {activeTab === "vendors" && (
              <VendorContractHub
                vendors={vendors}
                apiKey={persona.apiKey}
                onError={(msg) => pushToast("error", "Contract RAG Error", msg)}
              />
            )}

            {activeTab === "analytics" && (
              <FinOpsAnalytics
                metrics={metrics}
                evalScorecard={evalScorecard}
                deadLetters={deadLetters}
                dlqForbidden={dlqForbidden}
                securityPosture={securityPosture}
                postureForbidden={postureForbidden}
                auditReport={auditReport}
                verifyingAudit={verifyingAudit}
                onVerifyAudit={handleVerifyAudit}
                onResolveDlq={handleResolveDlq}
                persona={persona}
              />
            )}

            {activeTab === "approvals" && (
              <section className="space-y-4">
                {approvals.length === 0 ? (
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-sm text-slate-400">
                    No pending approvals right now. Run the{" "}
                    <span className="font-semibold text-sky-300">Manager HITL Pause ($4,800)</span>{" "}
                    scenario above to pause a live workflow in PostgreSQL.
                  </div>
                ) : (
                  approvals.map((req) => (
                    <motion.div
                      key={req.id}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-2xl border border-slate-800/90 bg-slate-900/60 p-5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-sky-500/40 bg-sky-500/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300">
                              REQUIRED ROLE: {req.required_role}
                            </span>
                            <span
                              className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                                req.status === "ESCALATED"
                                  ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                                  : "border-slate-700 bg-slate-800 text-slate-300"
                              }`}
                            >
                              {req.status}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-white">{req.reason_summary}</p>
                          <p className="font-mono text-xs text-slate-400">
                            Approval: {req.id.slice(0, 8)}… · Invoice: {req.invoice_id.slice(0, 8)}… ·
                            SLA Due: {new Date(req.sla_due_at).toLocaleString()}
                          </p>
                        </div>

                        <div className="flex items-center gap-3">
                          {req.status === "PENDING" && (
                            <motion.button
                              whileTap={{ scale: 0.95 }}
                              disabled={busyAction !== null}
                              onClick={() => void handleEscalateSla(req)}
                              className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Simulate SLA Breach
                            </motion.button>
                          )}
                          <button
                            onClick={() => {
                              void handleSelectInvoice(req.invoice_id);
                              setActiveTab("ledger");
                            }}
                            className="text-xs font-medium text-sky-400 hover:underline"
                          >
                            Inspect Dossier →
                          </button>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <input
                          type="text"
                          placeholder="Optional audit note (logged immutably to PostgreSQL)..."
                          value={decisionReason[req.id] || ""}
                          onChange={(e) =>
                            setDecisionReason((prev) => ({ ...prev, [req.id]: e.target.value }))
                          }
                          className="min-w-[260px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                        />
                        <motion.button
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.95 }}
                          disabled={busyAction !== null}
                          onClick={() => void handleApprovalDecision(req, "APPROVED")}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-950/50 transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Approve &amp; Stage Wire
                        </motion.button>
                        <motion.button
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.95 }}
                          disabled={busyAction !== null}
                          onClick={() => void handleApprovalDecision(req, "REJECTED")}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600/85 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
                        >
                          <XCircle className="h-4 w-4" />
                          Reject Invoice
                        </motion.button>
                      </div>
                    </motion.div>
                  ))
                )}
              </section>
            )}

            {activeTab === "ledger" && (
              <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                {/* Left Column: Searchable & Filterable Invoice Ledger */}
                <div className="lg:col-span-4">
                  <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-3.5">
                    <div className="relative mb-2.5">
                      <Search className="pointer-events-none absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-500" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search invoice #, PO, or file..."
                        className="w-full rounded-lg border border-slate-800 bg-slate-950 py-2 pr-3 pl-8 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                      />
                    </div>

                    <div className="mb-3 flex flex-wrap gap-1">
                      {(
                        [
                          ["ALL", "All"],
                          ["PAYMENT_STAGED", "Staged"],
                          ["AWAITING_APPROVAL", "HITL"],
                          ["QUARANTINED_FRAUD_RISK", "Fraud"],
                          ["REJECTED", "Rejected"],
                        ] as const
                      ).map(([code, label]) => (
                        <button
                          key={code}
                          onClick={() => setStatusFilter(code)}
                          className={`rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                            statusFilter === code
                              ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                              : "bg-slate-950/70 text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="max-h-[700px] space-y-2 overflow-y-auto pr-1">
                      {filteredInvoices.length === 0 ? (
                        <div className="py-10 text-center text-xs text-slate-500">
                          No invoices match this filter.
                        </div>
                      ) : (
                        filteredInvoices.map((inv) => {
                          const active = selectedInvoice?.id === inv.id;
                          return (
                            <motion.button
                              key={inv.id}
                              whileTap={{ scale: 0.99 }}
                              onClick={() => void handleSelectInvoice(inv.id)}
                              className={`w-full rounded-xl border p-3 text-left transition ${
                                active
                                  ? "border-sky-500/60 bg-slate-800/80 shadow-[0_0_20px_-10px_rgba(56,189,248,0.6)]"
                                  : "border-slate-800/80 bg-slate-950/60 hover:border-slate-700"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono text-xs font-semibold text-white">
                                  {inv.invoice_number || inv.original_filename}
                                </span>
                                <span
                                  className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${
                                    STATUS_BADGE[inv.status] || STATUS_BADGE.RECEIVED
                                  }`}
                                >
                                  {inv.status.replaceAll("_", " ")}
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
                                <span className="truncate">
                                  {inv.po_number || inv.source_channel}
                                </span>
                                <span className="font-mono font-semibold text-slate-200">
                                  {inv.total_amount
                                    ? `${inv.currency || "USD"} ${inv.total_amount}`
                                    : "—"}
                                </span>
                              </div>
                              {inv.risk_flags.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {inv.risk_flags.slice(0, 3).map((flag) => (
                                    <span
                                      key={flag}
                                      className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[9px] text-rose-300"
                                    >
                                      {flag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </motion.button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Column: Deep Interactive Audit Dossier */}
                <div className="space-y-4 lg:col-span-8">
                  {!selectedInvoice ? (
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-sm text-slate-400">
                      Select an invoice or trigger a live scenario above.
                    </div>
                  ) : (
                    <motion.div
                      key={selectedInvoice.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-4"
                    >
                      {/* Dossier Header + Action Controls */}
                      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/60 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="flex flex-wrap items-center gap-2.5">
                              <h2 className="font-mono text-lg font-bold text-white">
                                {selectedInvoice.invoice_number ||
                                  selectedInvoice.original_filename}
                              </h2>
                              <span
                                className={`rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold ${
                                  STATUS_BADGE[selectedInvoice.status] || STATUS_BADGE.RECEIVED
                                }`}
                              >
                                {selectedInvoice.status}
                              </span>
                            </div>
                            <p className="mt-1 font-mono text-xs text-slate-400">
                              PO: {selectedInvoice.po_number || "N/A"} · Extracted IBAN:{" "}
                              {selectedInvoice.extracted_iban || "N/A"} · Cost: $
                              {Number(selectedInvoice.llm_cost_usd).toFixed(5)} · Latency:{" "}
                              {selectedInvoice.processing_ms} ms
                            </p>
                          </div>

                          <div className="flex flex-col items-end gap-2">
                            <div className="font-mono text-2xl font-bold text-white">
                              {selectedInvoice.total_amount
                                ? `${selectedInvoice.currency || "USD"} ${selectedInvoice.total_amount}`
                                : "Pending"}
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {(selectedInvoice.status === "RECEIVED" ||
                                selectedInvoice.status === "FAILED") && (
                                <motion.button
                                  whileTap={{ scale: 0.95 }}
                                  disabled={busyAction !== null}
                                  onClick={() => void handleRetryInvoice(selectedInvoice.id)}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-50"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  Run / Retry Pipeline
                                </motion.button>
                              )}
                              {selectedInvoice.status !== "PAYMENT_STAGED" &&
                                selectedInvoice.status !== "QUARANTINED_FRAUD_RISK" && (
                                  <motion.button
                                    whileTap={{ scale: 0.95 }}
                                    onClick={() => setHoldModalOpen(true)}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/20"
                                  >
                                    <ShieldBan className="h-3.5 w-3.5" />
                                    Place Manual Fraud Hold
                                  </motion.button>
                                )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4">
                          <WorkflowStepper invoice={selectedInvoice} />
                        </div>
                      </div>

                      {/* Forensics + 3-Way Match Grid */}
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-4">
                          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                            <ShieldAlert className="h-4 w-4 text-rose-400" />
                            PDF Forensics &amp; OWASP Guard
                          </div>
                          <div className="space-y-2 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Risk Score</span>
                              <span className="font-mono font-semibold text-white">
                                {selectedInvoice.security_report?.risk_score ?? 0} / 100
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Prompt Injection</span>
                              <span
                                className={
                                  selectedInvoice.security_report?.prompt_injection_detected
                                    ? "font-semibold text-rose-400"
                                    : "text-emerald-400"
                                }
                              >
                                {selectedInvoice.security_report?.prompt_injection_detected
                                  ? "DETECTED & BLOCKED"
                                  : "None"}
                              </span>
                            </div>
                            {(selectedInvoice.security_report?.findings?.length ?? 0) > 0 && (
                              <div className="mt-2 space-y-2">
                                {selectedInvoice.security_report.findings!.map((f, i) => (
                                  <div
                                    key={i}
                                    className="rounded-lg border border-rose-500/40 bg-rose-950/40 p-2.5"
                                  >
                                    <div className="font-mono text-[11px] font-semibold text-rose-300">
                                      [{f.severity}] {f.finding_type}
                                    </div>
                                    <p className="mt-1 text-[11px] text-rose-200/90">{f.detail}</p>
                                    <code className="mt-1 block truncate rounded bg-slate-950/70 px-2 py-1 font-mono text-[10px] text-rose-200">
                                      &ldquo;{f.snippet}&rdquo;
                                    </code>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-4">
                          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            Deterministic Decimal 3-Way Match
                          </div>
                          <p className="mb-3 text-xs text-slate-300">
                            {selectedInvoice.match_report?.summary || "Awaiting match audit."}
                          </p>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <CheckPill
                              label="PO Match"
                              ok={selectedInvoice.match_report?.po_matched}
                            />
                            <CheckPill
                              label="Goods Receipt"
                              ok={selectedInvoice.match_report?.goods_receipt_matched}
                            />
                            <CheckPill
                              label="Decimal Math"
                              ok={selectedInvoice.match_report?.arithmetic_valid}
                            />
                            <CheckPill
                              label="Verified IBAN"
                              ok={selectedInvoice.match_report?.iban_verified}
                            />
                          </div>
                          {(selectedInvoice.match_report?.line_variances?.length ?? 0) > 0 && (
                            <div className="mt-3 space-y-1.5">
                              {selectedInvoice.match_report.line_variances!.map((v, i) => (
                                <div
                                  key={i}
                                  className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-2 font-mono text-[11px] text-amber-200"
                                >
                                  <strong>{v.issue}</strong>: expected {v.expected_value}, got{" "}
                                  {v.actual_value}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Verified MSA Contract Citations */}
                      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-4">
                        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                          <BookOpen className="h-4 w-4 text-sky-400" />
                          Verified Vendor MSA Clauses (pgvector Hybrid RAG)
                        </div>
                        {selectedInvoice.rag_citations.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            No MSA citations recorded for this invoice.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {selectedInvoice.rag_citations.map((cit) => (
                              <div
                                key={cit.chunk_id}
                                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-mono text-xs font-semibold text-sky-300">
                                    [{cit.citation_id}] {cit.document_name} · {cit.clause_ref}
                                  </span>
                                  <span className="rounded bg-sky-500/15 px-2 py-0.5 font-mono text-[10px] text-sky-200">
                                    similarity {(cit.similarity_score * 100).toFixed(1)}%
                                  </span>
                                </div>
                                <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
                                  {cit.excerpt}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ISO 20022 Wire XML Viewer with Copy + Download */}
                      {settlementXml && (
                        <div className="rounded-2xl border border-emerald-500/35 bg-emerald-950/20 p-4">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                              <FileCode2 className="h-4 w-4" />
                              Bank-Ready ISO 20022 (pain.001.001.03) Wire Instruction
                            </div>
                            <div className="flex items-center gap-2">
                              <motion.button
                                whileTap={{ scale: 0.94 }}
                                onClick={() => void handleCopyXml()}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-600"
                              >
                                {copiedXml ? (
                                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                {copiedXml ? "Copied" : "Copy XML"}
                              </motion.button>
                              <motion.button
                                whileTap={{ scale: 0.94 }}
                                onClick={handleDownloadXml}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
                              >
                                <Download className="h-3.5 w-3.5" />
                                Download XML
                              </motion.button>
                            </div>
                          </div>
                          <pre className="max-h-60 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-200/90">
                            {settlementXml}
                          </pre>
                        </div>
                      )}

                      {/* Immutable Audit Ledger */}
                      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-4">
                        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                          <History className="h-4 w-4 text-slate-400" />
                          Immutable PostgreSQL Audit Ledger (Append-Only Trigger + HMAC-SHA256)
                        </div>
                        <div className="space-y-1.5">
                          {selectedInvoice.audit_logs.map((log) => (
                            <div
                              key={log.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-slate-950/60 px-3 py-2 text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                                  {log.actor_type}
                                </span>
                                <span className="font-mono font-semibold text-slate-100">
                                  {log.action}
                                </span>
                                <span className="text-slate-400">by {log.actor_id}</span>
                              </div>
                              <span className="font-mono text-[11px] text-slate-500">
                                {new Date(log.created_at).toLocaleTimeString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              </section>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Manual Fraud Hold Confirmation Modal */}
      <AnimatePresence>
        {holdModalOpen && selectedInvoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-slate-900 p-5 shadow-2xl"
            >
              <div className="flex items-center gap-2 text-rose-300">
                <ShieldBan className="h-5 w-5" />
                <h3 className="text-sm font-bold">Place Manual Fraud Quarantine Hold</h3>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Locks{" "}
                <strong className="font-mono text-white">
                  {selectedInvoice.invoice_number || selectedInvoice.original_filename}
                </strong>{" "}
                into <code className="text-rose-300">QUARANTINED_FRAUD_RISK</code> and writes an
                immutable HMAC-sealed audit record under <strong>{persona.label}</strong> (
                {persona.roleTitle}).
              </p>
              <textarea
                rows={3}
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="Enter forensic reason (min 5 characters), e.g., Vendor email domain failed DMARC verification..."
                className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-rose-500 focus:outline-none"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setHoldModalOpen(false)}
                  className="rounded-lg border border-slate-700 px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  disabled={holdReason.trim().length < 5 || busyAction !== null}
                  onClick={() => void handleConfirmFraudHold()}
                  className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  Confirm Quarantine
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Toast Stack */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent = "text-white",
  delay = 0,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      whileHover={{ y: -2 }}
      className="rounded-xl border border-slate-800/90 bg-slate-900/60 p-3.5 backdrop-blur-sm transition-colors hover:border-slate-700"
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 font-mono text-xl font-bold ${accent}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </motion.div>
  );
}

function CheckPill({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-rose-500/30 bg-rose-500/10 text-rose-300"
      }`}
    >
      <span>{label}</span>
      <span>{ok ? "PASS" : "FAIL"}</span>
    </div>
  );
}
