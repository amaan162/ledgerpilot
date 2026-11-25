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
              ? "border-emerald-500/50 bg-slate-950/95 text-emerald-100 shadow-emerald-950/40"
              : t.type === "error"
                ? "border-rose-500/60 bg-slate-950/95 text-rose-100 shadow-rose-950/50"
                : "border-sky-500/50 bg-slate-950/95 text-sky-100 shadow-sky-950/40";

          const Icon =
            t.type === "ok"
              ? CheckCircle2
              : t.type === "error"
                ? AlertTriangle
                : Info;

          const iconColor =
            t.type === "ok"
              ? "text-emerald-400"
              : t.type === "error"
                ? "text-rose-400"
                : "text-sky-400";

          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-3.5 shadow-2xl backdrop-blur-md ${styles}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold">{t.title}</div>
                {t.detail && (
                  <p className="mt-0.5 text-[11px] leading-relaxed opacity-80">{t.detail}</p>
                )}
              </div>
              <button
                onClick={() => onDismiss(t.id)}
                className="rounded p-0.5 opacity-60 transition hover:bg-white/10 hover:opacity-100"
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
