"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Command,
  Copy,
  Cpu,
  DollarSign,
  Download,
  Eye,
  FileCode2,
  FileText,
  FileUp,
  FlaskConical,
  Gauge,
  History,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldBan,
  Sparkles,
  Trash2,
  UploadCloud,
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
  type DocumentPreviewResponse,
  type EvalScorecard,
  type InvoiceDetail,
  type InvoiceSummary,
  type MetricsOverview,
  type Persona,
  type SecurityPosture,
  type VendorRecord,
} from "@/lib/api";
import { DocumentViewerModal } from "@/components/DocumentViewerModal";
import { FinOpsAnalytics } from "@/components/FinOpsAnalytics";
import { ToastStack, type ToastItem } from "@/components/ToastStack";
import { VendorContractHub } from "@/components/VendorContractHub";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import {
  AnimatedNumber,
  CommandPalette,
  DeleteArchiveBanner,
  FinOpsDialGauge,
  LivePipelineRail,
  SandboxDrawer,
  SpotlightCard,
  TactileThemeToggle,
  type PaletteAction,
  type PresetSpec,
  type SpotlightTone,
} from "@/components/PrecisionUI";

type DossierPromise = Promise<InvoiceDetail | null>;
type DossierMap = Map<string, InvoiceDetail>;
type XmlMap = Map<string, string | null>;
type PrefetchMap = Map<string, DossierPromise>;
type ReasonMap = Record<string, string>;
type DocPreviewMap = Map<string, DocumentPreviewResponse>;

interface DeleteAnimState {
  id: string;
  label: string;
  stage: 0 | 1 | 2;
}

const STATUS_BADGE: Record<string, string> = {
  PAYMENT_STAGED:
    "bg-emerald-500/12 text-emerald-700 border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40",
  AUTO_APPROVED:
    "bg-emerald-500/12 text-emerald-700 border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40",
  AWAITING_APPROVAL:
    "bg-cyan-500/12 text-cyan-700 border-cyan-500/30 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/40",
  ESCALATED_SLA:
    "bg-amber-500/15 text-amber-700 border-amber-500/35 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
  QUARANTINED_FRAUD_RISK:
    "bg-rose-500/15 text-rose-700 border-rose-500/35 dark:bg-rose-500/20 dark:text-rose-300 dark:border-rose-500/50",
  REJECTED:
    "bg-slate-500/15 text-slate-700 border-slate-500/30 dark:bg-slate-700/60 dark:text-slate-300 dark:border-slate-600",
  RECEIVED:
    "bg-slate-200/80 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
};

const PRESET_CARDS: PresetSpec[] = [
  {
    id: "clean_auto",
    title: "Clean Auto-Approve",
    amount: "$850",
    subtitle: "Apex Cloud \u00B7 Verified IBAN \u00B7 Exact 3-Way Match \u2192 ISO 20022 XML",
    tag: "AUTO-SETTLE",
    tagStyle: "bg-emerald-500/12 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
    tone: "emerald",
  },
  {
    id: "hitl_manager",
    title: "Manager HITL Pause",
    amount: "$4,800",
    subtitle: "Apex Cloud \u00B7 Exceeds $1k cap \u2192 Pauses in PostgreSQL Checkpoint",
    tag: "HITL PAUSE",
    tagStyle: "bg-cyan-500/12 text-cyan-700 border-cyan-500/30 dark:text-cyan-300",
    tone: "cyan",
  },
  {
    id: "gr_overbill",
    title: "3-Way GR Variance",
    amount: "$6,000",
    subtitle: "Al Noor Logistics \u00B7 Bills 10 pallets vs 7 delivered + MSA Clause 6.1",
    tag: "VARIANCE",
    tagStyle: "bg-amber-500/12 text-amber-700 border-amber-500/30 dark:text-amber-300",
    tone: "amber",
  },
  {
    id: "fraud_white_text",
    title: "White-Text Wire Fraud",
    amount: "BLOCKED",
    subtitle: "OWASP LLM01 Prompt Injection + Hijacked Cyprus IBAN \u2192 Quarantine",
    tag: "RED-TEAM",
    tagStyle: "bg-rose-500/12 text-rose-700 border-rose-500/30 dark:text-rose-300",
    tone: "rose",
  },
];

const PIPELINE_STAGES = [
  "Scanning PDF bytes for active exploits, white text & metadata injections...",
  "Running Gemini 4 Hydrogen multimodal extraction with schema lock...",
  "Executing deterministic Decimal 3-Way Match, OFAC & IBAN verification...",
  "Retrieving vendor-isolated pgvector MSA clauses & auditing compliance...",
  "Applying Policy Gate & persisting LangGraph PostgreSQL checkpoint...",
];

type Workspace = "command" | "ledger" | "approvals" | "intelligence";
type IntelSubTab = "vendors" | "analytics";
type EngineStatus = "connecting" | "waking" | "live";
type ScrollTarget = "top" | "dossier";
type StatusFilter =
  | "ALL"
  | "PAYMENT_STAGED"
  | "AWAITING_APPROVAL"
  | "QUARANTINED_FRAUD_RISK"
  | "REJECTED";

interface WorkspaceCacheSnapshot {
  metrics: MetricsOverview | null;
  invoices: InvoiceSummary[];
  approvals: ApprovalRequestItem[];
  evalScorecard: EvalScorecard | null;
  vendors: VendorRecord[];
  deadLetters: DeadLetterItem[];
  dlqForbidden: boolean;
  securityPosture: SecurityPosture | null;
  postureForbidden: boolean;
}

const THEME_EVENT = "lp-theme-change";

function subscribeTheme(onStoreChange: () => void) {
  const handler = () => onStoreChange();
  window.addEventListener("storage", handler);
  window.addEventListener(THEME_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(THEME_EVENT, handler);
  };
}

function getThemeSnapshot(): "dark" | "light" {
  return window.localStorage.getItem("lp-theme") === "light" ? "light" : "dark";
}

function getThemeServerSnapshot(): "dark" | "light" {
  return "dark";
}

function hasControllerClearance(p: Persona): boolean {
  return /controller|admin/i.test(`${p.key} ${p.roleTitle}`);
}

function stageForElapsedMs(elapsedMs: number): number {
  if (elapsedMs < 1200) return 0;
  if (elapsedMs < 4800) return 1;
  if (elapsedMs < 7600) return 2;
  if (elapsedMs < 11500) return 3;
  return 4;
}

function isLangGraphAction(action: string | null): boolean {
  if (!action) return false;
  return action !== "delete" && action !== "fraud-hold" && !action.startsWith("esc-");
}

