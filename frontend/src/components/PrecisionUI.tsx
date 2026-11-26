"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
} from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock,
  Command,
  Cpu,
  FileSearch,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Loader2,
  Moon,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  UserCheck,
  X,
} from "lucide-react";
import type { DemoPreset, EvalScorecard, MetricsOverview, Persona } from "@/lib/api";

/* ============================================================================
   Curated Dual-Mode Spotlight Palette (Calibrated for Light & Dark Modes)
   ============================================================================ */
export type SpotlightTone =
  | "indigo"
  | "emerald"
  | "cyan"
  | "rose"
  | "violet"
  | "amber"
  | "teal"
  | "blue"
  | "fuchsia";

export const SPOTLIGHT_PALETTE: Record<SpotlightTone, { fill: string; border: string }> = {
  indigo: { fill: "rgba(99, 102, 241, 0.20)", border: "rgba(99, 102, 241, 0.72)" },
  emerald: { fill: "rgba(16, 185, 129, 0.20)", border: "rgba(16, 185, 129, 0.72)" },
  cyan: { fill: "rgba(6, 182, 212, 0.20)", border: "rgba(6, 182, 212, 0.72)" },
  rose: { fill: "rgba(244, 63, 94, 0.20)", border: "rgba(244, 63, 94, 0.72)" },
  violet: { fill: "rgba(139, 92, 246, 0.20)", border: "rgba(139, 92, 246, 0.72)" },
  amber: { fill: "rgba(245, 158, 11, 0.20)", border: "rgba(245, 158, 11, 0.72)" },
  teal: { fill: "rgba(20, 184, 166, 0.20)", border: "rgba(20, 184, 166, 0.72)" },
  blue: { fill: "rgba(59, 130, 246, 0.20)", border: "rgba(59, 130, 246, 0.72)" },
  fuchsia: { fill: "rgba(217, 70, 239, 0.19)", border: "rgba(217, 70, 239, 0.70)" },
};

/* ============================================================================
1. SpotlightCard — Specular Bento Surface with Dual-Layer Cursor Glow
   ============================================================================ */
