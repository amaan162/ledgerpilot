"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Landmark,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api, type ContractSearchResponse, type VendorRecord } from "@/lib/api";
import { SpotlightCard, type SpotlightTone } from "@/components/PrecisionUI";

const SAMPLE_QUERIES = [
  "hourly consulting rate cap and emergency surcharge policy",
  "bank account IBAN change verification protocol",
  "payment terms Net-30 VAT compliance rules",
  "goods receipt delivery confirmation requirement",
];

const VENDOR_TONES: SpotlightTone[] = ["cyan", "emerald", "violet", "amber"];

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
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const [query, setQuery] = useState<string>(SAMPLE_QUERIES[0]);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<ContractSearchResponse | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const activeVendor =
    vendors.find((v) => v.vendor_code === selectedCode) || vendors[0] || null;
  const activeVendorCode = activeVendor?.vendor_code || "VND-US-CLOUD01";

  useEffect(() => {
    if (!vendorMenuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVendorMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [vendorMenuOpen]);

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
    <div className="space-y-5">
      {/* Vendor Master Bank Registry */}
      <SpotlightCard tone="teal" className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
              <Building2 className="h-4 w-4 text-teal-500" />
              Verified International Vendor Master Registry
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              ISO 20022 wire instructions pull verified master IBAN/BIC exclusively from this
              registry &mdash; never from untrusted PDF text.
            </p>
          </div>
          <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            {vendors.length} Active Master Records
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {vendors.map((v, idx) => {
            const isSelected = activeVendorCode === v.vendor_code;
            const tone = VENDOR_TONES[idx % VENDOR_TONES.length];
            return (
              <SpotlightCard
                key={v.id}
                asButton
                tone={tone}
                onClick={() => setSelectedCode(v.vendor_code)}
                className={`p-4 ${
                  isSelected ? "border-sky-500/60 ring-1 ring-sky-500/30" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-950 dark:text-white">
                        {v.legal_name}
                      </span>
                      <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        {v.status}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {v.vendor_code} {v.tax_id ? `\u00B7 ${v.tax_id}` : ""}
                    </div>
                  </div>
                  <ShieldCheck
                    className={`h-4 w-4 shrink-0 transition-colors ${
                      isSelected ? "text-sky-500" : "text-slate-400 dark:text-slate-600"
                    }`}
                  />
                </div>
                <div className="tactile-well mt-3 grid grid-cols-1 gap-1.5 rounded-lg p-2.5 font-mono text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">IBAN</span>
                    <span className="truncate font-semibold text-emerald-700 dark:text-emerald-300">
                      {v.verified_iban}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">BIC / Bank</span>
                    <span className="truncate text-slate-800 dark:text-slate-200">
                      {v.verified_bic} &middot; {v.verified_bank_name}
                    </span>
                  </div>
                </div>
              </SpotlightCard>
            );
          })}
        </div>
      </SpotlightCard>

      {/* Live pgvector Hybrid Contract RAG Playground */}
      <SpotlightCard tone="indigo" className="overflow-visible p-5">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-950 dark:text-white">
            <BookOpen className="h-4 w-4 text-indigo-500" />
            Live pgvector Contract RAG Search (Vendor-Isolated)
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Runs 768-dim Gemini embeddings + PostgreSQL HNSW cosine similarity (85%) + lexical
            boost (15%) scoped strictly to{" "}
            <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-300">
              {activeVendorCode}
            </span>
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Custom Frosted Vendor Selector */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setVendorMenuOpen((o) => !o)}
              className="tactile-well flex h-9 cursor-pointer items-center gap-2 rounded-xl px-3 font-mono text-xs font-semibold text-slate-800 transition hover:border-indigo-500/45 dark:text-slate-100"
            >
              <span className="max-w-[210px] truncate">
                {activeVendor
                  ? `${activeVendor.vendor_code} \u2014 ${activeVendor.legal_name}`
                  : activeVendorCode}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${
                  vendorMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <AnimatePresence>
              {vendorMenuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.97 }}
                  transition={{ type: "spring", stiffness: 520, damping: 36 }}
                  className="bento-card absolute left-0 z-40 mt-2 w-80 overflow-hidden rounded-2xl bg-white/95 p-1.5 shadow-2xl dark:bg-slate-900/95"
                >
                  {vendors.map((v) => {
                    const selected = v.vendor_code === activeVendorCode;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          setSelectedCode(v.vendor_code);
                          setVendorMenuOpen(false);
                        }}
                        className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition ${
                          selected
                            ? "bg-indigo-500/12 text-indigo-700 ring-1 ring-indigo-500/30 dark:text-indigo-200"
                            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/80"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{v.legal_name}</div>
                          <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                            {v.vendor_code}
                          </div>
                        </div>
                        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-500" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSearch();
              }}
              placeholder="Ask a compliance question against this vendor's MSA..."
              className="tactile-well h-9 w-full rounded-xl pr-3 pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>

          <motion.button
            type="button"
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.96 }}
            disabled={searching}
            onClick={() => void handleSearch()}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {searching ? "Searching..." : "Search MSA Clauses"}
          </motion.button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {SAMPLE_QUERIES.map((sq) => (
            <button
              key={sq}
              type="button"
              onClick={() => {
                setQuery(sq);
                void handleSearch(sq);
              }}
              className="tactile-well cursor-pointer rounded-full px-3 py-1 text-[11px] font-medium text-slate-600 transition hover:border-indigo-500/45 hover:text-indigo-700 dark:text-slate-400 dark:hover:text-indigo-300"
            >
              {sq}
            </button>
          ))}
        </div>

        {searchResult && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-mono text-slate-500 dark:text-slate-400">
                Retrieved {searchResult.results.length} clause(s) for{" "}
                <strong className="text-slate-900 dark:text-white">
                  {searchResult.vendor_code}
                </strong>
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                  searchResult.evidence_sufficient
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
              >
                <CheckCircle2 className="h-3 w-3" />
                {searchResult.evidence_sufficient
                  ? "EVIDENCE SUFFICIENT (>= 0.45)"
                  : "LOW EVIDENCE \u2014 WOULD ESCALATE"}
              </span>
            </div>

            {searchResult.results.map((hit, idx) => {
              const pct = Math.round(hit.similarity_score * 100);
              return (
                <motion.div
                  key={hit.chunk_id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="tactile-well rounded-xl p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-mono text-xs font-bold text-indigo-700 dark:text-indigo-300">
                      <Landmark className="h-3.5 w-3.5" />[{hit.citation_id}] {hit.document_name}{" "}
                      &middot; {hit.clause_ref}
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.45, ease: "easeOut" }}
                          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400"
                        />
                      </div>
                      <span className="font-mono text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                        {pct}%
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {hit.excerpt}
                  </p>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </SpotlightCard>
    </div>
  );
}