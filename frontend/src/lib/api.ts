export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

export type PersonaKey = "AP_CLERK" | "FINANCE_MANAGER" | "CONTROLLER" | "ADMIN";

export interface Persona {
  key: PersonaKey;
  label: string;
  roleTitle: string;
  limitLabel: string;
  badgeColor: string;
  apiKey: string;
}

export const DEMO_PERSONAS: Persona[] = [
  {
    key: "FINANCE_MANAGER",
    label: "James Holloway",
    roleTitle: "Finance Manager",
    limitLabel: "$10k limit",
    badgeColor: "text-sky-300",
    apiKey: "lp_manager_dev_key_003",
  },
  {
    key: "CONTROLLER",
    label: "Elena Rostova",
    roleTitle: "Corporate Controller",
    limitLabel: "$250k limit",
    badgeColor: "text-emerald-300",
    apiKey: "lp_controller_dev_key_002",
  },
  {
    key: "AP_CLERK",
    label: "Maya Patel",
    roleTitle: "AP Clerk (Read/Upload)",
    limitLabel: "$0 approval cap",
    badgeColor: "text-amber-300",
    apiKey: "lp_clerk_dev_key_004",
  },
  {
    key: "ADMIN",
    label: "Amaan Shaikh",
    roleTitle: "Platform Admin",
    limitLabel: "$1M limit",
    badgeColor: "text-violet-300",
    apiKey: "lp_admin_dev_key_001",
  },
];

export type DemoPreset = "clean_auto" | "hitl_manager" | "gr_overbill" | "fraud_white_text";

export interface MetricsOverview {
  total_invoices: number;
  payment_staged_count: number;
  awaiting_approval_count: number;
  quarantined_fraud_count: number;
  rejected_count: number;
  escalated_sla_count: number;
  pending_approvals_count: number;
  total_staged_amount: string;
  total_llm_cost_usd: string;
  avg_processing_ms: number;
}

export interface EvalScorecard {
  available: boolean;
  evaluated_at?: string;
  total_cases?: number;
  passed_cases?: number;
  failed_cases?: number;
  overall_accuracy_pct?: number;
  fraud_and_injection_recall_pct?: number;
  false_positive_quarantine_rate_pct?: number;
  latency_ms?: { p50: number; p95: number; max: number };
  by_category?: Record<string, { total: number; passed: number }>;
}

export interface CircuitBreakerStatus {
  name: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN" | string;
  failure_count: number;
  failure_threshold: number;
  total_trips: number;
  cooldown_remaining_s: number;
}

export interface DailyBudgetStatus {
  utc_date: string;
  spent_today_usd: string;
  daily_limit_usd: string;
  remaining_usd: string;
}

export interface SecurityPosture {
  status: "HEALTHY" | "DEGRADED" | string;
  controls: {
    owasp_pdf_forensics: string;
    sox_404_segregation_of_duties: string;
    ofac_sanctions_iban_screening: string;
    immutable_audit_trigger: string;
    cryptographic_audit_seals: string;
    hmac_webhook_replay_window_s: number;
    rate_limiter_active_buckets: number;
  };
  reliability: {
    pgvector_extension: boolean;
    unresolved_dead_letters: number;
    circuit_breakers: CircuitBreakerStatus[];
    daily_llm_budget: DailyBudgetStatus;
  };
}

export interface AuditIntegrityReport {
  verified: boolean;
  total_rows_checked: number;
  signed_rows_valid: number;
  legacy_unsigned_rows: number;
  tampered_row_ids: string[];
}

