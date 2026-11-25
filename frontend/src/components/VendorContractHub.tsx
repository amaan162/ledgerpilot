"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Building2, CheckCircle2, Landmark, Search, ShieldCheck, Sparkles } from "lucide-react";
import { api, type ContractSearchResponse, type VendorRecord } from "@/lib/api";

const SAMPLE_QUERIES = [
  "hourly consulting rate cap and emergency surcharge policy",
  "bank account IBAN change verification protocol",
  "payment terms Net-30 VAT compliance rules",
  "goods receipt delivery confirmation requirement",
];

export function VendorContractHub({
  vendors,
  apiKey,
  onError,
}: {
  vendors: VendorRecord[];
  apiKey: string;
  onError: (msg: string) => void;
}) {
  const [selectedCode, setSelectedCode] = useState<string>(
    vendors[0]?.vendor_code || "VND-US-CLOUD01"
  );
  const [query, setQuery] = useState<string>(SAMPLE_QUERIES[0]);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<ContractSearchResponse | null>(null);

  const activeVendorCode =
    vendors.find((v) => v.vendor_code === selectedCode)?.vendor_code ||
    vendors[0]?.vendor_code ||
    "VND-US-CLOUD01";

  const handleSearch = async (overrideQuery?: string, overrideCode?: string) => {
    const q = (overrideQuery ?? query).trim();
    const code = overrideCode ?? activeVendorCode;
    if (!q || !code) return;
    setSearching(true);
    try {
      const res = await api.searchContracts(apiKey, code, q, 4);
      setSearchResult(res);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Contract semantic search failed.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Vendor Master Bank Registry */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Building2 className="h-4 w-4 text-emerald-400" />
              Verified International Vendor Master Registry
            </h2>
            <p className="text-xs text-slate-400">
              ISO 20022 wire instructions ALWAYS pull verified master IBAN/BIC from this table — never raw PDF text.
            </p>
          </div>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300">
            {vendors.length} Active Master Records
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {vendors.map((v, idx) => {
            const isSelected = activeVendorCode === v.vendor_code;
            return (
              <motion.button
                key={v.id}
                type="button"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => setSelectedCode(v.vendor_code)}
                className={`rounded-xl border p-4 text-left transition ${
                  isSelected
                    ? "border-sky-500/60 bg-sky-950/20 shadow-[0_0_24px_-10px_rgba(56,189,248,0.5)]"
                    : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{v.legal_name}</span>
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                        {v.status}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                      {v.vendor_code} {v.tax_id ? `· ${v.tax_id}` : ""}
                    </div>
                  </div>
                  <ShieldCheck
                    className={`h-4 w-4 shrink-0 ${isSelected ? "text-sky-400" : "text-slate-600"}`}
                  />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-1.5 rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5 font-mono text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">IBAN</span>
                    <span className="truncate text-emerald-300">{v.verified_iban}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">BIC / Bank</span>
                    <span className="truncate text-slate-200">
                      {v.verified_bic} · {v.verified_bank_name}
                    </span>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Live pgvector Hybrid Contract RAG Playground */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/50 p-5">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <BookOpen className="h-4 w-4 text-sky-400" />
            Live pgvector Contract RAG Playground (Strict Vendor Isolation)
          </h2>
          <p className="text-xs text-slate-400">
            Runs real 768-dim Gemini embeddings + PostgreSQL HNSW cosine similarity (85%) + lexical boost (15%) scoped strictly to{" "}
            <span className="font-mono text-sky-300">{activeVendorCode}</span>.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Target Vendor MSA"
            value={activeVendorCode}
            onChange={(e) => setSelectedCode(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            {vendors.map((v) => (
              <option key={v.id} value={v.vendor_code} className="bg-slate-950">
                {v.vendor_code} — {v.legal_name}
              </option>
            ))}
          </select>

          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSearch();
              }}
              placeholder="Ask a compliance question against this vendor's MSA..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <motion.button
            whileTap={{ scale: 0.96 }}
            disabled={searching}
            onClick={() => void handleSearch()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {searching ? "Embedding & Searching..." : "Search MSA Clauses"}
          </motion.button>
        </div>

        {/* Quick-Click Prompt Chips */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {SAMPLE_QUERIES.map((sq) => (
            <button
              key={sq}
              type="button"
              onClick={() => {
                setQuery(sq);
                void handleSearch(sq);
              }}
              className="rounded-full border border-slate-800 bg-slate-950/70 px-2.5 py-1 text-[11px] text-slate-400 transition hover:border-sky-500/40 hover:text-sky-300"
            >
              {sq}
            </button>
          ))}
        </div>

        {/* Results */}
        {searchResult && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-mono text-slate-400">
                Retrieved {searchResult.results.length} clause(s) for{" "}
                <strong className="text-white">{searchResult.vendor_code}</strong>
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                  searchResult.evidence_sufficient
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                }`}
              >
                <CheckCircle2 className="h-3 w-3" />
                {searchResult.evidence_sufficient
                  ? "EVIDENCE SUFFICIENT (>= 0.45)"
                  : "LOW EVIDENCE — WOULD ESCALATE"}
              </span>
            </div>

            {searchResult.results.map((hit, idx) => {
              const pct = Math.round(hit.similarity_score * 100);
              return (
                <motion.div
                  key={hit.chunk_id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.06 }}
                  className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-mono text-xs font-semibold text-sky-300">
                      <Landmark className="h-3.5 w-3.5" />[{hit.citation_id}] {hit.document_name} ·{" "}
                      {hit.clause_ref}
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                          className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400"
                        />
                      </div>
                      <span className="font-mono text-[11px] font-semibold text-emerald-300">
                        {pct}%
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">{hit.excerpt}</p>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>
    </div>
  );
}