function optimisticDetailFromSummary(inv: InvoiceSummary): InvoiceDetail {
  return {
    ...inv,
    subtotal_amount: null,
    tax_amount: null,
    extracted_iban: null,
    extracted_payload: {},
    security_report: {},
    match_report: {},
    rag_citations: [],
    thread_id: "",
    settlement_xml_path: null,
    audit_logs: [],
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export default function CommandCenterPage() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const [workspace, setWorkspace] = useState<Workspace>("command");
  const [intelTab, setIntelTab] = useState<IntelSubTab>("vendors");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);

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

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [isDragging, setIsDragging] = useState(false);
  const [copiedXml, setCopiedXml] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [engineStatus, setEngineStatus] = useState<EngineStatus>("connecting");
  const [wakeAttempts, setWakeAttempts] = useState(0);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyElapsedMs, setBusyElapsedMs] = useState(0);
  const [pipelineCompleting, setPipelineCompleting] = useState(false);
  const [deleteAnim, setDeleteAnim] = useState<DeleteAnimState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [decisionReason, setDecisionReason] = useState<ReasonMap>({});

  const [holdModalOpen, setHoldModalOpen] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docModalInvoiceId, setDocModalInvoiceId] = useState<string | null>(null);
  const [docModalLabel, setDocModalLabel] = useState("");
  const [docModalLoading, setDocModalLoading] = useState(false);
  const [docModalDownloading, setDocModalDownloading] = useState(false);
  const [docModalError, setDocModalError] = useState<string | null>(null);
  const [docPreview, setDocPreview] = useState<DocumentPreviewResponse | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dossierRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTargetRef = useRef<ScrollTarget | null>(null);
  const selectedInvoiceIdRef = useRef<string | null>(null);

  // Lightspeed 0ms in-memory dossier & XML cache (flat type aliases — copy-paste safe)
  const dossierCacheRef = useRef<DossierMap>(new Map());
  const xmlCacheRef = useRef<XmlMap>(new Map());
  const inflightPrefetchRef = useRef<PrefetchMap>(new Map());
  const docPreviewCacheRef = useRef<DocPreviewMap>(new Map());
  const selectSeqRef = useRef(0);

  const showPipelineRail = isLangGraphAction(busyAction) || pipelineCompleting;
  const liveStageIdx = pipelineCompleting ? PIPELINE_STAGES.length : stageForElapsedMs(busyElapsedMs);
  const liveStageMessage = pipelineCompleting
    ? "All 5 stages verified & persisted — opening Audit Dossier..."
    : `${PIPELINE_STAGES[liveStageIdx]} (${(busyElapsedMs / 1000).toFixed(1)}s)`;

  useEffect(() => {
    selectedInvoiceIdRef.current = selectedInvoice?.id ?? null;
  }, [selectedInvoice?.id]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const executePendingScroll = useCallback(() => {
    const target = pendingScrollTargetRef.current;
    pendingScrollTargetRef.current = null;
    if (!target) return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (target === "dossier" && window.innerWidth < 1024 && dossierRef.current) {
          dossierRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
        }
      });
    });
  }, []);

  const navigateWorkspace = useCallback(
    (next: Workspace, scrollTarget: ScrollTarget = "top") => {
      pendingScrollTargetRef.current = scrollTarget;
      if (next === workspace) {
        executePendingScroll();
      } else {
        setWorkspace(next);
      }
    },
    [executePendingScroll, workspace]
  );

  // Smoothly scroll pipeline rail into view for LangGraph runs or SOX 404 delete banner
  useEffect(() => {
    if ((isLangGraphAction(busyAction) || deleteAnim !== null) && window.scrollY > 100) {
      window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    }
  }, [busyAction, deleteAnim]);

  // Smooth 250ms clock for responsive LangGraph pipeline progression
  useEffect(() => {
    if (!isLangGraphAction(busyAction) || pipelineCompleting) return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setBusyElapsedMs(Math.round(performance.now() - startedAt));
    }, 250);
    return () => window.clearInterval(timer);
  }, [busyAction, pipelineCompleting]);

  const finishPipelineSweep = useCallback(async () => {
    setPipelineCompleting(true);
    await waitMs(460);
    setPipelineCompleting(false);
    setBusyAction(null);
    setBusyElapsedMs(0);
  }, []);

  // Fetches detail + XML in parallel and hydrates the 0ms in-memory cache
  const fetchAndCacheDossier = useCallback(
    (invoiceId: string, apiKey: string, knownSettlementRef?: string | null, force = false) => {
      if (!force) {
        const cached = dossierCacheRef.current.get(invoiceId);
        if (cached) return Promise.resolve(cached);
        const existing = inflightPrefetchRef.current.get(invoiceId);
        if (existing) return existing;
      }

      const promise: DossierPromise = (async () => {
        try {
          if (knownSettlementRef) {
            const [detail, xml] = await Promise.all([
              api.getInvoiceDetail(apiKey, invoiceId),
              api.getSettlementXml(apiKey, invoiceId).catch(() => null),
            ]);
            dossierCacheRef.current.set(invoiceId, detail);
            xmlCacheRef.current.set(invoiceId, xml);
            return detail;
          }

          const detail = await api.getInvoiceDetail(apiKey, invoiceId);
          dossierCacheRef.current.set(invoiceId, detail);
          if (detail.settlement_reference) {
            const xml = await api.getSettlementXml(apiKey, invoiceId).catch(() => null);
            xmlCacheRef.current.set(invoiceId, xml);
          } else {
            xmlCacheRef.current.set(invoiceId, null);
          }
          return detail;
        } catch {
          return null;
        } finally {
          inflightPrefetchRef.current.delete(invoiceId);
        }
      })();

      inflightPrefetchRef.current.set(invoiceId, promise);
      return promise;
    },
    []
  );

  const prefetchTopInvoices = useCallback(
    (list: InvoiceSummary[], apiKey: string) => {
      const candidates = list.slice(0, 10);
      void Promise.allSettled(
        candidates.map((inv) => fetchAndCacheDossier(inv.id, apiKey, inv.settlement_reference))
      );
    },
    [fetchAndCacheDossier]
  );

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    window.localStorage.setItem("lp-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    window.dispatchEvent(new Event(THEME_EVENT));
  }, [theme]);

  const openLedgerWithFilter = useCallback(
    (filter: StatusFilter) => {
      setStatusFilter(filter);
      navigateWorkspace("ledger", "top");
    },
    [navigateWorkspace]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setSandboxOpen(false);
        setHoldModalOpen(false);
        setDeleteModalOpen(false);
        setDocModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const pushToast = useCallback((type: ToastItem["type"], title: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => {
      const deduped = prev.filter((t) => !(t.title === title && t.detail === detail));
      return [...deduped.slice(-3), { id, type, title, detail }];
    });
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const loadWorkspace = useCallback(
    async (selectId?: string) => {
      const cacheKey = `lp-cache-v1:${persona.key}`;
      const isPrivileged = hasControllerClearance(persona);
      setSyncing(true);

      try {
        const raw = window.localStorage.getItem(cacheKey);
        if (raw) {
          const cached = JSON.parse(raw) as WorkspaceCacheSnapshot;
          if (cached.metrics) setMetrics(cached.metrics);
          if (Array.isArray(cached.invoices)) setInvoices(cached.invoices);
          if (Array.isArray(cached.approvals)) setApprovals(cached.approvals);
          if (cached.evalScorecard) setEvalScorecard(cached.evalScorecard);
          if (Array.isArray(cached.vendors)) setVendors(cached.vendors);
          if (Array.isArray(cached.deadLetters)) setDeadLetters(cached.deadLetters);
          setDlqForbidden(Boolean(cached.dlqForbidden));
          setSecurityPosture(cached.securityPosture ?? null);
          setPostureForbidden(Boolean(cached.postureForbidden));
        }
      } catch {
        // Ignore corrupt cache entries
      }

      const slowTimer = window.setTimeout(() => {
        setEngineStatus((curr) => (curr === "live" ? curr : "waking"));
      }, 2500);

      try {
        const [mRes, invRes, appRes, evRes, venRes, dlqRes, secRes] = await Promise.allSettled([
          api.getMetrics(persona.apiKey),
          api.listInvoices(persona.apiKey),
          api.listPendingApprovals(persona.apiKey),
          api.getEvalScorecard(persona.apiKey),
          api.listVendors(persona.apiKey),
          isPrivileged ? api.listDeadLetters(persona.apiKey) : Promise.resolve(null),
          isPrivileged ? api.getSecurityPosture(persona.apiKey) : Promise.resolve(null),
        ]);

        window.clearTimeout(slowTimer);

        const coreFailed = [mRes, invRes, appRes, evRes, venRes].find(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        if (coreFailed) {
          if (coreFailed.reason instanceof ApiError) {
            pushToast("error", `API Error (${coreFailed.reason.status})`, coreFailed.reason.message);
          } else {
            setEngineStatus("waking");
          }
          return;
        }

        const m = (mRes as PromiseFulfilledResult<MetricsOverview>).value;
        const invList = (invRes as PromiseFulfilledResult<InvoiceSummary[]>).value;
        const appList = (appRes as PromiseFulfilledResult<ApprovalRequestItem[]>).value;
        const ev = (evRes as PromiseFulfilledResult<EvalScorecard>).value;
        const vendorList = (venRes as PromiseFulfilledResult<VendorRecord[]>).value;

        let nextDlq: DeadLetterItem[] = [];
        let nextDlqForbidden = !isPrivileged;
        if (isPrivileged) {
          if (dlqRes.status === "fulfilled" && Array.isArray(dlqRes.value)) {
            nextDlq = dlqRes.value;
            nextDlqForbidden = false;
          } else if (
            dlqRes.status === "rejected" &&
            dlqRes.reason instanceof ApiError &&
            dlqRes.reason.status === 403
          ) {
            nextDlqForbidden = true;
          }
        }

        let nextPosture: SecurityPosture | null = null;
        let nextPostureForbidden = !isPrivileged;
        if (!isPrivileged) {
          setAuditReport(null);
        } else if (secRes.status === "fulfilled" && secRes.value) {
          nextPosture = secRes.value;
          nextPostureForbidden = false;
        } else if (
          secRes.status === "rejected" &&
          secRes.reason instanceof ApiError &&
          secRes.reason.status === 403
        ) {
          nextPostureForbidden = true;
          setAuditReport(null);
        }

        setEngineStatus("live");
        setWakeAttempts(0);
        setMetrics(m);
        setInvoices(invList);
        setApprovals(appList);
        setEvalScorecard(ev);
        setVendors(vendorList);
        setDeadLetters(nextDlq);
        setDlqForbidden(nextDlqForbidden);
        setSecurityPosture(nextPosture);
        setPostureForbidden(nextPostureForbidden);

        try {
          const snapshot: WorkspaceCacheSnapshot = {
            metrics: m,
            invoices: invList,
            approvals: appList,
            evalScorecard: ev,
            vendors: vendorList,
            deadLetters: nextDlq,
            dlqForbidden: nextDlqForbidden,
            securityPosture: nextPosture,
            postureForbidden: nextPostureForbidden,
          };
          window.localStorage.setItem(cacheKey, JSON.stringify(snapshot));
        } catch {
          // Ignore storage quota errors
        }

        prefetchTopInvoices(invList, persona.apiKey);

        const stillExists =
          selectedInvoiceIdRef.current &&
          invList.some((item) => item.id === selectedInvoiceIdRef.current);
        const targetId = selectId || (stillExists ? selectedInvoiceIdRef.current : invList[0]?.id);
        if (targetId) {
          const summaryMatch = invList.find((item) => item.id === targetId);
          const freshDetail = await fetchAndCacheDossier(
            targetId,
            persona.apiKey,
            summaryMatch?.settlement_reference,
            Boolean(selectId)
          );
          if (freshDetail) {
            setSelectedInvoice(freshDetail);
            setSettlementXml(xmlCacheRef.current.get(targetId) ?? null);
          }
        } else {
          setSelectedInvoice(null);
          setSettlementXml(null);
        }
      } catch (err) {
        window.clearTimeout(slowTimer);
        if (err instanceof ApiError) {
          pushToast("error", `API Error (${err.status})`, err.message);
        } else {
          setEngineStatus("waking");
        }
      } finally {
        setSyncing(false);
      }
    },
    [fetchAndCacheDossier, persona, prefetchTopInvoices, pushToast]
  );

  useEffect(() => {
    if (engineStatus !== "waking") return;
    let cancelled = false;
    let timerId: number | undefined;

    const checkHealth = async () => {
      if (cancelled) return;
      setWakeAttempts((n) => n + 1);
      const healthy = await api.pingHealth();
      if (cancelled) return;

      if (healthy) {
        cancelled = true;
        setEngineStatus("live");
        setWakeAttempts(0);
        pushToast(
          "ok",
          "FinOps Control Plane Online",
          "Cloud API booted and synchronized live PostgreSQL state."
        );
        void loadWorkspace();
        return;
      }

      timerId = window.setTimeout(() => {
        void checkHealth();
      }, 4000);
    };

    timerId = window.setTimeout(() => {
      void checkHealth();
    }, 4000);

    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [engineStatus, loadWorkspace, pushToast]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadWorkspace]);

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

  const handleSelectInvoice = useCallback(
    (invoiceId: string, jumpToLedger = false) => {
      const reqSeq = ++selectSeqRef.current;
      const summaryMatch = invoices.find((item) => item.id === invoiceId);
      const cachedDetail = dossierCacheRef.current.get(invoiceId);
      const cachedXml = xmlCacheRef.current.get(invoiceId) ?? null;

      if (cachedDetail) {
        setSelectedInvoice(cachedDetail);
        setSettlementXml(cachedXml);
      } else if (summaryMatch) {
        setSelectedInvoice(optimisticDetailFromSummary(summaryMatch));
        setSettlementXml(null);
      }

      if (jumpToLedger) {
        navigateWorkspace("ledger", "dossier");
      } else if (window.innerWidth < 1024 && dossierRef.current) {
        dossierRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      if (!cachedDetail) {
        void fetchAndCacheDossier(
          invoiceId,
          persona.apiKey,
          summaryMatch?.settlement_reference
        ).then((fresh: InvoiceDetail | null) => {
          if (reqSeq !== selectSeqRef.current) return;
          if (fresh) {
            setSelectedInvoice(fresh);
            setSettlementXml(xmlCacheRef.current.get(invoiceId) ?? null);
          } else {
            pushToast("error", "Unable to Load Dossier", "Failed to fetch invoice details.");
          }
        });
      }
    },
    [fetchAndCacheDossier, invoices, navigateWorkspace, persona.apiKey, pushToast]
  );

  const handleRunPreset = useCallback(
    async (preset: DemoPreset) => {
      setBusyElapsedMs(0);
      setPipelineCompleting(false);
      setBusyAction(preset);
      try {
        const detail = await api.runDemoPreset(persona.apiKey, preset);
        const xmlPromise = detail.settlement_reference
          ? api.getSettlementXml(persona.apiKey, detail.id).catch(() => null)
          : Promise.resolve(null);

        const [xml] = await Promise.all([xmlPromise, finishPipelineSweep()]);
        dossierCacheRef.current.set(detail.id, detail);
        xmlCacheRef.current.set(detail.id, xml);
        setSelectedInvoice(detail);
        setSettlementXml(xml);

        pushToast(
          detail.status === "QUARANTINED_FRAUD_RISK" ? "error" : "ok",
          `Pipeline Complete \u2192 ${detail.status.replaceAll("_", " ")}`,
          `${detail.invoice_number || detail.original_filename} processed in ${detail.processing_ms.toLocaleString("en-US")} ms ($${Number(detail.llm_cost_usd).toFixed(5)}).`
        );
        setStatusFilter("ALL");
        navigateWorkspace("ledger", "dossier");
        void loadWorkspace(detail.id);
      } catch (err) {
        setPipelineCompleting(false);
        setBusyAction(null);
        setBusyElapsedMs(0);
        pushToast(
          "error",
          "Pipeline Execution Failed",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [finishPipelineSweep, loadWorkspace, navigateWorkspace, persona.apiKey, pushToast]
  );

  const processUploadedFile = async (file: File) => {
    setBusyElapsedMs(0);
    setPipelineCompleting(false);
    setBusyAction("upload");
    try {
      const detail = await api.uploadAndProcessInvoice(persona.apiKey, file);
      const xmlPromise = detail.settlement_reference
        ? api.getSettlementXml(persona.apiKey, detail.id).catch(() => null)
        : Promise.resolve(null);

      const [xml] = await Promise.all([xmlPromise, finishPipelineSweep()]);
      dossierCacheRef.current.set(detail.id, detail);
      xmlCacheRef.current.set(detail.id, xml);
      docPreviewCacheRef.current.delete(detail.id);
      setSelectedInvoice(detail);
      setSettlementXml(xml);

      pushToast("ok", `Processed ${file.name}`, `Outcome: ${detail.status.replaceAll("_", " ")}`);
      setStatusFilter("ALL");
      navigateWorkspace("ledger", "dossier");
      void loadWorkspace(detail.id);
    } catch (err) {
      setPipelineCompleting(false);
      setBusyAction(null);
      setBusyElapsedMs(0);
      pushToast(
        "error",
        "Upload Blocked / Failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
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

    setBusyElapsedMs(0);
    setPipelineCompleting(false);
    setBusyAction(`approve:${req.id}`);
    try {
      const res = await api.decideApproval(persona.apiKey, req.id, decision, reason);
      dossierCacheRef.current.delete(req.invoice_id);
      xmlCacheRef.current.delete(req.invoice_id);

      const [fresh] = await Promise.all([
        fetchAndCacheDossier(req.invoice_id, persona.apiKey, res.settlement_reference, true),
        finishPipelineSweep(),
      ]);
      if (fresh) {
        setSelectedInvoice(fresh);
        setSettlementXml(xmlCacheRef.current.get(req.invoice_id) ?? null);
      }

      pushToast(
        "ok",
        decision === "APPROVED"
          ? `Checkpoint Resumed \u2192 ${res.invoice_status}`
          : "Checkpoint Resumed \u2192 REJECTED",
        res.settlement_reference
          ? `ISO 20022 wire staged: ${res.settlement_reference}`
          : "Decision logged immutably to PostgreSQL."
      );
      navigateWorkspace("ledger", "dossier");
      void loadWorkspace(req.invoice_id);
    } catch (err) {
      setPipelineCompleting(false);
      setBusyAction(null);
      setBusyElapsedMs(0);
      pushToast(
        "error",
        "Backend Governance Guard Blocked Action",
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const handleEscalateSla = async (req: ApprovalRequestItem) => {
    setBusyAction(`esc-${req.id}`);
    try {
      await api.escalateApproval(persona.apiKey, req.id);
      dossierCacheRef.current.delete(req.invoice_id);
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
      dossierCacheRef.current.delete(selectedInvoice.id);
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

  const handleConfirmDeleteInvoice = async () => {
    if (!selectedInvoice) return;
    const targetId = selectedInvoice.id;
    const label = selectedInvoice.invoice_number || selectedInvoice.original_filename;
    setBusyAction("delete");
    try {
      await api.deleteInvoice(persona.apiKey, targetId);
      setDeleteModalOpen(false);
      dossierCacheRef.current.delete(targetId);
      xmlCacheRef.current.delete(targetId);
      docPreviewCacheRef.current.delete(targetId);

      // Stage 0: Highlight targeted row + sweep SOX 404 HMAC seal step
      setDeleteAnim({ id: targetId, label, stage: 0 });
      await waitMs(220);

      // Stage 1: Release SHA-256 lock step while dossier begins dissolve
      setDeleteAnim({ id: targetId, label, stage: 1 });
      await waitMs(220);

      // Stage 2: Hit 100% on banner + slide/collapse deleted row cleanly out of Ledger
      setDeleteAnim({ id: targetId, label, stage: 2 });
      const remaining = invoices.filter((inv) => inv.id !== targetId);
      setInvoices(remaining);

      const nextInv = remaining[0];
      if (nextInv) {
        const cachedNext = dossierCacheRef.current.get(nextInv.id);
        selectedInvoiceIdRef.current = nextInv.id;
        setSelectedInvoice(cachedNext ?? optimisticDetailFromSummary(nextInv));
        setSettlementXml(xmlCacheRef.current.get(nextInv.id) ?? null);
      } else {
        selectedInvoiceIdRef.current = null;
        setSelectedInvoice(null);
        setSettlementXml(null);
      }

      // Hold completed 100% emerald state briefly so the full sweep & row collapse finish cleanly
      await waitMs(380);
      setDeleteAnim(null);

      pushToast(
        "ok",
        `Archived & Removed ${label}`,
        "SOX 404 HMAC audit trail preserved; SHA-256 lock released for clean re-upload."
      );
      void loadWorkspace();
    } catch (err) {
      setDeleteAnim(null);
      pushToast(
        "error",
        "SOX 404 RBAC Blocked Deletion",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryInvoice = async (invoiceId: string) => {
    setBusyElapsedMs(0);
    setPipelineCompleting(false);
    setBusyAction("retry");
    try {
      const updated = await api.retryInvoice(persona.apiKey, invoiceId);
      dossierCacheRef.current.delete(invoiceId);
      xmlCacheRef.current.delete(invoiceId);

      const [fresh] = await Promise.all([
        fetchAndCacheDossier(invoiceId, persona.apiKey, updated.settlement_reference, true),
        finishPipelineSweep(),
      ]);
      if (fresh) {
        setSelectedInvoice(fresh);
        setSettlementXml(xmlCacheRef.current.get(invoiceId) ?? null);
      }
      pushToast(
        "ok",
        `Self-Healing Retry Complete \u2192 ${updated.status.replaceAll("_", " ")}`,
        "Workflow re-executed idempotently and audited to PostgreSQL."
      );
      void loadWorkspace(invoiceId);
    } catch (err) {
      setPipelineCompleting(false);
      setBusyAction(null);
      setBusyElapsedMs(0);
      pushToast("error", "Retry Blocked", err instanceof Error ? err.message : String(err));
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

  const handleOpenDocumentPreview = useCallback(
    async (invoiceId: string, label: string) => {
      setDocModalInvoiceId(invoiceId);
      setDocModalLabel(label);
      setDocModalError(null);
      setDocModalOpen(true);

      const cached = docPreviewCacheRef.current.get(invoiceId);
      if (cached) {
        setDocPreview(cached);
        setDocModalLoading(false);
        return;
      }

      setDocPreview(null);
      setDocModalLoading(true);
      try {
        const res = await api.getDocumentPreview(persona.apiKey, invoiceId);
        docPreviewCacheRef.current.set(invoiceId, res);
        setDocPreview(res);
      } catch (err) {
        setDocModalError(
          err instanceof Error ? err.message : "Unable to load source document preview."
        );
      } finally {
        setDocModalLoading(false);
      }
    },
    [persona.apiKey]
  );

  const handleDownloadSourceDocument = useCallback(async () => {
    if (!docModalInvoiceId) return;
    setDocModalDownloading(true);
    try {
      const blob = await api.downloadOriginalDocument(persona.apiKey, docModalInvoiceId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = docPreview?.filename || `${docModalLabel || "invoice"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      pushToast(
        "error",
        "Download Blocked",
        err instanceof Error ? err.message : "Unable to download document."
      );
    } finally {
      setDocModalDownloading(false);
    }
  }, [docModalInvoiceId, docModalLabel, docPreview?.filename, persona.apiKey, pushToast]);

  const handleCopyXml = async () => {
    if (!settlementXml) return;
    await navigator.clipboard.writeText(settlementXml);
    setCopiedXml(true);
    pushToast("ok", "Copied ISO 20022 XML", "pain.001.001.03 payload copied to clipboard.");
    window.setTimeout(() => setCopiedXml(false), 2000);
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

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "nav-command",
        group: "Navigate",
        label: "Command Center",
        hint: "Overview & Vault",
        icon: "nav",
        onSelect: () => navigateWorkspace("command", "top"),
      },
      {
        id: "nav-ledger",
        group: "Navigate",
        label: "Invoice Ledger & Dossier",
        hint: `${invoices.length} records`,
        icon: "nav",
        onSelect: () => openLedgerWithFilter("ALL"),
      },
      {
        id: "nav-approvals",
        group: "Navigate",
        label: "HITL Approval Queue",
        hint: `${approvals.length} pending`,
        icon: "clock",
        onSelect: () => navigateWorkspace("approvals", "top"),
      },
      {
        id: "nav-vendors",
        group: "Navigate",
        label: "Vendors & MSA Contract RAG",
        hint: `${vendors.length} vendors`,
        icon: "nav",
        onSelect: () => {
          setIntelTab("vendors");
          navigateWorkspace("intelligence", "top");
        },
      },
      {
        id: "nav-analytics",
        group: "Navigate",
        label: "Security Posture, Analytics & DLQ",
        hint: "SOX 404 & HMAC",
        icon: "nav",
        onSelect: () => {
          setIntelTab("analytics");
          navigateWorkspace("intelligence", "top");
        },
      },
      ...PRESET_CARDS.map((card) => ({
        id: `run-${card.id}`,
        group: "Run Scenario" as const,
        label: `Sandbox: ${card.title} (${card.amount})`,
        hint: card.tag,
        icon: "play" as const,
        onSelect: () => void handleRunPreset(card.id),
      })),
      ...DEMO_PERSONAS.map((p) => ({
        id: `persona-${p.key}`,
        group: "Switch Persona" as const,
        label: `${p.label} \u2014 ${p.roleTitle}`,
        hint: p.limitLabel,
        icon: "persona" as const,
        onSelect: () => {
          setPersona(p);
          pushToast(
            "info",
            `Switched Identity \u2192 ${p.label}`,
            `${p.roleTitle} (${p.limitLabel})`
          );
        },
      })),
      {
        id: "sys-theme",
        group: "System",
        label: `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`,
        hint: "Dual-Mode UI",
        icon: "theme",
        onSelect: toggleTheme,
      },
      {
        id: "sys-sync",
        group: "System",
        label: "Sync Live PostgreSQL State",
        hint: "API Refresh",
        icon: "sync",
        onSelect: () => {
          dossierCacheRef.current.clear();
          xmlCacheRef.current.clear();
          void loadWorkspace();
        },
      },
    ],
    [
      approvals.length,
      handleRunPreset,
      invoices.length,
      loadWorkspace,
      navigateWorkspace,
      openLedgerWithFilter,
      pushToast,
      theme,
      toggleTheme,
      vendors.length,
    ]
  );

  const railItems: Array<{
    id: Workspace;
    label: string;
    short: string;
    badge?: number;
    pulse?: boolean;
    Icon: typeof LayoutDashboard;
  }> = [
    { id: "command", label: "Command", short: "Command", Icon: LayoutDashboard },
    { id: "ledger", label: "Ledger", short: "Ledger", badge: invoices.length, Icon: Activity },
    {
      id: "approvals",
      label: "Approvals",
      short: "HITL",
      badge: approvals.length,
      pulse: approvals.length > 0,
      Icon: Clock,
    },
    {
      id: "intelligence",
      label: "Intelligence",
      short: "Intel",
      badge: vendors.length,
      Icon: Building2,
    },
  ];

  const enginePillClass =
    engineStatus === "live"
      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : engineStatus === "waking"
        ? "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300"
        : "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";

  const engineDotClass =
    engineStatus === "live"
      ? "animate-pulse bg-emerald-500"
      : engineStatus === "waking"
        ? "animate-ping bg-amber-500"
        : "animate-pulse bg-sky-500";

  const engineLabel =
    engineStatus === "live"
      ? "API ONLINE"
      : engineStatus === "waking"
        ? "WAKING API"
        : "SYNCING";

  const isSelectedDeleting = Boolean(deleteAnim && selectedInvoice && deleteAnim.id === selectedInvoice.id);

  return (
    <div className="finops-canvas min-h-screen pb-20 text-slate-900 dark:text-slate-100 lg:pb-0">
      {/* Dedicated Stacking-Context-Safe Topographic Background Layer */}
      <div aria-hidden="true" className="topo-backdrop">
        <div className="topo-backdrop-image" />
        <div className="topo-backdrop-glow" />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Desktop Left Precision Dock */}
      <aside className="fixed top-0 bottom-0 left-0 z-30 hidden w-[232px] flex-col justify-between border-r border-slate-200/75 bg-white/70 px-3.5 py-5 backdrop-blur-2xl dark:border-slate-800/80 dark:bg-[#090d16]/76 lg:flex">
        <div>
          <div className="mb-7 flex items-center gap-3 px-2">
            <motion.div
              whileHover={{ scale: 1.06 }}
              transition={{ type: "spring", stiffness: 420, damping: 24 }}
              className="relative h-9 w-9 shrink-0 overflow-hidden rounded-xl ring-1 ring-slate-900/12 shadow-sm dark:ring-white/15"
            >
              <Image
                src="/logo_light.png"
                alt="LedgerPilot"
                width={36}
                height={36}
                priority
                className="h-full w-full object-cover dark:hidden"
              />
              <Image
                src="/logo_dark.png"
                alt="LedgerPilot"
                width={36}
                height={36}
                priority
                className="hidden h-full w-full object-cover dark:block"
              />
            </motion.div>
            <div>
              <div className="text-sm font-bold tracking-tight text-slate-950 dark:text-white">
                LedgerPilot
              </div>
              <div className="font-mono text-[10px] font-medium text-slate-500 dark:text-slate-400">
                AP CONTROL PLANE
              </div>
            </div>
          </div>

          <div className="mb-2 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Workspaces
          </div>
          <nav className="space-y-1">
            {railItems.map((item) => {
              const active = workspace === item.id;
              const Icon = item.Icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateWorkspace(item.id, "top")}
                  className={`group relative flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors duration-150 ${
                    active
                      ? "text-slate-950 dark:text-white"
                      : "text-slate-600 hover:bg-slate-900/4 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-white/4 dark:hover:text-slate-100"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="desktopRailActive"
                      transition={{ type: "spring", stiffness: 620, damping: 46, mass: 0.7 }}
                      className="pointer-events-none absolute inset-0 rounded-xl bg-slate-900/6 ring-1 ring-slate-900/8 dark:bg-white/8 dark:ring-white/10"
                    />
                  )}
                  {active && (
                    <motion.span
                      layoutId="desktopRailBar"
                      transition={{ type: "spring", stiffness: 620, damping: 46, mass: 0.7 }}
                      className="pointer-events-none absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-sky-500 shadow-[0_0_10px_rgba(14,165,233,0.75)] dark:bg-sky-400"
                    />
                  )}

                  <span className="relative z-10 flex items-center gap-2.5">
                    <Icon
                      className={`h-4 w-4 transition-colors duration-150 ${
                        active
                          ? "text-sky-600 dark:text-sky-400"
                          : "text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200"
                      }`}
                    />
                    {item.label}
                  </span>

                  {typeof item.badge === "number" && (
                    <span
                      className={`relative z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors ${
                        item.pulse
                          ? "bg-sky-500/15 font-bold text-sky-700 dark:text-sky-300"
                          : active
                            ? "bg-white/90 text-slate-800 shadow-xs ring-1 ring-slate-900/5 dark:bg-slate-900 dark:text-slate-200 dark:ring-white/10"
                            : "bg-slate-200/75 text-slate-600 dark:bg-slate-800/80 dark:text-slate-400"
                      }`}
                    >
                      {item.pulse && (
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
                      )}
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-7 border-t border-slate-200/80 pt-5 dark:border-slate-800/80">
            <div className="mb-2 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Testing Tools
            </div>
            <button
              type="button"
              onClick={() => setSandboxOpen(true)}
              className="group flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-200/80 bg-white/60 px-3 py-2.5 text-xs font-semibold text-slate-700 transition-colors duration-150 hover:border-cyan-500/40 hover:bg-cyan-500/6 hover:text-slate-950 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-200 dark:hover:border-cyan-500/40 dark:hover:bg-cyan-500/10 dark:hover:text-white"
            >
              <span className="flex items-center gap-2.5">
                <FlaskConical className="h-4 w-4 text-cyan-600 transition-transform duration-200 group-hover:-rotate-8 dark:text-cyan-400" />
                Sandbox Simulator
              </span>
              <span className="rounded-md bg-cyan-500/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">
                4
              </span>
            </button>
          </div>
        </div>

        <div className="tactile-well mb-12 rounded-xl px-3 py-2.5 text-[11px] text-slate-500 dark:text-slate-400">
          <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            ISO 20022 &middot; SOX 404
          </div>
          <div className="mt-0.5 font-mono text-[10px]">
            {evalScorecard?.available
              ? `${evalScorecard.overall_accuracy_pct}% Eval Acc \u00B7 ${evalScorecard.total_cases} PDFs`
              : "OWASP + pgvector RAG"}
          </div>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="relative z-10 lg:pl-[232px]">
        {/* Top Command Bar — backdrop blur isolated onto sibling layer so popovers never snap */}
        <header className="sticky top-0 z-30">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 border-b border-slate-200/75 bg-white/75 backdrop-blur-2xl dark:border-slate-800/80 dark:bg-[#070b14]/80"
          />
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg ring-1 ring-slate-900/12 dark:ring-white/15 lg:hidden">
                <Image
                  src="/logo_light.png"
                  alt="LedgerPilot"
                  width={32}
                  height={32}
                  priority
                  className="h-full w-full object-cover dark:hidden"
                />
                <Image
                  src="/logo_dark.png"
                  alt="LedgerPilot"
                  width={32}
                  height={32}
                  priority
                  className="hidden h-full w-full object-cover dark:block"
                />
              </div>

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="tactile-well group flex h-9 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-xs text-slate-500 transition hover:border-sky-500/45 dark:text-slate-400"
              >
                <Search className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-sky-500" />
                <span className="hidden md:inline">Search commands, ledger, roles...</span>
                <span className="md:hidden">Search...</span>
                <kbd className="inline-flex items-center gap-0.5 rounded-md border border-slate-300/80 bg-white/85 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                  <Command className="h-2.5 w-2.5" />K
                </kbd>
              </button>

              <span
                className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold xl:inline-flex ${enginePillClass}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${engineDotClass}`} />
                {engineLabel}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSandboxOpen(true)}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3 text-xs font-semibold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300 lg:hidden"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sandbox</span>
              </button>

              <OpaquePersonaPopover
                persona={persona}
                personas={DEMO_PERSONAS}
                onSelect={(found) => {
                  setPersona(found);
                  pushToast(
                    "info",
                    `Switched Identity \u2192 ${found.label}`,
                    `${found.roleTitle} (${found.limitLabel}) active on all API requests.`
                  );
                }}
              />

              <button
                type="button"
                onClick={() => {
                  dossierCacheRef.current.clear();
                  xmlCacheRef.current.clear();
                  void loadWorkspace();
                }}
                aria-label="Sync live state"
                title="Sync Live PostgreSQL State"
                className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-slate-200/90 bg-white/90 text-slate-600 shadow-xs transition-colors hover:border-slate-300 hover:text-slate-950 active:opacity-80 dark:border-slate-700/80 dark:bg-slate-900/90 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:text-white"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin text-sky-500" : ""}`} />
              </button>

              <TactileThemeToggle theme={theme} onToggle={toggleTheme} />
            </div>
          </div>
        </header>

        {/* Main Workspace Container */}
        <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6">
          {/* Cloud Cold-Start Auto-Wakeup Banner */}
          <AnimatePresence>
            {engineStatus === "waking" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 backdrop-blur-md">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                    <div>
                      <div className="text-xs font-bold text-amber-900 dark:text-amber-200">
                        Waking Cloud FinOps Backend Engine...
                      </div>
                      <div className="font-mono text-[11px] text-amber-800/80 dark:text-amber-200/80">
                        Free-tier Render instances sleep after 15m idle (~30&ndash;50s cold boot).
                        Auto-syncing{wakeAttempts > 0 ? ` (check #${wakeAttempts})` : ""}...
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadWorkspace()}
                    className="cursor-pointer rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-500/25 dark:text-amber-100"
                  >
                    Retry Now
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Live 5-Stage LangGraph Pipeline Visualizer (Only for actual LangGraph runs) */}
          <AnimatePresence>
            {showPipelineRail && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <LivePipelineRail
                  activeStageIdx={liveStageIdx}
                  stageMessage={liveStageMessage}
                  completed={pipelineCompleting}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Synced 3-Stage SOX 404 Archive & Removal Visualizer */}
          <AnimatePresence>
            {deleteAnim && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <DeleteArchiveBanner label={deleteAnim.label} stage={deleteAnim.stage} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Active Workspace Views */}
          <AnimatePresence mode="wait" onExitComplete={executePendingScroll}>
            <motion.div
              key={workspace}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
              className="space-y-5"
            >
              {/* ============================================================
                  WORKSPACE 1: COMMAND (Strict 4 / 8 Architectural Grid)
                  ============================================================ */}
              {workspace === "command" && (
                <>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h1 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">
                        AP Command Overview
                      </h1>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Autonomous invoice verification, pgvector contract compliance, and ISO 20022
                        settlement staging.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-slate-900/15 transition-colors hover:bg-slate-800 active:opacity-90 disabled:opacity-50 dark:bg-sky-500 dark:text-slate-950 dark:shadow-sky-500/20 dark:hover:bg-sky-400"
                    >
                      <FileUp className="h-3.5 w-3.5" />
                      {busyAction === "upload" ? "Processing PDF..." : "Ingest Invoice"}
                    </button>
                  </div>

                  {/* Row 1 (4 / 8): Dial + 6 Interactive Distinctly Colored KPI Cards */}
                  <section className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
                    <div className="lg:col-span-4">
                      <FinOpsDialGauge metrics={metrics} evalScorecard={evalScorecard} />
                    </div>

                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:col-span-8">
                      <KpiBento
                        label="Total Processed"
                        sub="SHA-256 Deduplicated"
                        icon={FileText}
                        iconTone="text-indigo-600 dark:text-indigo-400"
                        tone="indigo"
                        onClick={() => openLedgerWithFilter("ALL")}
                        loading={!metrics}
                      >
                        {metrics && <AnimatedNumber value={metrics.total_invoices} />}
                      </KpiBento>

                      <KpiBento
                        label="Payments Staged"
                        sub={`${metrics?.payment_staged_count ?? 0} ${(metrics?.payment_staged_count ?? 0) === 1 ? "ISO 20022 XML" : "ISO 20022 XMLs"} \u00B7 USD eq.`}
                        icon={DollarSign}
                        iconTone="text-emerald-600 dark:text-emerald-400"
                        accent="text-emerald-600 dark:text-emerald-400"
                        tone="emerald"
                        onClick={() => openLedgerWithFilter("PAYMENT_STAGED")}
                        loading={!metrics}
                      >
                        {metrics && (
                          <AnimatedNumber
                            value={Number(metrics.total_staged_amount)}
                            prefix="$"
                            decimals={2}
                          />
                        )}
                      </KpiBento>

                      <KpiBento
                        label="Pending HITL"
                        sub="Awaiting Sign-Off"
                        icon={Clock}
                        iconTone="text-cyan-600 dark:text-cyan-400"
                        accent="text-cyan-600 dark:text-cyan-400"
                        tone="cyan"
                        onClick={() => navigateWorkspace("approvals", "top")}
                        loading={!metrics}
                      >
                        {metrics && <AnimatedNumber value={metrics.pending_approvals_count} />}
                      </KpiBento>

                      <KpiBento
                        label="Fraud Blocked"
                        sub="0% Wire Leakage"
                        icon={ShieldAlert}
                        iconTone="text-rose-600 dark:text-rose-400"
                        accent="text-rose-600 dark:text-rose-400"
                        tone="rose"
                        onClick={() => openLedgerWithFilter("QUARANTINED_FRAUD_RISK")}
                        loading={!metrics}
                      >
                        {metrics && <AnimatedNumber value={metrics.quarantined_fraud_count} />}
                      </KpiBento>

                      <KpiBento
                        label="Avg Latency"
                        sub="End-to-End Pipeline"
                        icon={Gauge}
                        iconTone="text-violet-600 dark:text-violet-400"
                        accent="text-violet-700 dark:text-violet-300"
                        tone="violet"
                        loading={!metrics}
                      >
                        {metrics && (
                          <AnimatedNumber value={metrics.avg_processing_ms} suffix=" ms" />
                        )}
                      </KpiBento>

                      <KpiBento
                        label="Total LLM Cost"
                        sub="Gemini 4 Hydrogen"
                        icon={Cpu}
                        iconTone="text-amber-600 dark:text-amber-400"
                        accent="text-amber-700 dark:text-amber-300"
                        tone="amber"
                        loading={!metrics}
                      >
                        {metrics && (
                          <AnimatedNumber
                            value={Number(metrics.total_llm_cost_usd)}
                            prefix="$"
                            decimals={4}
                          />
                        )}
                      </KpiBento>
                    </div>
                  </section>

                  {/* Row 2 (Aligned 4 / 8): Vault directly under Dial, Activity under KPIs */}
                  <section className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
                    <SpotlightCard
                      tone="teal"
                      onDragOver={(e) => {
                        e.preventDefault();
                        setIsDragging(true);
                      }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      className={`flex flex-col justify-between p-5 lg:col-span-4 ${
                        isDragging
                          ? "border-teal-500 ring-2 ring-teal-500/35 shadow-[0_0_40px_-10px_rgba(20,184,166,0.55)]"
                          : ""
                      }`}
                    >
                      <div className="min-h-[46px]">
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-sm font-bold text-slate-950 dark:text-white">
                            Invoice Ingestion Vault
                          </h2>
                          <span className="shrink-0 rounded-md bg-teal-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                            PDF / IMG
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                          Forensics, 3-way match &amp; policy routing.
                        </p>
                      </div>

                      <div
                        onClick={() => fileInputRef.current?.click()}
                        className="tactile-well group my-4 flex min-h-[176px] flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-4 py-7 text-center transition hover:border-teal-500/60 dark:border-slate-700"
                      >
                        <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/12 text-teal-600 transition-colors dark:text-teal-400">
                          {busyAction === "upload" ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <UploadCloud className="h-5 w-5" />
                          )}
                        </div>
                        <div className="text-xs font-bold text-slate-900 dark:text-white">
                          {busyAction === "upload"
                            ? "Running live pipeline..."
                            : "Drag & drop invoice or browse"}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                          SHA-256 idempotent deduplication
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-slate-200/80 pt-3 text-xs dark:border-slate-800/80">
                        <span className="text-slate-500 dark:text-slate-400">No PDF handy?</span>
                        <button
                          type="button"
                          onClick={() => setSandboxOpen(true)}
                          className="inline-flex cursor-pointer items-center gap-1 font-semibold text-teal-600 hover:underline dark:text-teal-400"
                        >
                          Open Sandbox
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </SpotlightCard>

                    <SpotlightCard
                      tone="blue"
                      className="flex flex-col justify-between p-5 lg:col-span-8"
                    >
                      <div className="min-h-[46px]">
                        <div className="flex items-center justify-between gap-2">
                          <h2 className="text-sm font-bold text-slate-950 dark:text-white">
                            Recent Ledger Activity
                          </h2>
                          <button
                            type="button"
                            onClick={() => openLedgerWithFilter("ALL")}
                            className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                          >
                            View All ({invoices.length})
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                          Click any processed record to inspect forensics, citations &amp; ISO 20022
                          XML.
                        </p>
                      </div>

                      {invoices.length === 0 ? (
                        <div className="tactile-well my-4 flex min-h-[176px] flex-1 flex-col items-center justify-center rounded-xl px-4 py-7 text-center">
                          <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/12 text-blue-600 dark:text-blue-400">
                            <Sparkles className="h-5 w-5" />
                          </div>
                          <div className="text-xs font-bold text-slate-900 dark:text-white">
                            Ledger Ready for Ingestion
                          </div>
                          <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
                            Upload an invoice on the left or launch a sample scenario from the
                            Sandbox Simulator.
                          </p>
                        </div>
                      ) : (
                        <div className="my-4 min-h-[176px] flex-1 space-y-2">
                          {invoices.slice(0, 4).map((inv) => (
                            <button
                              key={inv.id}
                              type="button"
                              onMouseEnter={() =>
                                void fetchAndCacheDossier(
                                  inv.id,
                                  persona.apiKey,
                                  inv.settlement_reference
                                )
                              }
                              onClick={() => handleSelectInvoice(inv.id, true)}
                              className="tactile-well group flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition hover:border-blue-500/45"
                            >
                              <div className="min-w-0">
                                <div className="truncate font-mono text-xs font-bold text-slate-900 dark:text-white">
                                  {inv.invoice_number || inv.original_filename}
                                </div>
                                <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                                  {inv.po_number || inv.source_channel} &middot;{" "}
                                  {inv.processing_ms.toLocaleString("en-US")} ms
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                <span className="font-mono text-xs font-bold text-slate-800 tabular-nums dark:text-slate-200">
                                  {inv.total_amount
                                    ? `${inv.currency || "USD"} ${inv.total_amount}`
                                    : "\u2014"}
                                </span>
                                <span
                                  className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${
                                    STATUS_BADGE[inv.status] || STATUS_BADGE.RECEIVED
                                  }`}
                                >
                                  {inv.status.replaceAll("_", " ")}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between border-t border-slate-200/80 pt-3 text-xs dark:border-slate-800/80">
                        <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          Append-only PostgreSQL &middot; HMAC-SHA256 sealed
                        </span>
                        <button
                          type="button"
                          onClick={() => openLedgerWithFilter("ALL")}
                          className="inline-flex cursor-pointer items-center gap-1 font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Open Ledger
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </SpotlightCard>
                  </section>
                </>
              )}

              {/* ============================================================
                  WORKSPACE 2: LEDGER & AUDIT DOSSIER (0ms Switch + Delete FX)
                  ============================================================ */}
              {workspace === "ledger" && (
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h1 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">
                        Invoice Ledger &amp; Audit Dossier
                      </h1>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Forensic telemetry, 3-way match verification, pgvector citations, and
                        HMAC-sealed audit trail.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={busyAction !== null}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-slate-900/15 transition-colors hover:bg-slate-800 active:opacity-90 disabled:opacity-50 dark:bg-sky-500 dark:text-slate-950 dark:shadow-sky-500/20 dark:hover:bg-sky-400"
                    >
                      <FileUp className="h-3.5 w-3.5" />
                      {busyAction === "upload" ? "Processing PDF..." : "Ingest PDF"}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-12">
                    <div className="flex flex-col lg:col-span-4">
                      <SpotlightCard tone="indigo" className="flex h-full flex-col p-4">
                        <div className="relative mb-3">
                          <Search className="pointer-events-none absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-400" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search invoice #, PO, or file..."
                            className="tactile-well w-full rounded-xl py-2 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
                          />
                        </div>

                        <div className="tactile-well mb-3 grid grid-cols-5 gap-1 rounded-xl p-1">
                          {(
                            [
                              ["ALL", "All"],
                              ["PAYMENT_STAGED", "Staged"],
                              ["AWAITING_APPROVAL", "HITL"],
                              ["QUARANTINED_FRAUD_RISK", "Fraud"],
                              ["REJECTED", "Rejected"],
                            ] as const
                          ).map(([code, label]) => {
                            const active = statusFilter === code;
                            return (
                              <button
                                key={code}
                                type="button"
                                onClick={() => setStatusFilter(code)}
                                className={`relative cursor-pointer rounded-lg px-1 py-1 text-center text-[10px] font-semibold transition-colors ${
                                  active
                                    ? "text-slate-950 dark:text-white"
                                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                                }`}
                              >
                                {active && (
                                  <motion.span
                                    layoutId="ledgerFilterPill"
                                    transition={{ type: "spring", stiffness: 580, damping: 42 }}
                                    className="absolute inset-0 rounded-lg bg-white shadow-xs ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/15"
                                  />
                                )}
                                <span className="relative z-10">{label}</span>
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex max-h-[700px] flex-1 flex-col overflow-y-auto pr-0.5">
                          {filteredInvoices.length === 0 ? (
                            <div className="tactile-well flex min-h-[248px] flex-1 flex-col items-center justify-center rounded-xl px-4 py-10 text-center">
                              <FileText className="mb-2 h-5 w-5 text-slate-400" />
                              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                                No Matching Invoices
                              </div>
                              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                                Upload a PDF or run a Sandbox sample to populate the ledger.
                              </p>
                            </div>
                          ) : (
                            <AnimatePresence initial={false}>
                              {filteredInvoices.map((inv) => {
                                const active = selectedInvoice?.id === inv.id;
                                const isArchivingThis = deleteAnim?.id === inv.id;
                                return (
                                  <motion.div
                                    key={inv.id}
                                    layout="position"
                                    initial={false}
                                    animate={{
                                      opacity: isArchivingThis ? 0.88 : 1,
                                      x: 0,
                                      scale: isArchivingThis ? 0.985 : 1,
                                    }}
                                    exit={{
                                      opacity: 0,
                                      x: -38,
                                      scale: 0.95,
                                      height: 0,
                                      marginBottom: 0,
                                      overflow: "hidden",
                                    }}
                                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                                    className="mb-2 last:mb-0"
                                  >
                                    <button
                                      type="button"
                                      disabled={isArchivingThis}
                                      onMouseEnter={() =>
                                        void fetchAndCacheDossier(
                                          inv.id,
                                          persona.apiKey,
                                          inv.settlement_reference
                                        )
                                      }
                                      onClick={() => handleSelectInvoice(inv.id)}
                                      className={`relative w-full cursor-pointer overflow-hidden rounded-xl border p-3 text-left transition-colors ${
                                        isArchivingThis
                                          ? "border-rose-500/75 bg-rose-500/12 shadow-[0_0_24px_-8px_rgba(244,63,94,0.65)] dark:bg-rose-500/18"
                                          : active
                                            ? "border-indigo-500/60 bg-indigo-500/8 shadow-[0_0_24px_-12px_rgba(99,102,241,0.5)] dark:bg-indigo-500/12"
                                            : "border-slate-200/80 bg-white/70 hover:border-slate-300 dark:border-slate-800/80 dark:bg-slate-950/60 dark:hover:border-slate-700"
                                      }`}
                                    >
                                      {isArchivingThis && (
                                        <motion.span
                                          aria-hidden="true"
                                          initial={{ x: "-100%" }}
                                          animate={{ x: "220%" }}
                                          transition={{
                                            repeat: Infinity,
                                            duration: 0.75,
                                            ease: "linear",
                                          }}
                                          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-linear-to-r from-transparent via-rose-400/35 to-transparent"
                                        />
                                      )}
                                      <div className="relative z-10 flex items-center justify-between gap-2">
                                        <span className="truncate font-mono text-xs font-bold text-slate-900 dark:text-white">
                                          {inv.invoice_number || inv.original_filename}
                                        </span>
                                        {isArchivingThis ? (
                                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/50 bg-rose-500/15 px-2 py-0.5 font-mono text-[9px] font-bold text-rose-700 dark:text-rose-200">
                                            <Trash2 className="h-2.5 w-2.5" />
                                            ARCHIVING
                                          </span>
                                        ) : (
                                          <span
                                            className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${
                                              STATUS_BADGE[inv.status] || STATUS_BADGE.RECEIVED
                                            }`}
                                          >
                                            {inv.status.replaceAll("_", " ")}
                                          </span>
                                        )}
                                      </div>
                                      <div className="relative z-10 mt-1.5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                                        <span className="truncate">
                                          {inv.po_number || inv.source_channel}
                                        </span>
                                        <span className="font-mono font-semibold text-slate-800 tabular-nums dark:text-slate-200">
                                          {inv.total_amount
                                            ? `${inv.currency || "USD"} ${inv.total_amount}`
                                            : "\u2014"}
                                        </span>
                                      </div>
                                      {inv.risk_flags.length > 0 && (
                                        <div className="relative z-10 mt-2 flex flex-wrap gap-1">
                                          {inv.risk_flags.slice(0, 3).map((flag) => (
                                            <span
                                              key={flag}
                                              className="rounded bg-rose-500/12 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-rose-700 dark:text-rose-300"
                                            >
                                              {flag}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </button>
                                  </motion.div>
                                );
                              })}
                            </AnimatePresence>
                          )}
                        </div>
                      </SpotlightCard>
                    </div>

                    <div ref={dossierRef} className="flex scroll-mt-20 flex-col space-y-4 lg:col-span-8">
                      {!selectedInvoice ? (
                        <SpotlightCard
                          tone="blue"
                          className="flex h-full min-h-[360px] flex-1 flex-col items-center justify-center p-10 text-center"
                        >
                          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/12 text-blue-600 dark:text-blue-400">
                            <Activity className="h-5 w-5" />
                          </div>
                          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                            No Invoice Selected
                          </h3>
                          <p className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                            Select an invoice from the ledger or run a live payload through the
                            Sandbox Simulator to inspect its full cryptographic dossier.
                          </p>
                          <button
                            type="button"
                            onClick={() => setSandboxOpen(true)}
                            className="mt-4 inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-blue-500/35 bg-blue-500/10 px-3.5 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-500/20 dark:text-blue-300"
                          >
                            <FlaskConical className="h-3.5 w-3.5" />
                            Open Sandbox Simulator
                          </button>
                        </SpotlightCard>
                      ) : (
                        <motion.div
                          animate={{
                            opacity: isSelectedDeleting ? 0.32 : 1,
                            scale: isSelectedDeleting ? 0.985 : 1,
                          }}
                          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                          className="space-y-4"
                        >
                          <SpotlightCard tone="blue" className="p-5">
                            <div className="space-y-3">
                              {/* Row 1: Invoice Title + Status (Left) | Grand Total (Right) */}
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                                  <h2 className="truncate font-mono text-lg font-bold text-slate-950 dark:text-white">
                                    {selectedInvoice.invoice_number ||
                                      selectedInvoice.original_filename}
                                  </h2>
                                  <span
                                    className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold ${
                                      STATUS_BADGE[selectedInvoice.status] || STATUS_BADGE.RECEIVED
                                    }`}
                                  >
                                    {selectedInvoice.status}
                                  </span>
                                </div>

                                <div className="shrink-0 font-mono text-2xl font-bold text-slate-950 tabular-nums dark:text-white">
                                  {selectedInvoice.total_amount
                                    ? `${selectedInvoice.currency || "USD"} ${selectedInvoice.total_amount}`
                                    : "Pending"}
                                </div>
                              </div>

                              {/* Row 2: Metadata (Left) | Action Buttons Flush-Right */}
                              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/75 pt-3 dark:border-slate-800/80">
                                <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                                  PO: {selectedInvoice.po_number || "N/A"} &middot; IBAN:{" "}
                                  {selectedInvoice.extracted_iban || "N/A"} &middot; Cost: $
                                  {Number(selectedInvoice.llm_cost_usd).toFixed(5)} &middot;
                                  Latency: {selectedInvoice.processing_ms.toLocaleString("en-US")} ms
                                </p>

                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleOpenDocumentPreview(
                                        selectedInvoice.id,
                                        selectedInvoice.original_filename ||
                                          selectedInvoice.invoice_number ||
                                          "Source Invoice"
                                      )
                                    }
                                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-200"
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                    View Source PDF
                                  </button>
                                  {(selectedInvoice.status === "RECEIVED" ||
                                    selectedInvoice.status === "FAILED") && (
                                    <button
                                      type="button"
                                      disabled={busyAction !== null}
                                      onClick={() => void handleRetryInvoice(selectedInvoice.id)}
                                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/12 px-3 py-1.5 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-200"
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
                                      Run / Retry Pipeline
                                    </button>
                                  )}
                                  {selectedInvoice.status !== "PAYMENT_STAGED" &&
                                    selectedInvoice.status !== "QUARANTINED_FRAUD_RISK" && (
                                      <button
                                        type="button"
                                        onClick={() => setHoldModalOpen(true)}
                                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-500/20 dark:text-rose-300"
                                      >
                                        <ShieldBan className="h-3.5 w-3.5" />
                                        Place Manual Fraud Hold
                                      </button>
                                    )}
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    onClick={() => setDeleteModalOpen(true)}
                                    title={
                                      persona.key === "ADMIN"
                                        ? "Archive & remove invoice (preserves SOX 404 audit trail)"
                                        : "Platform Admin (Amaan Shaikh) required under SOX 404"
                                    }
                                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300/90 bg-white/80 px-3 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300 dark:hover:border-rose-500/50 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </div>

                            <div className="mt-4">
                              <WorkflowStepper invoice={selectedInvoice} />
                            </div>
                          </SpotlightCard>

                          <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
                            <SpotlightCard tone="rose" className="flex h-full flex-col p-4">
                              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                                <ShieldAlert className="h-4 w-4 text-rose-500" />
                                PDF Forensics &amp; OWASP Guard
                              </div>
                              <div className="space-y-2 text-xs">
                                <div className="flex justify-between">
                                  <span className="text-slate-500 dark:text-slate-400">
                                    Risk Score
                                  </span>
                                  <span className="font-mono font-bold text-slate-900 dark:text-white">
                                    {selectedInvoice.security_report?.risk_score ?? 0} / 100
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-slate-500 dark:text-slate-400">
                                    Prompt Injection
                                  </span>
                                  <span
                                    className={
                                      selectedInvoice.security_report?.prompt_injection_detected
                                        ? "font-bold text-rose-600 dark:text-rose-400"
                                        : "font-semibold text-emerald-600 dark:text-emerald-400"
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
                                        className="rounded-xl border border-rose-500/35 bg-rose-500/8 p-2.5 dark:bg-rose-950/40"
                                      >
                                        <div className="font-mono text-[11px] font-bold text-rose-700 dark:text-rose-300">
                                          [{f.severity}] {f.finding_type}
                                        </div>
                                        <p className="mt-1 text-[11px] text-rose-800/90 dark:text-rose-200/90">
                                          {f.detail}
                                        </p>
                                        <code className="mt-1 block truncate rounded bg-white/80 px-2 py-1 font-mono text-[10px] text-rose-800 dark:bg-slate-950/70 dark:text-rose-200">
                                          &ldquo;{f.snippet}&rdquo;
                                        </code>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </SpotlightCard>

                            <SpotlightCard tone="emerald" className="flex h-full flex-col p-4">
                              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                Deterministic Decimal 3-Way Match
                              </div>
                              <p className="mb-3 text-xs text-slate-600 dark:text-slate-300">
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
                                      className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-2 font-mono text-[11px] text-amber-800 dark:text-amber-200"
                                    >
                                      <strong>{v.issue}</strong>: expected {v.expected_value}, got{" "}
                                      {v.actual_value}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </SpotlightCard>
                          </div>

                          <SpotlightCard tone="cyan" className="p-4">
                            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                              <BookOpen className="h-4 w-4 text-cyan-500" />
                              Verified Vendor MSA Clauses (pgvector Hybrid RAG)
                            </div>
                            {selectedInvoice.rag_citations.length === 0 ? (
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                No MSA citations recorded for this invoice.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                {selectedInvoice.rag_citations.map((cit) => (
                                  <div key={cit.chunk_id} className="tactile-well rounded-xl p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-mono text-xs font-bold text-cyan-700 dark:text-cyan-300">
                                        [{cit.citation_id}] {cit.document_name} &middot;{" "}
                                        {cit.clause_ref}
                                      </span>
                                      <span className="rounded bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-700 dark:text-cyan-200">
                                        similarity {(cit.similarity_score * 100).toFixed(1)}%
                                      </span>
                                    </div>
                                    <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                                      {cit.excerpt}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </SpotlightCard>

                          {settlementXml && (
                            <SpotlightCard tone="teal" className="border-emerald-500/35 p-4">
                              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                                  <FileCode2 className="h-4 w-4" />
                                  Bank-Ready ISO 20022 (pain.001.001.03) Wire Instruction
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyXml()}
                                    className="bento-card inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-700 active:opacity-80 dark:text-slate-200"
                                  >
                                    {copiedXml ? (
                                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                    {copiedXml ? "Copied" : "Copy XML"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handleDownloadXml}
                                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-500/25 active:opacity-80 dark:text-emerald-200"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                    Download XML
                                  </button>
                                </div>
                              </div>
                              <pre className="max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300 dark:border-slate-800">
                                {settlementXml}
                              </pre>
                            </SpotlightCard>
                          )}

                          <SpotlightCard tone="violet" className="p-4">
                            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                              <History className="h-4 w-4 text-violet-500" />
                              Immutable PostgreSQL Audit Ledger (Append-Only + HMAC-SHA256)
                            </div>
                            <div className="space-y-1.5">
                              {selectedInvoice.audit_logs.map((log) => (
                                <div
                                  key={log.id}
                                  className="tactile-well flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="rounded bg-slate-200/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                      {log.actor_type}
                                    </span>
                                    <span className="font-mono font-bold text-slate-900 dark:text-slate-100">
                                      {log.action}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">
                                      by {log.actor_id}
                                    </span>
                                  </div>
                                  <span className="font-mono text-[11px] text-slate-400">
                                    {new Date(log.created_at).toLocaleTimeString()}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </SpotlightCard>
                        </motion.div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* ============================================================
                  WORKSPACE 3: HITL APPROVAL QUEUE
                  ============================================================ */}
              {workspace === "approvals" && (
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h1 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">
                        Human-in-the-Loop Approval Queue
                      </h1>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Paused LangGraph PostgreSQL checkpoints waiting for RBAC authority sign-off.
                      </p>
                    </div>
                    <span className="rounded-full border border-cyan-500/35 bg-cyan-500/10 px-3 py-1 font-mono text-xs font-semibold text-cyan-700 dark:text-cyan-300">
                      Authority: {persona.roleTitle} ({persona.limitLabel})
                    </span>
                  </div>

                  {approvals.length === 0 ? (
                    <SpotlightCard
                      tone="cyan"
                      className="flex min-h-[280px] flex-col items-center justify-center p-10 text-center"
                    >
                      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-500/12 text-cyan-600 dark:text-cyan-400">
                        <CheckCircle2 className="h-5 w-5" />
                      </div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        Approval Queue Clear
                      </h3>
                      <p className="mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
                        Zero invoices are paused awaiting human sign-off. Trigger a live threshold
                        breach to test PostgreSQL checkpoint resumption.
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleRunPreset("hitl_manager")}
                        className="mt-4 inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-cyan-500/35 bg-cyan-500/12 px-3.5 py-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-500/20 dark:text-cyan-300"
                      >
                        <FlaskConical className="h-3.5 w-3.5" />
                        Run Manager HITL Pause ($4,800)
                      </button>
                    </SpotlightCard>
                  ) : (
                    approvals.map((req) => (
                      <SpotlightCard
                        key={req.id}
                        tone={req.status === "ESCALATED" ? "amber" : "cyan"}
                        className="p-5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full border border-cyan-500/35 bg-cyan-500/12 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
                                REQUIRED ROLE: {req.required_role}
                              </span>
                              <span
                                className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                                  req.status === "ESCALATED"
                                    ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                    : "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                }`}
                              >
                                {req.status}
                              </span>
                            </div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                              {req.reason_summary}
                            </p>
                            <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                              Approval: {req.id.slice(0, 8)}&hellip; &middot; Invoice:{" "}
                              {req.invoice_id.slice(0, 8)}&hellip; &middot; SLA Due:{" "}
                              {new Date(req.sla_due_at).toLocaleString()}
                            </p>
                          </div>

                          <div className="flex items-center gap-3">
                            {req.status === "PENDING" && (
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() => void handleEscalateSla(req)}
                                className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-amber-500/40 bg-amber-500/12 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                                Simulate SLA Breach
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void handleOpenDocumentPreview(
                                  req.invoice_id,
                                  `Invoice ${req.invoice_id.slice(0, 8)}`
                                )
                              }
                              className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-sky-500/35 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-200"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View PDF
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSelectInvoice(req.invoice_id, true)}
                              className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                            >
                              Inspect Dossier
                              <ArrowUpRight className="h-3.5 w-3.5" />
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
                            className="tactile-well min-w-[260px] flex-1 rounded-xl px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
                          />
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => void handleApprovalDecision(req, "APPROVED")}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/25 transition-colors hover:bg-emerald-500 active:opacity-90 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Approve &amp; Stage Wire
                          </button>
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => void handleApprovalDecision(req, "REJECTED")}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-500 active:opacity-90 disabled:opacity-50"
                          >
                            <XCircle className="h-4 w-4" />
                            Reject Invoice
                          </button>
                        </div>
                      </SpotlightCard>
                    ))
                  )}
                </section>
              )}

              {/* ============================================================
                  WORKSPACE 4: INTELLIGENCE (Vendors RAG + Security/Analytics)
                  ============================================================ */}
              {workspace === "intelligence" && (
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h1 className="text-xl font-bold tracking-tight text-slate-950 dark:text-white">
                        Contract Intelligence &amp; Security Ops
                      </h1>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Vendor pgvector MSA search, cryptographic HMAC audit seals, and Dead-Letter
                        Queue.
                      </p>
                    </div>

                    <div className="tactile-well inline-flex gap-1 rounded-xl p-1">
                      {(
                        [
                          ["vendors", "Vendors & MSA RAG", Building2],
                          ["analytics", "Security, Analytics & DLQ", BarChart3],
                        ] as const
                      ).map(([id, label, Icon]) => {
                        const active = intelTab === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setIntelTab(id);
                              window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
                            }}
                            className={`relative inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                              active
                                ? "text-slate-950 dark:text-white"
                                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                            }`}
                          >
                            {active && (
                              <motion.span
                                layoutId="intelSubTab"
                                transition={{ type: "spring", stiffness: 580, damping: 42 }}
                                className="absolute inset-0 rounded-lg bg-white shadow-xs ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/15"
                              />
                            )}
                            <Icon className="relative z-10 h-3.5 w-3.5" />
                            <span className="relative z-10">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {intelTab === "vendors" ? (
                    <VendorContractHub
                      vendors={vendors}
                      apiKey={persona.apiKey}
                      onError={(msg) => pushToast("error", "Contract RAG Error", msg)}
                    />
                  ) : (
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
                </section>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Mobile Floating Bottom Dock */}
      <nav className="fixed right-3 bottom-3 left-3 z-30 flex items-center justify-around rounded-2xl border border-slate-200/90 bg-white/90 p-1.5 shadow-xl backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90 lg:hidden">
        {railItems.map((item) => {
          const active = workspace === item.id;
          const Icon = item.Icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateWorkspace(item.id, "top")}
              className={`relative flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[10px] font-semibold ${
                active ? "text-sky-600 dark:text-sky-400" : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="mobileDockPill"
                  transition={{ type: "spring", stiffness: 580, damping: 42 }}
                  className="absolute inset-0 rounded-xl bg-sky-500/12 dark:bg-sky-500/15"
                />
              )}
              <Icon className="relative z-10 h-4 w-4" />
              <span className="relative z-10">{item.short}</span>
            </button>
          );
        })}
      </nav>

      {/* Slide-Over Sandbox Simulator Drawer */}
      <SandboxDrawer
        open={sandboxOpen}
        onClose={() => setSandboxOpen(false)}
        presets={PRESET_CARDS}
        busyAction={busyAction}
        onRunPreset={(preset) => void handleRunPreset(preset)}
      />

      {/* Ctrl+K Command Palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />

      {/* Manual Fraud Hold Modal (100% Opaque, Permanent GPU Layer — Zero Snap) */}
      {holdModalOpen && selectedInvoice && (
        <div
          onClick={() => setHoldModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal-surface w-full max-w-md rounded-2xl border border-rose-500/45 bg-white p-5 shadow-2xl dark:bg-[#0d1321]"
          >
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-300">
              <ShieldBan className="h-5 w-5" />
              <h3 className="text-sm font-bold">Place Manual Fraud Quarantine Hold</h3>
            </div>
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              Locks{" "}
              <strong className="font-mono text-slate-950 dark:text-white">
                {selectedInvoice.invoice_number || selectedInvoice.original_filename}
              </strong>{" "}
              into <code className="text-rose-600 dark:text-rose-300">QUARANTINED_FRAUD_RISK</code>{" "}
              and writes an immutable HMAC-sealed audit record under{" "}
              <strong>{persona.label}</strong> ({persona.roleTitle}).
            </p>
            <textarea
              rows={3}
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="Enter forensic reason (min 5 characters)..."
              className="tactile-well mt-3 w-full rounded-xl p-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-rose-500 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setHoldModalOpen(false)}
                className="cursor-pointer rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={holdReason.trim().length < 5 || busyAction !== null}
                onClick={() => void handleConfirmFraudHold()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-500 active:opacity-90 disabled:opacity-40"
              >
                {busyAction === "fraud-hold" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busyAction === "fraud-hold" ? "Applying..." : "Confirm Quarantine"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SOX-404 Admin Archive & Delete Modal (100% Opaque Surface) */}
      {deleteModalOpen && selectedInvoice && (
        <div
          onClick={() => setDeleteModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal-surface w-full max-w-md rounded-2xl border border-rose-500/45 bg-white p-5 shadow-2xl dark:bg-[#0d1321]"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-300">
                <Trash2 className="h-5 w-5" />
                <h3 className="text-sm font-bold">Archive &amp; Remove Invoice</h3>
              </div>
              <span className="rounded-md bg-violet-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-violet-700 dark:text-violet-300">
                ADMIN ONLY &middot; SOX 404
              </span>
            </div>

            <p className="mt-2.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Removes{" "}
              <strong className="font-mono text-slate-950 dark:text-white">
                {selectedInvoice.invoice_number || selectedInvoice.original_filename}
              </strong>{" "}
              from the active ledger, clears pending approval tickets, and releases its SHA-256
              deduplication lock so you can re-upload the PDF cleanly. Immutable HMAC-SHA256 audit
              logs remain sealed in PostgreSQL.
            </p>

            {persona.key !== "ADMIN" && (
              <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-200">
                Active persona is <strong>{persona.label}</strong> ({persona.roleTitle}). Switch to{" "}
                <strong>Amaan Shaikh (Platform Admin)</strong> in the top bar to execute deletion—or
                confirm below to test the live backend <code>403</code> RBAC block.
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteModalOpen(false)}
                className="cursor-pointer rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleConfirmDeleteInvoice()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-500 active:opacity-90 disabled:opacity-40"
              >
                {busyAction === "delete" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busyAction === "delete" ? "Archiving..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Safe Rasterized Source Document Viewer Modal */}
      <DocumentViewerModal
        open={docModalOpen}
        label={docModalLabel}
        loading={docModalLoading}
        downloading={docModalDownloading}
        error={docModalError}
        preview={docPreview}
        onClose={() => setDocModalOpen(false)}
        onDownload={() => void handleDownloadSourceDocument()}
      />

      {/* Floating Toast Stack */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/* ============================================================================
   OpaquePersonaPopover — Flush 312px Width + Permanent GPU Layer (Zero Snap)
   ============================================================================ */
function initialsOf(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function OpaquePersonaPopover({
  persona,
  personas,
  onSelect,
}: {
  persona: Persona;
  personas: Persona[];
  onSelect: (p: Persona) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative sm:w-[312px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white/95 px-2.5 text-left shadow-xs transition-colors hover:border-slate-300 dark:border-slate-700/80 dark:bg-slate-900/95 dark:hover:border-slate-600"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-sky-500/20 to-indigo-500/25 font-mono text-[10px] font-bold text-sky-700 ring-1 ring-sky-500/30 dark:text-sky-300">
            {initialsOf(persona.label)}
          </span>
          <div className="hidden min-w-0 sm:block">
            <div className="truncate text-xs leading-4 font-semibold text-slate-900 dark:text-white">
              {persona.label}
            </div>
            <div className="truncate font-mono text-[10px] leading-3 text-slate-500 dark:text-slate-400">
              {persona.roleTitle} &middot; {persona.limitLabel}
            </div>
          </div>
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="popover-surface absolute right-0 z-50 mt-2 w-[312px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.28)] sm:w-full dark:border-slate-700/90 dark:bg-[#0d1321] dark:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)]">
          <div className="mb-1 flex items-center justify-between border-b border-slate-100 px-2 pt-1 pb-2 dark:border-slate-800">
            <span className="font-mono text-[10px] leading-4 font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Active RBAC Identity
            </span>
            <span className="rounded bg-sky-500/12 px-1.5 py-0.5 font-mono text-[9px] leading-3 font-bold text-sky-700 dark:text-sky-300">
              SOX 404
            </span>
          </div>

          <div className="space-y-1">
            {personas.map((p) => {
              const active = p.key === persona.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    onSelect(p);
                    setOpen(false);
                  }}
                  className={`flex h-12 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2 text-left transition-colors ${
                    active
                      ? "bg-sky-50 ring-1 ring-sky-500/35 dark:bg-sky-500/15 dark:ring-sky-400/35"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800/90"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-bold ${
                        active
                          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                          : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      }`}
                    >
                      {initialsOf(p.label)}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-xs leading-4 font-semibold text-slate-950 dark:text-white">
                        {p.label}
                      </div>
                      <div className="truncate text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                        {p.roleTitle}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[9.5px] leading-3 font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                      {p.limitLabel}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiBento({
  label,
  sub,
  icon: Icon,
  iconTone,
  tone,
  children,
  accent = "text-slate-950 dark:text-white",
  onClick,
  loading = false,
}: {
  label: string;
  sub: string;
  icon: typeof FileText;
  iconTone: string;
  tone: SpotlightTone;
  children?: React.ReactNode;
  accent?: string;
  onClick?: () => void;
  loading?: boolean;
}) {
  return (
    <SpotlightCard
      tone={tone}
      lift
      onClick={onClick}
      className={`group flex flex-col justify-between p-4 ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <div className="tactile-well flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
          <Icon className={`h-3.5 w-3.5 ${iconTone}`} />
        </div>
      </div>

      <div className={`my-3 font-mono text-2xl font-bold tracking-tight ${accent}`}>
        {loading ? (
          <span className="inline-block h-7 w-16 animate-pulse rounded-md bg-slate-200 dark:bg-slate-800" />
        ) : (
          children
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200/70 pt-2 text-[11px] text-slate-500 dark:border-slate-800/80 dark:text-slate-400">
        <span className="truncate">{sub}</span>
        {onClick && (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-slate-700 dark:group-hover:text-slate-200" />
        )}
      </div>
    </SpotlightCard>
  );
}

function CheckPill({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between rounded-xl border px-2.5 py-1.5 font-mono text-[11px] font-semibold ${
        ok
          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      }`}
    >
      <span>{label}</span>
      <span>{ok ? "PASS" : "FAIL"}</span>
    </div>
  );
}