export interface AuditLogEntry {
  id: string;
  invoice_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  previous_state: string | null;
  new_state: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface ContractCitation {
  citation_id: string;
  chunk_id: string;
  document_name: string;
  clause_ref: string;
  excerpt: string;
  similarity_score: number;
}

export interface ContractSearchResponse {
  vendor_code: string;
  query: string;
  evidence_sufficient: boolean;
  results: ContractCitation[];
}

export interface VendorRecord {
  id: string;
  vendor_code: string;
  legal_name: string;
  tax_id?: string | null;
  verified_iban: string;
  verified_bic: string;
  verified_bank_name: string;
  default_currency?: string | null;
  country?: string | null;
  status: string;
}

export interface DeadLetterItem {
  id: string;
  source: string;
  idempotency_key: string;
  error_message: string;
  resolved: boolean;
  created_at: string;
}

export interface SecurityFinding {
  finding_type: string;
  severity: string;
  page: number | null;
  snippet: string;
  detail: string;
}

export interface LineVariance {
  sku: string | null;
  description: string;
  issue: string;
  expected_value: string;
  actual_value: string;
}

export interface DocumentPreviewPage {
  page: number;
  width: number;
  height: number;
  data_url: string;
}

export interface DocumentPreviewResponse {
  invoice_id: string;
  filename: string;
  content_type: string;
  page_count: number;
  rendered_pages: number;
  is_quarantined: boolean;
  sanitized_raster: boolean;
  download_allowed: boolean;
  pages: DocumentPreviewPage[];
}

export interface InvoiceSummary {
  id: string;
  idempotency_key: string;
  file_sha256: string;
  original_filename: string;
  source_channel: string;
  vendor_id: string | null;
  invoice_number: string | null;
  po_number: string | null;
  currency: string | null;
  total_amount: string | null;
  status: string;
  risk_flags: string[];
  settlement_reference: string | null;
  llm_cost_usd: string;
  processing_ms: number;
  created_at: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  subtotal_amount: string | null;
  tax_amount: string | null;
  extracted_iban: string | null;
  extracted_payload: Record<string, unknown>;
  security_report: {
    file_type?: string;
    page_count?: number;
    is_suspicious?: boolean;
    prompt_injection_detected?: boolean;
    hidden_text_detected?: boolean;
    risk_score?: number;
    risk_flags?: string[];
    findings?: SecurityFinding[];
  };
  match_report: {
    is_clean_match?: boolean;
    vendor_matched?: boolean;
    vendor_code?: string | null;
    po_matched?: boolean;
    goods_receipt_matched?: boolean;
    arithmetic_valid?: boolean;
    iban_verified?: boolean;
    currency_valid?: boolean;
    po_total_amount?: string | null;
    total_variance_amount?: string | null;
    line_variances?: LineVariance[];
    risk_flags?: string[];
    summary?: string;
  };
  rag_citations: ContractCitation[];
  thread_id: string;
  settlement_xml_path: string | null;
  audit_logs: AuditLogEntry[];
}

export interface ApprovalRequestItem {
  id: string;
  invoice_id: string;
  required_role: string;
  status: string;
  reason_summary: string;
  decided_by: string | null;
  decision_reason: string | null;
  sla_due_at: string;
  decided_at: string | null;
  created_at: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("X-API-Key", apiKey);

  const resp = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });

  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      message =
        typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail || body);
    } catch {
      message = (await resp.text()) || message;
    }
    throw new ApiError(resp.status, message);
  }

  return resp.json() as Promise<T>;
}

