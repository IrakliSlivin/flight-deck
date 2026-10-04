import type { MouseEvent } from "react";

export interface Action {
  label: string;
  run: () => void;
  /** Shows the highlighted "running" state (e.g. while a fetch is in flight). */
  busy?: boolean;
  /** Emphasized button — the primary action in the grid. */
  primary?: boolean;
}

function trackPointer(e: MouseEvent<HTMLButtonElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function ActionGrid({ actions, delay = 0 }: { actions: Action[]; delay?: number }) {
  return (
    <div className="grid grid-cols-5 gap-3">
      {actions.map((action, i) => {
        const lit = action.busy || action.primary;
        return (
          <button
            key={action.label}
            onClick={action.run}
            onMouseMove={trackPointer}
            style={{ animationDelay: `${delay + i * 35}ms` }}
            className={`rise action-btn label rounded-xl border px-3 py-3.5 !text-[11px] transition-all duration-300 active:scale-[0.97] ${
              lit
                ? "border-white/60 bg-gradient-to-b from-slate-100 to-slate-300 text-slate-900 shadow-[0_0_24px_rgba(226,232,240,.18)]"
                : "border-white/[0.07] bg-white/[0.03] text-slate-400 hover:border-amber-300/25 hover:text-slate-200"
            } ${action.busy ? "animate-pulse" : ""}`}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