export function SpotlightCard({
  children,
  className = "",
  tone = "blue",
  spotColor,
  borderColor,
  onClick,
  asButton = false,
  disabled = false,
  lift = false,
  allowOverflow = false,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  children: React.ReactNode;
  className?: string;
  tone?: SpotlightTone;
  spotColor?: string;
  borderColor?: string;
  onClick?: () => void;
  asButton?: boolean;
  disabled?: boolean;
  lift?: boolean;
  allowOverflow?: boolean;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const el = asButton ? btnRef.current : divRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${e.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${e.clientY - rect.top}px`);
  };

  const palette = SPOTLIGHT_PALETTE[tone];
  const style = {
    "--spot-override": spotColor ?? palette.fill,
    "--spot-border-override": borderColor ?? palette.border,
  } as React.CSSProperties;

  const overflowClass = allowOverflow ? "allow-overflow" : "";
  const liftClass = lift
    ? "transition-[transform,border-color,box-shadow,background-color] duration-150 ease-out [transform:translate3d(0,0,0)] hover:[transform:translate3d(0,-2px,0)]"
    : "";

  if (asButton) {
    return (
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onMouseMove={handleMouseMove}
        onClick={onClick}
        style={style}
        className={`bento-card spotlight-surface ${overflowClass} cursor-pointer rounded-2xl text-left transition-[transform,border-color,box-shadow,background-color] duration-150 ease-out [transform:translate3d(0,0,0)] hover:[transform:translate3d(0,-2px,0)] active:opacity-95 disabled:pointer-events-none disabled:opacity-50 ${className}`}
      >
        {children}
      </button>
    );
  }

  return (
    <div
      ref={divRef}
      onMouseMove={handleMouseMove}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={style}
      className={`bento-card spotlight-surface ${overflowClass} ${liftClass} rounded-2xl ${className}`}
    >
      {children}
    </div>
  );
}

/* ============================================================================
2. TactileThemeToggle — Pixel-Exact Machined Light / Dark Switch
   ============================================================================ */
export function TactileThemeToggle({
  theme,
  onToggle,
}: {
  theme: "dark" | "light";
  onToggle: () => void;
}) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "Light" : "Dark"} Mode`}
      className="tactile-well relative flex h-9 w-[68px] shrink-0 cursor-pointer items-center rounded-full p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      <div className="flex w-full items-center justify-between px-1.5 text-slate-400 dark:text-slate-500">
        <Sun className="h-3.5 w-3.5" />
        <Moon className="h-3.5 w-3.5" />
      </div>
      <motion.span
        initial={false}
        animate={{ x: isDark ? 32 : 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 36 }}
        className={`absolute top-1 left-1 flex h-7 w-7 items-center justify-center rounded-full shadow-md ${
          isDark
            ? "bg-linear-to-b from-slate-700 to-slate-800 text-sky-300 ring-1 ring-white/15"
            : "bg-linear-to-b from-white to-slate-50 text-amber-500 ring-1 ring-slate-900/10"
        }`}
      >
        <motion.span
          key={theme}
          initial={{ rotate: -45, opacity: 0.4 }}
          animate={{ rotate: 0, opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          {isDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </motion.span>
      </motion.span>
    </button>
  );
}

/* ============================================================================
3. PersonaPopover — Opaque, Flush, Zero-Snap RBAC Switcher (Exported Utility)
   ============================================================================ */
function initialsOf(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function PersonaPopover({
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

/* ============================================================================
4. AnimatedNumber — Spring-Driven Tabular Counter (International en-US Format)
   ============================================================================ */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}) {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 120, damping: 22, mass: 0.7 });
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    mv.set(value);
  }, [value, mv]);

  useMotionValueEvent(spring, "change", (latest) => {
    setDisplay(latest);
  });

  const safeDisplay = Math.abs(display) < 1e-9 ? 0 : display;
  const formatted = safeDisplay.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className="tabular-nums">
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

/* ============================================================================
5. FinOpsDialGauge — Synchronized Orbital Spring Radial Instrument
   ============================================================================ */
type DialMode = "fraud" | "settle" | "accuracy";

const DIAL_CX = 110;
const DIAL_CY = 110;
const DIAL_R = 74;
const DIAL_START_DEG = 135;
const DIAL_SWEEP_DEG = 270;

const round2 = (n: number) => Math.round(n * 100) / 100;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: round2(cx + r * Math.cos(rad)),
    y: round2(cy + r * Math.sin(rad)),
  };
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const s = polar(cx, cy, r, startDeg);
  const e = polar(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const FULL_DIAL_ARC = describeArc(
  DIAL_CX,
  DIAL_CY,
  DIAL_R,
  DIAL_START_DEG,
  DIAL_START_DEG + DIAL_SWEEP_DEG
);

const DIAL_TICKS = Array.from({ length: 41 }, (_, idx) => {
  const ratio = idx / 40;
  const deg = DIAL_START_DEG + ratio * DIAL_SWEEP_DEG;
  const isMajor = idx % 5 === 0;
  const outer = polar(DIAL_CX, DIAL_CY, 94, deg);
  const inner = polar(DIAL_CX, DIAL_CY, isMajor ? 84 : 88, deg);
  return { idx, ratio, outer, inner, isMajor };
});

export function FinOpsDialGauge({
  metrics,
  evalScorecard,
}: {
  metrics: MetricsOverview | null;
  evalScorecard: EvalScorecard | null;
}) {
  const [mode, setMode] = useState<DialMode>("fraud");

  const dialData = useMemo(() => {
    const total = metrics?.total_invoices ?? 0;
    const staged = metrics?.payment_staged_count ?? 0;
    const autoSettlePct = total > 0 ? Math.round((staged / total) * 100) : 0;
    const fraudRecall = evalScorecard?.fraud_and_injection_recall_pct ?? 100;
    const overallAcc = evalScorecard?.overall_accuracy_pct ?? 100;

    return {
      fraud: {
        label: "Fraud Recall",
        shortLabel: "Fraud Shield",
        tone: "emerald" as SpotlightTone,
        pct: Math.min(100, Math.max(0, fraudRecall)),
        display: `${fraudRecall.toFixed(0)}%`,
        sub: `${metrics?.quarantined_fraud_count ?? 0} blocked \u00B7 0% leakage`,
        stroke: "#10b981",
        glow: "rgba(16, 185, 129, 0.38)",
        pill: "text-emerald-600 dark:text-emerald-400",
      },
      settle: {
        label: "STP Settlement",
        shortLabel: "Auto-Settle",
        tone: "cyan" as SpotlightTone,
        pct: Math.min(100, Math.max(0, autoSettlePct)),
        display: `${autoSettlePct}%`,
        sub: `${staged} of ${total} staged XMLs`,
        stroke: "#06b6d4",
        glow: "rgba(6, 182, 212, 0.38)",
        pill: "text-cyan-600 dark:text-cyan-400",
      },
      accuracy: {
        label: "Eval Benchmark",
        shortLabel: "Eval Acc",
        tone: "violet" as SpotlightTone,
        pct: Math.min(100, Math.max(0, overallAcc)),
        display: `${overallAcc.toFixed(0)}%`,
        sub: evalScorecard?.total_cases
          ? `${evalScorecard.passed_cases}/${evalScorecard.total_cases} PDFs passed`
          : "SOX 404 + OWASP suite",
        stroke: "#8b5cf6",
        glow: "rgba(139, 92, 246, 0.38)",
        pill: "text-violet-600 dark:text-violet-400",
      },
    };
  }, [metrics, evalScorecard]);

  const current = dialData[mode];

  const pctMv = useMotionValue(current.pct);
  const smoothPct = useSpring(pctMv, { stiffness: 125, damping: 22, mass: 0.9 });

  useEffect(() => {
    pctMv.set(current.pct);
  }, [current.pct, pctMv]);

  const arcPathLength = useTransform(smoothPct, (p) => Math.max(0.001, Math.min(1, p / 100)));
  const arcOpacity = useTransform(smoothPct, (p) => (p <= 0.4 ? 0 : Math.min(1, p / 4)));
  const knobCx = useTransform(smoothPct, (p) => {
    const rad = ((DIAL_START_DEG + (p / 100) * DIAL_SWEEP_DEG) * Math.PI) / 180;
    return round2(DIAL_CX + DIAL_R * Math.cos(rad));
  });
  const knobCy = useTransform(smoothPct, (p) => {
    const rad = ((DIAL_START_DEG + (p / 100) * DIAL_SWEEP_DEG) * Math.PI) / 180;
    return round2(DIAL_CY + DIAL_R * Math.sin(rad));
  });

  return (
    <SpotlightCard tone={current.tone} className="flex h-full flex-col justify-between p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="tactile-well flex h-8 w-8 items-center justify-center rounded-xl">
            <Gauge className={`h-4 w-4 transition-colors duration-300 ${current.pill}`} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-900 dark:text-white">
              Control Telemetry
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Live compliance gauge
            </div>
          </div>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-100/90 px-2 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300">
          LIVE
        </span>
      </div>

      {/* Synchronized Orbital SVG Dial */}
      <div className="relative mx-auto my-1 flex w-full max-w-[216px] items-center justify-center">
        <svg viewBox="0 -14 220 212" className="w-full overflow-visible">
          {DIAL_TICKS.map((t) => {
            const lit = t.ratio * 100 <= current.pct && current.pct > 0;
            return (
              <line
                key={t.idx}
                x1={t.inner.x}
                y1={t.inner.y}
                x2={t.outer.x}
                y2={t.outer.y}
                stroke={lit ? current.stroke : "currentColor"}
                strokeOpacity={lit ? (t.isMajor ? 0.95 : 0.65) : t.isMajor ? 0.28 : 0.14}
                strokeWidth={t.isMajor ? 2.1 : 1.2}
                strokeLinecap="round"
                className="text-slate-500 transition-colors duration-300 dark:text-slate-400"
              />
            );
          })}

          <path
            d={FULL_DIAL_ARC}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.14}
            strokeWidth={7}
            strokeLinecap="round"
            className="text-slate-500 dark:text-slate-400"
          />

          <motion.path
            d={FULL_DIAL_ARC}
            fill="none"
            stroke={current.stroke}
            strokeWidth={7}
            strokeLinecap="round"
            style={{
              pathLength: arcPathLength,
              opacity: arcOpacity,
              filter: `drop-shadow(0 0 8px ${current.glow})`,
            }}
          />

          <motion.circle
            cx={knobCx}
            cy={knobCy}
            r={10.5}
            fill={current.stroke}
            fillOpacity={0.22}
          />

          <motion.circle
            cx={knobCx}
            cy={knobCy}
            r={5.5}
            fill={current.stroke}
            stroke="#ffffff"
            strokeWidth={2.2}
          />

          <text
            x="44"
            y="190"
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[9px] dark:fill-slate-500"
          >
            0%
          </text>
          <text
            x="110"
            y="2"
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[9px] dark:fill-slate-500"
          >
            50%
          </text>
          <text
            x="176"
            y="190"
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[9px] dark:fill-slate-500"
          >
            100%
          </text>
        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-5 text-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={mode}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              className="flex flex-col items-center"
            >
              <div className="font-mono text-3xl leading-9 font-bold tracking-tight text-slate-900 tabular-nums dark:text-white">
                {current.display}
              </div>
              <div className={`mt-0.5 text-[11px] leading-4 font-semibold ${current.pill}`}>
                {current.label}
              </div>
              <div className="mt-1 max-w-[144px] text-[10px] leading-3.5 text-slate-500 dark:text-slate-400">
                {current.sub}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="tactile-well grid grid-cols-3 gap-1 rounded-xl p-1">
        {(["fraud", "settle", "accuracy"] as const).map((key) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`relative cursor-pointer rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                active
                  ? "text-slate-950 dark:text-white"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="dialModeThumb"
                  transition={{ type: "spring", stiffness: 520, damping: 36 }}
                  className="absolute inset-0 rounded-lg bg-white shadow-sm ring-1 ring-slate-900/10 dark:bg-slate-800 dark:ring-white/15"
                />
              )}
              <span className="relative z-10">{dialData[key].shortLabel}</span>
            </button>
          );
        })}
      </div>
    </SpotlightCard>
  );
}

/* ============================================================================
6. LivePipelineRail — Real-Time 5-Stage LangGraph Visualizer with Active Sweep
   ============================================================================ */
const RAIL_NODES = [
  { label: "Forensics", detail: "OWASP PDF & White-Text Scan", Icon: ShieldAlert },
  { label: "Vision OCR", detail: "Gemini Multimodal Extraction", Icon: FileSearch },
  { label: "3-Way Match", detail: "Decimal PO, GR & IBAN Check", Icon: Cpu },
  { label: "MSA RAG", detail: "pgvector Clause Verification", Icon: Sparkles },
  { label: "Policy Gate", detail: "LangGraph Checkpoint / XML", Icon: ShieldCheck },
];

export function LivePipelineRail({
  activeStageIdx,
  stageMessage,
}: {
  activeStageIdx: number;
  stageMessage: string;
}) {
  const progressPct = Math.min(96, Math.round(((activeStageIdx + 0.65) / RAIL_NODES.length) * 100));

  return (
    <SpotlightCard tone="cyan" className="border-sky-500/35 p-4 dark:border-sky-400/30">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" />
          </span>
          <span className="text-xs font-bold text-slate-900 dark:text-white">
            Live LangGraph Execution Pipeline
          </span>
        </div>
        <span className="font-mono text-[11px] font-medium text-sky-600 tabular-nums dark:text-sky-300">
          {stageMessage}
        </span>
      </div>

      {/* Continuous Spring Progress Track */}
      <div className="relative mb-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800/80">
        <motion.div
          initial={{ width: "8%" }}
          animate={{ width: `${progressPct}%` }}
          transition={{ type: "spring", stiffness: 90, damping: 20 }}
          className="relative h-full overflow-hidden rounded-full bg-linear-to-r from-emerald-500 via-sky-500 to-cyan-400"
        >
          <motion.span
            aria-hidden="true"
            animate={{ x: ["-100%", "220%"] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
            className="absolute inset-y-0 left-0 w-1/2 bg-linear-to-r from-transparent via-white/55 to-transparent"
          />
        </motion.div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {RAIL_NODES.map((node, idx) => {
          const Icon = node.Icon;
          const completed = idx < activeStageIdx;
          const active = idx === activeStageIdx;
          return (
            <div
              key={node.label}
              className={`relative overflow-hidden rounded-xl border px-3 py-2.5 transition-colors duration-200 ${
                active
                  ? "border-sky-500/65 bg-sky-500/10 shadow-[0_0_24px_-10px_rgba(14,165,233,0.75)] dark:bg-sky-500/15"
                  : completed
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-slate-200/80 bg-slate-100/70 opacity-60 dark:border-slate-800 dark:bg-slate-900/50"
              }`}
            >
              {active && (
                <motion.span
                  aria-hidden="true"
                  animate={{ x: ["-120%", "220%"] }}
                  transition={{ repeat: Infinity, duration: 1.8, ease: "linear" }}
                  className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-linear-to-r from-transparent via-sky-400/20 to-transparent"
                />
              )}
              <div className="relative z-10 flex items-center justify-between">
                <Icon
                  className={`h-3.5 w-3.5 ${
                    active
                      ? "text-sky-600 dark:text-sky-300"
                      : completed
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-slate-400"
                  }`}
                />
                {completed ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500 dark:text-sky-300" />
                ) : (
                  <span className="font-mono text-[10px] text-slate-400">0{idx + 1}</span>
                )}
              </div>
              <div className="relative z-10 mt-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                {node.label}
              </div>
              <div className="relative z-10 truncate text-[10px] text-slate-500 dark:text-slate-400">
                {node.detail}
              </div>
            </div>
          );
        })}
      </div>
    </SpotlightCard>
  );
}

/* ============================================================================
7. SandboxDrawer — 100% Opaque, Zero-Snap Slide-Over Simulator
   ============================================================================ */
export interface PresetSpec {
  id: DemoPreset;
  title: string;
  amount: string;
  subtitle: string;
  tag: string;
  tagStyle: string;
  tone: SpotlightTone;
}

export function SandboxDrawer({
  open,
  onClose,
  presets,
  busyAction,
  onRunPreset,
}: {
  open: boolean;
  onClose: () => void;
  presets: PresetSpec[];
  busyAction: string | null;
  onRunPreset: (preset: DemoPreset) => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/55 backdrop-blur-sm"
        >
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: "0%" }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            transformTemplate={(_, generated) =>
              generated === "none" ? "translate3d(0, 0, 0)" : generated
            }
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#0b101b]"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-sky-500" />
                  <h3 className="text-sm font-bold text-slate-950 dark:text-white">
                    Sandbox Simulator
                  </h3>
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-700 dark:text-amber-300">
                    SAMPLE DATA
                  </span>
                </div>
                <p className="mt-1 text-xs leading-4 text-slate-500 dark:text-slate-400">
                  Fire realistic sample payloads through the live FastAPI + Gemini + PostgreSQL
                  pipeline to test auto-settlement, HITL pauses, and fraud defense.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Sandbox Simulator"
                className="cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {presets.map((card) => {
                const isRunning = busyAction === card.id;
                return (
                  <SpotlightCard
                    key={card.id}
                    asButton
                    disabled={busyAction !== null}
                    tone={card.tone}
                    onClick={() => {
                      onClose();
                      onRunPreset(card.id);
                    }}
                    className="group w-full p-4"
                  >
                    <div className="mb-2.5 flex items-center justify-between">
                      <span
                        className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold ${card.tagStyle}`}
                      >
                        {card.tag}
                      </span>
                      <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200">
                        {card.amount}
                      </span>
                    </div>
                    <div className="text-sm leading-5 font-bold text-slate-950 dark:text-white">
                      {card.title}
                    </div>
                    <p className="mt-1 text-xs leading-4 text-slate-500 dark:text-slate-400">
                      {card.subtitle}
                    </p>
                    <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2.5 dark:border-slate-800/80">
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                        {isRunning ? "Running pipeline..." : "Execute sample payload"}
                        {!isRunning && (
                          <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                        )}
                      </span>
                      {isRunning ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
                      ) : (
                        <Play className="h-3.5 w-3.5 text-slate-400 transition-colors group-hover:text-sky-500" />
                      )}
                    </div>
                  </SpotlightCard>
                );
              })}
            </div>

            <div className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-[11px] leading-4 text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
              All runs execute live against your Neon PostgreSQL database and log cryptographically
              sealed audit trails.
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================================================
8. CommandPalette — 100% Opaque, Zero-Snap Ctrl+K Quick Launcher
   ============================================================================ */
