import type { CSSProperties, ReactNode } from "react";

export function Card({
  className = "",
  tone = "paper",
  delay = 0,
  style,
  children,
}: {
  className?: string;
  /** "paper" = frosted light panel, "glass" = dark translucent panel. */
  tone?: "paper" | "glass";
  /** Entrance animation delay in ms, for staggering. */
  delay?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={`rise rounded-2xl p-5 ${tone} ${className}`}
      style={{ animationDelay: `${delay}ms`, ...style }}
    >
      {children}
    </div>
  );
}

/** Mono, letter-spaced section heading with an optional right-side slot. */
export function SectionHeader({
  title,
  tone = "glass",
  right,
}: {
  title: ReactNode;
  tone?: "paper" | "glass";
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className={`label ${tone === "paper" ? "text-slate-600" : "text-slate-300"}`}>{title}</h3>
      {right}
    </div>
  );
}

/** Small ghost button used in section headers. */
export function GhostButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="label rounded-md border border-white/10 px-2 py-1 !text-[11px] text-slate-400 transition hover:border-amber-300/40 hover:text-amber-200"
    >
      {children}
    </button>
  );
}
