"use client";

import { AnimatePresence, motion } from "framer-motion";
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
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-md flex-col gap-2.5">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => {
          const styles =
            t.type === "ok"
              ? "border-emerald-500/45 bg-white/95 text-slate-900 dark:bg-slate-950/95 dark:text-emerald-100"
              : t.type === "error"
                ? "border-rose-500/50 bg-white/95 text-slate-900 dark:bg-slate-950/95 dark:text-rose-100"
                : "border-sky-500/45 bg-white/95 text-slate-900 dark:bg-slate-950/95 dark:text-sky-100";

          const Icon =
            t.type === "ok" ? CheckCircle2 : t.type === "error" ? AlertTriangle : Info;

          const iconColor =
            t.type === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : t.type === "error"
                ? "text-rose-600 dark:text-rose-400"
                : "text-sky-600 dark:text-sky-400";

          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
              className={`pointer-events-auto flex items-start gap-3 rounded-2xl border p-3.5 shadow-2xl backdrop-blur-xl ${styles}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold">{t.title}</div>
                {t.detail && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300/85">
                    {t.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}