"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export interface ToastItem {
  id: string;
  type: "ok" | "error" | "info";
  title: string;
  detail?: string;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-md flex-col gap-2.5">
      {toasts.map((t) => {
        const styles =
          t.type === "ok"
            ? "border-emerald-500/45 bg-white text-slate-900 dark:bg-[#0d1321] dark:text-emerald-100"
            : t.type === "error"
              ? "border-rose-500/50 bg-white text-slate-900 dark:bg-[#0d1321] dark:text-rose-100"
              : "border-sky-500/45 bg-white text-slate-900 dark:bg-[#0d1321] dark:text-sky-100";

        const Icon =
          t.type === "ok" ? CheckCircle2 : t.type === "error" ? AlertTriangle : Info;

        const iconColor =
          t.type === "ok"
            ? "text-emerald-600 dark:text-emerald-400"
            : t.type === "error"
              ? "text-rose-600 dark:text-rose-400"
              : "text-sky-600 dark:text-sky-400";

        return (
          <div
            key={t.id}
            role="status"
            className={`toast-surface pointer-events-auto flex items-start gap-3 rounded-2xl border p-3.5 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.28)] dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.85)] ${styles}`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
            <div className="min-w-0 flex-1">
              <div className="text-xs leading-4 font-bold">{t.title}</div>
              {t.detail && (
                <p className="mt-0.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300/85">
                  {t.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="cursor-pointer rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}