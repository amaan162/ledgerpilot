"use client";

import { useState } from "react";
import {
  Download,
  FileText,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { DocumentPreviewResponse } from "@/lib/api";

const ZOOM_STEPS = [75, 100, 125, 150] as const;

export function DocumentViewerModal({
  open,
  label,
  loading,
  downloading,
  error,
  preview,
  onClose,
  onDownload,
}: {
  open: boolean;
  label: string;
  loading: boolean;
  downloading: boolean;
  error: string | null;
  preview: DocumentPreviewResponse | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [zoomIdx, setZoomIdx] = useState(1);

  if (!open) return null;

  const zoomPct = ZOOM_STEPS[zoomIdx];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-sm sm:p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-surface flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700/90 dark:bg-[#0d1321]"
      >
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-400">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-bold text-slate-950 dark:text-white">
                {preview?.filename || label || "Source Document"}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                {preview ? (
                  <>
                    <span>
                      {preview.rendered_pages} of {preview.page_count}{" "}
                      {preview.page_count === 1 ? "page" : "pages"}
                    </span>
                    <span>&middot;</span>
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <ShieldCheck className="h-3 w-3" />
                      Sanitized Raster Preview
                    </span>
                  </>
                ) : (
                  <span>Authenticated PostgreSQL Document Vault</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {preview && (
              <>
                <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900">
                  <button
                    type="button"
                    disabled={zoomIdx <= 0}
                    onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
                    aria-label="Zoom out"
                    className="cursor-pointer rounded-lg p-1.5 text-slate-600 transition hover:bg-white hover:text-slate-950 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <span className="min-w-[44px] text-center font-mono text-[11px] font-semibold text-slate-700 tabular-nums dark:text-slate-200">
                    {zoomPct}%
                  </span>
                  <button
                    type="button"
                    disabled={zoomIdx >= ZOOM_STEPS.length - 1}
                    onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
                    aria-label="Zoom in"
                    className="cursor-pointer rounded-lg p-1.5 text-slate-600 transition hover:bg-white hover:text-slate-950 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                </div>

                {preview.download_allowed && (
                  <button
                    type="button"
                    disabled={downloading}
                    onClick={onDownload}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/12 px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-200"
                  >
                    {downloading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {downloading ? "Downloading..." : "Download"}
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close document preview"
              className="cursor-pointer rounded-xl p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-950 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Quarantined Security Banner */}
        {preview?.is_quarantined && (
          <div className="flex items-center gap-2.5 border-b border-rose-500/35 bg-rose-500/10 px-5 py-2.5 text-xs text-rose-800 dark:text-rose-200">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span>
              <strong>Quarantined Document:</strong> Rendered server-side as flat PNG images to
              neutralize active PDF scripts &amp; prompt injections. Raw download is disabled.
            </span>
          </div>
        )}

        {/* Document Viewport */}
        <div className="flex-1 overflow-auto bg-slate-100/90 p-5 dark:bg-slate-950/90">
          {loading ? (
            <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin text-sky-500" />
              <div className="font-mono text-xs">
                Rasterizing verified source document from PostgreSQL...
              </div>
            </div>
          ) : error ? (
            <div className="mx-auto flex h-full min-h-[320px] max-w-md flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
                <FileText className="h-5 w-5" />
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-white">
                Source Document Unavailable
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {error}
              </p>
            </div>
          ) : preview ? (
            <div className="mx-auto flex flex-col items-center gap-5">
              {preview.pages.map((p) => (
                <div
                  key={p.page}
                  style={{ width: `${zoomPct}%`, maxWidth: "100%" }}
                  className="overflow-hidden rounded-xl border border-slate-300/80 bg-white shadow-lg transition-[width] duration-150 dark:border-slate-700"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.data_url}
                    alt={`${preview.filename} — Page ${p.page}`}
                    className="block h-auto w-full select-none"
                  />
                  {preview.page_count > 1 && (
                    <div className="border-t border-slate-200 bg-slate-50 px-3 py-1 text-right font-mono text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                      Page {p.page} / {preview.page_count}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