export interface PaletteAction {
  id: string;
  group: "Navigate" | "Run Scenario" | "Switch Persona" | "System";
  label: string;
  hint?: string;
  icon: "nav" | "play" | "persona" | "theme" | "sync" | "clock";
  onSelect: () => void;
}

export function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  if (!open) return null;
  return <CommandPaletteDialog onClose={onClose} actions={actions} />;
}

function CommandPaletteDialog({
  onClose,
  actions,
}: {
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q) ||
        (a.hint || "").toLowerCase().includes(q)
    );
  }, [actions, query]);

  const renderIcon = (type: PaletteAction["icon"]) => {
    switch (type) {
      case "play":
        return <Play className="h-3.5 w-3.5 text-emerald-500" />;
      case "persona":
        return <UserCheck className="h-3.5 w-3.5 text-violet-500" />;
      case "theme":
        return <Sparkles className="h-3.5 w-3.5 text-amber-500" />;
      case "sync":
        return <RefreshCw className="h-3.5 w-3.5 text-sky-500" />;
      case "clock":
        return <Clock className="h-3.5 w-3.5 text-sky-500" />;
      default:
        return <LayoutDashboard className="h-3.5 w-3.5 text-slate-400" />;
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 px-4 pt-[12vh] backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-surface w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_64px_-16px_rgba(15,23,42,0.35)] dark:border-slate-700/90 dark:bg-[#0d1321] dark:shadow-[0_28px_72px_-16px_rgba(0,0,0,0.88)]"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3.5 dark:border-slate-800">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to workspace, run sandbox scenario, switch persona, toggle theme..."
            className="flex-1 bg-transparent text-sm leading-5 text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-white dark:placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-md border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] leading-3 text-slate-500 hover:text-slate-900 dark:border-slate-700 dark:text-slate-400 dark:hover:text-white"
          >
            ESC
          </button>
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">No matching commands.</div>
          ) : (
            (["Navigate", "Run Scenario", "Switch Persona", "System"] as const).map((group) => {
              const items = filtered.filter((a) => a.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="px-2.5 py-1 font-mono text-[10px] leading-4 font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    {group}
                  </div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onClose();
                        item.onSelect();
                      }}
                      className="group flex h-9 w-full cursor-pointer items-center justify-between rounded-xl px-3 text-left text-xs transition-colors hover:bg-slate-100 dark:hover:bg-slate-800/90"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {renderIcon(item.icon)}
                        <span className="truncate leading-4 font-medium text-slate-800 dark:text-slate-100">
                          {item.label}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.hint && (
                          <span className="font-mono text-[10px] leading-4 text-slate-400">
                            {item.hint}
                          </span>
                        )}
                        <ArrowRight className="h-3.5 w-3.5 text-slate-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                      </div>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] leading-4 text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Command className="h-3 w-3" />
            LedgerPilot Quick Command
          </span>
          <span className="font-mono text-[10px]">Ctrl + K anywhere</span>
        </div>
      </div>
    </div>
  );
}