export const api = {
  pingHealth: async (): Promise<boolean> => {
    try {
      const resp = await fetch(`${API_BASE_URL}/health`, { cache: "no-store" });
      return resp.ok;
    } catch {
      return false;
    }
  },

  getMetrics: (apiKey: string) =>
    apiFetch<MetricsOverview>("/api/v1/metrics/overview", apiKey),

  getEvalScorecard: (apiKey: string) =>
    apiFetch<EvalScorecard>("/api/v1/demo/eval-scorecard", apiKey),

  getSecurityPosture: (apiKey: string) =>
    apiFetch<SecurityPosture>("/api/v1/security/posture", apiKey),

  verifyAuditIntegrity: (apiKey: string) =>
    apiFetch<AuditIntegrityReport>("/api/v1/security/audit-integrity", apiKey),

  listInvoices: (apiKey: string) =>
    apiFetch<InvoiceSummary[]>("/api/v1/invoices?limit=50", apiKey),

  getInvoiceDetail: (apiKey: string, invoiceId: string) =>
    apiFetch<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`, apiKey),

  deleteInvoice: (apiKey: string, invoiceId: string) =>
    apiFetch<{ status: string; invoice_id: string; label: string }>(
      `/api/v1/invoices/${invoiceId}`,
      apiKey,
      { method: "DELETE" }
    ),

  listPendingApprovals: (apiKey: string) =>
    apiFetch<ApprovalRequestItem[]>("/api/v1/approvals?only_pending=true", apiKey),

  listVendors: (apiKey: string) =>
    apiFetch<VendorRecord[]>("/api/v1/vendors", apiKey),

  searchContracts: (apiKey: string, vendorCode: string, query: string, topK = 4) =>
    apiFetch<ContractSearchResponse>("/api/v1/contracts/search", apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_code: vendorCode, query, top_k: topK }),
    }),

  listDeadLetters: (apiKey: string) =>
    apiFetch<DeadLetterItem[]>("/api/v1/dead-letters?only_unresolved=false", apiKey),

  resolveDeadLetter: (apiKey: string, jobId: string, resolutionNote: string) =>
    apiFetch<DeadLetterItem>(`/api/v1/security/dead-letters/${jobId}/resolve`, apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution_note: resolutionNote }),
    }),

  retryInvoice: (apiKey: string, invoiceId: string) =>
    apiFetch<InvoiceSummary>(`/api/v1/security/invoices/${invoiceId}/retry`, apiKey, {
      method: "POST",
    }),

  runDemoPreset: (apiKey: string, preset: DemoPreset) =>
    apiFetch<InvoiceDetail>(`/api/v1/demo/run/${preset}`, apiKey, {
      method: "POST",
    }),

  uploadAndProcessInvoice: async (apiKey: string, file: File): Promise<InvoiceDetail> => {
    const formData = new FormData();
    formData.append("file", file);
    const ingestRes = await apiFetch<{ invoice: InvoiceSummary }>(
      "/api/v1/invoices/ingest",
      apiKey,
      { method: "POST", body: formData }
    );
    return apiFetch<InvoiceDetail>(
      `/api/v1/invoices/${ingestRes.invoice.id}/process`,
      apiKey,
      { method: "POST" }
    );
  },

  placeFraudHold: (apiKey: string, invoiceId: string, reason: string) =>
    apiFetch<InvoiceSummary>(`/api/v1/invoices/${invoiceId}/fraud-hold`, apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, actor_channel: "API" }),
    }),

  decideApproval: (
    apiKey: string,
    approvalId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string
  ) =>
    apiFetch<{
      approval: ApprovalRequestItem;
      invoice_status: string;
      settlement_reference: string | null;
    }>(`/api/v1/approvals/${approvalId}/decide`, apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    }),

  escalateApproval: (apiKey: string, approvalId: string) =>
    apiFetch<ApprovalRequestItem>(`/api/v1/approvals/${approvalId}/escalate-sla`, apiKey, {
      method: "POST",
    }),

  getDocumentPreview: (apiKey: string, invoiceId: string) =>
    apiFetch<DocumentPreviewResponse>(`/api/v1/invoices/${invoiceId}/document/preview`, apiKey),

  downloadOriginalDocument: async (apiKey: string, invoiceId: string): Promise<Blob> => {
    const resp = await fetch(`${API_BASE_URL}/api/v1/invoices/${invoiceId}/document`, {
      headers: { "X-API-Key": apiKey },
      cache: "no-store",
    });
    if (!resp.ok) {
      let message = `Unable to download source document (HTTP ${resp.status})`;
      try {
        const body = await resp.json();
        if (typeof body.detail === "string") message = body.detail;
      } catch {
        // Keep fallback HTTP error message
      }
      throw new ApiError(resp.status, message);
    }
    return resp.blob();
  },

  getSettlementXml: async (apiKey: string, invoiceId: string): Promise<string> => {
    const resp = await fetch(
      `${API_BASE_URL}/api/v1/invoices/${invoiceId}/settlement.xml`,
      { headers: { "X-API-Key": apiKey }, cache: "no-store" }
    );
    if (!resp.ok) {
      throw new ApiError(resp.status, `Unable to fetch settlement XML (HTTP ${resp.status})`);
    }
    return resp.text();
  },
};