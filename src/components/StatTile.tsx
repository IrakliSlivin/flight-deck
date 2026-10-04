import type { ComponentType, SVGProps } from "react";
import { Card } from "./Card";
import { useCountUp } from "../hooks/useCountUp";

export type TileState = "ok" | "loading" | "error";

const STATE_COLOR: Record<TileState, string> = {
  ok: "text-emerald-500",
  loading: "text-amber-500",
  error: "text-rose-500",
};

export function StatTile({
  label,
  value,
  sub,
  state,
  icon: Icon,
  iconClass = "text-rose-400",
  delay = 0,
  onClick,
}: {
  label: string;
  value: number | null;
  sub?: string;
  state: TileState;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  iconClass?: string;
  delay?: number;
  onClick?: () => void;
}) {
  const shown = useCountUp(value);

  return (
    <Card
      delay={delay}
      className={`group relative flex flex-col gap-1.5 !py-4 transition-shadow duration-300 hover:shadow-[0_0_0_1px_rgba(251,191,36,.35),0_18px_40px_-18px_rgba(0,0,0,.7)] ${
        onClick ? "cursor-pointer" : ""
      }`}
    >
      <div onClick={onClick} className="contents">
        <div className="flex items-center justify-between">
          <span className="label !text-[11px] text-slate-500">{label}</span>
          <span className={STATE_COLOR[state]}>
            <span className="status-dot" />
          </span>
        </div>
        <div className="flex items-end justify-between">
          <span className="text-[34px] font-semibold leading-none tracking-tight tabular-nums">
            {state === "loading" && value === null ? (
              <span className="blink text-slate-500">··</span>
            ) : shown === null ? (
              "—"
            ) : (
              Math.round(shown)
            )}
          </span>
          <Icon
            className={`h-9 w-9 transition-transform duration-500 group-hover:rotate-[-6deg] group-hover:scale-110 ${iconClass}`}
          />
        </div>
        <span className="truncate font-mono text-[12px] text-slate-600">{sub ?? " "}</span>
      </div>
    </Card>
  );
}
