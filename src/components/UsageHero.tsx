import { useEffect, useState } from "react";
import { Card } from "./Card";
import { useCountUp } from "../hooks/useCountUp";
import {
  readClaudeRateLimits,
  type RateLimitSnapshot,
  type RateLimitWindow,
} from "../lib/usage";

const POLL_MS = 60_000;
const TICKS = [0, 25, 50, 75, 100];

function formatReset(epochSeconds: number): string {
  const diffMin = Math.max(0, Math.round((epochSeconds * 1000 - Date.now()) / 60_000));
  if (diffMin < 60) return `resets in ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `resets in ${hours}h ${diffMin % 60}m`;
  return `resets ${new Date(epochSeconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatAge(epochSeconds: number): string {
  const min = Math.round((Date.now() - epochSeconds * 1000) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function barTone(pct: number): string {
  if (pct >= 90) return "from-rose-700 via-rose-500 to-rose-400";
  if (pct >= 70) return "from-amber-700 via-amber-500 to-amber-300";
  return "from-slate-900 via-slate-700 to-slate-500";
}

// Matches useCountUp's ease-out cubic, so the bar, spark and number land together.
const EASE_OUT_CUBIC = "cubic-bezier(0.33, 1, 0.68, 1)";
const FILL_MS = 1200;

/**
 * Ruler-style progress bar with a glowing spark at the leading edge. Takes the final value and
 * animates with one CSS transition on clip-path/transform (no per-frame width changes, which
 * forced a layout pass every frame and fought the transition).
 */
function Ruler({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const transition = `${FILL_MS}ms ${EASE_OUT_CUBIC}`;
  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <div className="relative h-8 rounded-md bg-slate-900/[0.07] ring-1 ring-slate-900/10">
        {/* minor ticks */}
        <div
          className="absolute inset-0 rounded-md opacity-60"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent 0, transparent calc(5% - 1px), rgba(15,23,42,.12) calc(5% - 1px), rgba(15,23,42,.12) 5%)",
          }}
        />
        <div
          className={`shimmer absolute inset-0 rounded-md bg-gradient-to-r ${barTone(clamped)}`}
          style={{
            clipPath: `inset(0 ${100 - clamped}% 0 0 round 6px)`,
            transition: `clip-path ${transition}`,
          }}
        >
          {/* star-dust texture on the filled part */}
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "radial-gradient(rgba(255,255,255,.7) 0.6px, transparent 0.8px)",
              backgroundSize: "7px 7px",
            }}
          />
        </div>
        {/* Full-width track so translateX(%) is a share of the bar, not of the spark. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            transform: `translateX(${clamped}%)`,
            transition: `transform ${transition}`,
            opacity: clamped > 0 ? 1 : 0,
          }}
        >
          <span className="spark" style={{ left: 0 }} />
        </div>
      </div>
      <div className="relative h-3 font-mono text-[10.5px] text-slate-500">
        {TICKS.map((t) => (
          <span
            key={t}
            className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${t}%` }}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Weekly: big percentage, ruler bar, reset time. */
function WeeklyRow({ window }: { window: RateLimitWindow | null }) {
  const pct = useCountUp(window ? window.used_percentage : null, FILL_MS);
  return (
    <div className="flex items-center gap-6">
      <div className="flex w-32 shrink-0 items-baseline">
        <span className="text-5xl font-semibold leading-none tracking-tighter tabular-nums">
          {pct === null ? "—" : Math.round(pct)}
        </span>
        <span className="ml-0.5 text-lg font-medium text-slate-600">%</span>
      </div>
      <Ruler pct={window ? window.used_percentage : 0} />
      <div className="flex w-36 shrink-0 flex-col items-end gap-0.5">
        <span className="label !text-[11px] text-slate-500">Weekly</span>
        <span className="font-mono text-[11px] text-slate-600">
          {window ? formatReset(window.resets_at) : "no data"}
        </span>
      </div>
    </div>
  );
}

const SEGMENTS = 20;

function segmentTone(pct: number): string {
  if (pct >= 90) return "bg-rose-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-slate-700";
}

/** 5-hour: one compact line with a segmented meter, one segment per 5%. */
function FiveHourRow({ window }: { window: RateLimitWindow | null }) {
  const pct = useCountUp(window ? window.used_percentage : null, FILL_MS);
  const filled = Math.round(((pct ?? 0) / 100) * SEGMENTS);
  const tone = segmentTone(pct ?? 0);
  return (
    <div className="flex items-center gap-6 border-t border-slate-900/10 pt-2">
      <div className="flex w-32 shrink-0 items-baseline justify-between">
        <span className="label !text-[11px] text-slate-500">5-hour</span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {pct === null ? "—" : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="flex h-2 flex-1 gap-[3px]">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={`flex-1 rounded-full transition-colors duration-500 ${i < filled ? tone : "bg-slate-900/10"}`}
          />
        ))}
      </div>
      <span className="w-36 shrink-0 text-right font-mono text-[11px] text-slate-600">
        {window ? formatReset(window.resets_at) : "no data"}
      </span>
    </div>
  );
}

export function UsageHero({ delay = 0 }: { delay?: number }) {
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function refresh() {
      try {
        setSnapshot(await readClaudeRateLimits());
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoaded(true);
      }
    }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Card delay={delay} className="flex flex-col gap-2 !py-4">
      <div className="flex items-center justify-between">
        <h3 className="label text-slate-600">
          Claude <span className="text-slate-500">·</span> Usage
        </h3>
        <span className="font-mono text-[11px] text-slate-500">
          {snapshot ? `updated ${formatAge(snapshot.updated_at)}` : loaded ? "last known" : "syncing…"}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-rose-600">{error}</p>
      ) : loaded && !snapshot ? (
        <p className="text-sm text-slate-600">
          No data yet — it appears after your next Claude Code reply in the terminal.
        </p>
      ) : (
        <>
          <WeeklyRow window={snapshot?.rate_limits.seven_day ?? null} />
          <FiveHourRow window={snapshot?.rate_limits.five_hour ?? null} />
        </>
      )}
    </Card>
  );
}
