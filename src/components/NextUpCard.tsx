import { openUrl } from "@tauri-apps/plugin-opener";
import { Card } from "./Card";
import { CopyLinkButton, formatTime, useNow } from "./Schedule";
import type { Meeting } from "../lib/calendar";

function countdown(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "starting now";
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)}h ${min % 60}m`;
}

export function NextUpCard({ today, delay = 0 }: { today: Meeting[]; delay?: number }) {
  const now = useNow(15_000);
  const upcoming = today.filter((m) => !m.all_day && new Date(m.end).getTime() > now);
  const next = upcoming[0];
  const live = next && new Date(next.start).getTime() <= now;
  const doneCount = today.filter((m) => !m.all_day && new Date(m.end).getTime() <= now).length;
  const timed = today.filter((m) => !m.all_day).length;

  return (
    <Card tone="glass" delay={delay} className="relative overflow-hidden">
      {/* sweeping scanline */}
      <div className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-[scan_7s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-amber-200/[0.04] to-transparent" />
      <div className="flex items-center justify-between">
        <span className="label text-slate-400">{live ? "In progress" : "Next up"}</span>
        <span className={live ? "text-rose-500" : next ? "text-emerald-400" : "text-slate-500"}>
          <span className="status-dot" />
        </span>
      </div>

      {next ? (
        <div className="mt-2 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-slate-100" title={next.title}>
              {next.title}
            </p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-4 font-mono text-xs text-slate-400">
              <span>
                <b className="text-sm text-slate-200">
                  {formatTime(next.start)}–{formatTime(next.end)}
                </b>
              </span>
              <span className={live ? "text-rose-400" : "text-amber-300"}>
                {live ? `ends ${countdown(new Date(next.end).getTime() - now)}` : countdown(new Date(next.start).getTime() - now)}
              </span>
              {next.location && !next.location.startsWith("Microsoft Teams") && (
                <span className="truncate">{next.location}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="mr-2 font-mono text-[11px] text-slate-500">
              {doneCount}/{timed} DONE
            </span>
            {next.join_url && (
              <>
                <CopyLinkButton url={next.join_url} />
                <button
                  onClick={() => openUrl(next.join_url!)}
                  className={`label rounded-md px-3 py-1.5 !text-[11px] transition ${
                    live
                      ? "bg-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,.45)] hover:bg-rose-400"
                      : "bg-slate-100 text-slate-900 hover:bg-white"
                  }`}
                >
                  Join
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-lg font-semibold text-slate-300">
          Clear skies <span className="text-slate-400">— no more meetings today.</span>
        </p>
      )}
    </Card>
  );
}
