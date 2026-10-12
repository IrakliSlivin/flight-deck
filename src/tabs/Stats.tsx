import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, SectionHeader } from "../components/Card";
import { StatTile, type TileState } from "../components/StatTile";
import { CalendarIcon, PrIcon, PulseIcon, RefreshIcon, TasksIcon } from "../components/Icons";
import { PrKpiCard } from "../components/PrKpiCard";
import {
  loadGitStats,
  type DayStat,
  type GitStats,
  type RepoStat,
  type Side,
  type SideStat,
  type WeekStat,
} from "../lib/gitStats";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Hours counted as the working day in the "When you commit" split. */
const WORK_START = 9;
const WORK_END = 18;

// Heatmap: one hue (the amber accent), stepped by opacity over the dark panel.
const HEAT = [
  "rgba(148,163,184,.10)",
  "rgba(251,191,36,.28)",
  "rgba(251,191,36,.5)",
  "rgba(251,191,36,.75)",
  "#fbbf24",
];
// Churn: the diverging pair, checked for color-blind separation on the dark panel.
const ADDED = "#3987e5";
const REMOVED = "#e66767";
// Sides: two categorical hues (checked the same way), "other" stays a quiet gray.
const SIDE_META: Record<Side, { label: string; color: string }> = {
  backend: { label: "Backend", color: "#9085e9" },
  frontend: { label: "Frontend", color: "#199e70" },
  other: { label: "Other", color: "#64748b" },
};
const SIDE_ORDER: Side[] = ["backend", "frontend", "other"];

/** "2026-10-12" → local midnight. */
function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

const fmt = (n: number) => n.toLocaleString();

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Consecutive weekdays with commits, ending today (or yesterday, if today has none yet). Weekends never break it. */
function streaks(byDay: Map<string, DayStat>, start: Date, end: Date): { current: number; best: number } {
  let best = 0;
  let run = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (byDay.has(dayKey(d))) run += 1;
    else if (!weekend) run = 0;
    best = Math.max(best, run);
  }
  // A quiet today doesn't end the streak yet.
  if (!byDay.has(dayKey(end)) && end.getDay() !== 0 && end.getDay() !== 6) {
    let current = 0;
    for (let d = addDays(end, -1); d >= start; d = addDays(d, -1)) {
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      if (byDay.has(dayKey(d))) current += 1;
      else if (!weekend) break;
    }
    return { current, best };
  }
  return { current: run, best };
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#0b1220] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-lg group-hover:block">
      {children}
    </div>
  );
}

function Heatmap({ stats, byDay }: { stats: GitStats; byDay: Map<string, DayStat> }) {
  const start = parseDay(stats.start);
  const end = parseDay(stats.end);
  const weeks = Math.round((end.getTime() - start.getTime()) / DAY_MS / 7) + 1;
  const max = Math.max(1, ...stats.days.map((d) => d.commits));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((n / max) * 4))));

  const columns = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
  );
  const busiest = stats.days.reduce<DayStat | null>((b, d) => (!b || d.commits > b.commits ? d : b), null);
  const perWeekday = WEEKDAYS.map((_, i) =>
    stats.days.filter((d) => (parseDay(d.date).getDay() + 6) % 7 === i).reduce((s, d) => s + d.commits, 0),
  );
  const topWeekday = perWeekday.indexOf(Math.max(...perWeekday));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="mt-[22px] grid grid-rows-7 gap-[5px] font-mono text-[10px] text-slate-500">
          {WEEKDAYS.map((d, i) => (
            <span key={d} className="flex h-[22px] items-center">
              {i % 2 === 0 ? d : ""}
            </span>
          ))}
        </div>
        <div className="flex gap-[5px]">
          {columns.map((days, w) => {
            // Label the column a month starts in; the first column too, unless the next one starts a month.
            const startsMonth = (col: Date[]) => col.some((d) => d.getDate() === 1);
            const showMonth = startsMonth(days) || (w === 0 && !startsMonth(columns[1] ?? []));
            const month = days.find((d) => d.getDate() === 1) ?? days[0];
            return (
              <div key={w} className="flex flex-col gap-[5px]">
                <span className="h-[17px] font-mono text-[10px] text-slate-500">
                  {showMonth ? month.toLocaleDateString(undefined, { month: "short" }) : ""}
                </span>
                {days.map((day) => {
                  if (day > end) return <span key={day.getTime()} className="h-[22px] w-[22px]" />;
                  const stat = byDay.get(dayKey(day));
                  const n = stat?.commits ?? 0;
                  return (
                    <div key={day.getTime()} className="group relative">
                      <div
                        className={`h-[22px] w-[22px] rounded-[5px] transition hover:ring-2 hover:ring-amber-200/70 ${
                          dayKey(day) === stats.end ? "ring-1 ring-slate-300/40" : ""
                        }`}
                        style={{ background: HEAT[level(n)] }}
                      />
                      <Tip>
                        <span className="text-slate-400">{formatDay(day)}</span> ·{" "}
                        {n === 0 ? "no commits" : `${n} commit${n === 1 ? "" : "s"}`}
                        {stat && (
                          <>
                            {" "}
                            · <span style={{ color: ADDED }}>+{fmt(stat.added)}</span>{" "}
                            <span style={{ color: REMOVED }}>−{fmt(stat.removed)}</span>
                          </>
                        )}
                      </Tip>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[11px] text-slate-500">
        <span>
          {busiest ? (
            <>
              Busiest: <span className="text-slate-300">{formatDay(parseDay(busiest.date))}</span> · {busiest.commits}{" "}
              commits · most on <span className="text-slate-300">{WEEKDAYS[topWeekday]}</span>
            </>
          ) : (
            "No commits in these 12 weeks"
          )}
        </span>
        <span className="flex items-center gap-1">
          Less
          {HEAT.map((c) => (
            <span key={c} className="h-[11px] w-[11px] rounded-[3px]" style={{ background: c }} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

function HoursChart({ hours }: { hours: number[] }) {
  const total = hours.reduce((s, n) => s + n, 0);
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  const work = hours.slice(WORK_START, WORK_END).reduce((s, n) => s + n, 0);
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative flex h-[150px] items-end gap-[3px] border-b border-slate-500/40">
        {hours.map((n, h) => (
          <div key={h} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-[4px] bg-amber-400/85 transition group-hover:bg-amber-200"
              style={{ height: n ? `${Math.max((n / max) * 100, 3)}%` : 0 }}
            />
            <Tip>
              <span className="text-slate-400">
                {hourLabel(h)}–{hourLabel((h + 1) % 24)}
              </span>{" "}
              · {n} commit{n === 1 ? "" : "s"} ({pct(n)}%)
            </Tip>
          </div>
        ))}
      </div>
      <div className="flex gap-[3px] font-mono text-[10px] text-slate-500">
        {hours.map((_, h) => (
          <span key={h} className="flex-1 text-center">
            {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
          </span>
        ))}
      </div>
      <p className="mt-auto font-mono text-[11px] text-slate-500">
        {total === 0 ? (
          "No commits yet"
        ) : (
          <>
            Peak <span className="text-slate-300">{hourLabel(peak)}</span> ·{" "}
            <span className="text-slate-300">{pct(work)}%</span> in {hourLabel(WORK_START)}–{hourLabel(WORK_END)} ·{" "}
            <span className="text-slate-300">{pct(total - work)}%</span> outside
          </>
        )}
      </p>
    </div>
  );
}

function ChurnChart({ repos }: { repos: RepoStat[] }) {
  const active = repos.filter((r) => r.commits > 0);
  const quiet = repos.filter((r) => r.commits === 0);
  const max = Math.max(1, ...active.flatMap((r) => [r.added, r.removed]));
  const width = (n: number) => (n ? `${Math.max((n / max) * 100, 1)}%` : 0);

  return (
    <div className="flex flex-col gap-1">
      {active.length === 0 && <p className="text-sm text-slate-400">No commits in these 12 weeks.</p>}
      {active.map((r) => (
        <div
          key={r.path}
          className="group relative grid grid-cols-[minmax(120px,200px)_1fr_1fr_minmax(150px,auto)] items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.03]"
        >
          <span className="truncate text-sm text-slate-200" title={r.path}>
            {r.name}
          </span>
          <div className="flex h-[14px] justify-end border-r border-slate-500/50">
            <div className="h-full rounded-l-[4px]" style={{ width: width(r.removed), background: REMOVED }} />
          </div>
          <div className="flex h-[14px]">
            <div className="h-full rounded-r-[4px]" style={{ width: width(r.added), background: ADDED }} />
          </div>
          <span className="text-right font-mono text-[11px] tabular-nums text-slate-400">
            <span className="text-slate-200">+{fmt(r.added)}</span> −{fmt(r.removed)} · {r.commits} commit
            {r.commits === 1 ? "" : "s"}
          </span>
          {r.last_commit && (
            <Tip>
              <span className="text-slate-400">{r.path}</span> · last commit {formatDay(new Date(r.last_commit * 1000))}
              {SIDE_ORDER.filter((side) => r[side] > 0).map((side) => (
                <span key={side}>
                  {" "}
                  · {SIDE_META[side].label.toLowerCase()} {pctOf(r[side], r.backend + r.frontend + r.other)}%
                </span>
              ))}
            </Tip>
          )}
        </div>
      ))}
      {quiet.length > 0 && (
        <p className="mt-2 px-2 font-mono text-[11px] text-slate-500">
          No commits: {quiet.map((r) => r.name).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Whole percent; a small but nonzero share reads "<1". */
const pctOf = (n: number, total: number) => {
  const p = total ? (n / total) * 100 : 0;
  return p > 0 && p < 1 ? "<1" : Math.round(p);
};

/** Share of lines changed per side, with each side's top languages. */
function SideSplit({ sides }: { sides: SideStat[] }) {
  const lines = (s: SideStat) => s.added + s.removed;
  const total = sides.reduce((sum, s) => sum + lines(s), 0);
  const ordered = SIDE_ORDER.map((id) => sides.find((s) => s.side === id)).filter((s): s is SideStat => !!s);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-[14px] gap-[2px] overflow-hidden rounded-[4px]">
        {ordered
          .filter((s) => lines(s) > 0)
          .map((s) => (
            <div
              key={s.side}
              className="group relative h-full"
              style={{ width: `${(lines(s) / (total || 1)) * 100}%`, background: SIDE_META[s.side].color }}
            >
              <Tip>
                {SIDE_META[s.side].label} · {pctOf(lines(s), total)}% of lines changed
              </Tip>
            </div>
          ))}
        {total === 0 && <div className="h-full w-full bg-white/[0.06]" />}
      </div>
      {ordered.map((s) => (
        <div key={s.side} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-slate-200">
              <span className="h-[10px] w-[10px] rounded-[3px]" style={{ background: SIDE_META[s.side].color }} />
              {SIDE_META[s.side].label}
              <span className="font-mono text-[12px] text-slate-400">{pctOf(lines(s), total)}%</span>
            </span>
            <span className="font-mono text-[11px] tabular-nums text-slate-400">
              <span className="text-slate-200">+{fmt(s.added)}</span> −{fmt(s.removed)} · {s.commits} commit
              {s.commits === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 pl-[18px]">
            {s.languages.length === 0 && <span className="font-mono text-[11px] text-slate-500">nothing yet</span>}
            {s.languages.slice(0, 5).map((l) => (
              <span
                key={l.name}
                title={`+${fmt(l.added)} −${fmt(l.removed)}`}
                className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300"
              >
                {l.name} <span className="text-slate-500">{pctOf(l.added + l.removed, lines(s))}%</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lines changed per week, stacked by side. */
function WeeklySides({ weeks, end }: { weeks: WeekStat[]; end: string }) {
  const total = (w: WeekStat) => w.backend + w.frontend + w.other;
  const max = Math.max(1, ...weeks.map(total));
  const today = parseDay(end);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex h-[170px] items-end gap-[6px] border-b border-slate-500/40">
        {weeks.map((w) => {
          const t = total(w);
          const parts = SIDE_ORDER.filter((side) => w[side] > 0);
          return (
            <div key={w.start} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] transition group-hover:brightness-125"
                style={{ height: `${(t / max) * 100}%` }}
              >
                {parts.map((side) => (
                  <div key={side} style={{ flexGrow: w[side], flexBasis: 0, background: SIDE_META[side].color }} />
                ))}
              </div>
              <Tip>
                <span className="text-slate-400">
                  Week of {parseDay(w.start).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                </span>
                {t === 0 && " · no changes"}
                {SIDE_ORDER.filter((side) => w[side] > 0).map((side) => (
                  <span key={side}>
                    {" "}
                    · {SIDE_META[side].label} {fmt(w[side])}
                  </span>
                ))}
              </Tip>
            </div>
          );
        })}
      </div>
      <div className="flex gap-[6px] font-mono text-[10px] text-slate-500">
        {weeks.map((w, i) => {
          const d = parseDay(w.start);
          const current = addDays(d, 7) > today;
          return (
            <span key={w.start} className={`flex-1 text-center ${current ? "text-slate-300" : ""}`}>
              {current ? "now" : i % 2 === 0 ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}
            </span>
          );
        })}
      </div>
      <p className="mt-auto font-mono text-[11px] text-slate-500">Lines changed per week, by side.</p>
    </div>
  );
}

function SideLegend() {
  return (
    <span className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
      {SIDE_ORDER.map((side) => (
        <span key={side} className="flex items-center gap-1.5">
          <span className="h-[10px] w-[10px] rounded-[3px]" style={{ background: SIDE_META[side].color }} />
          {SIDE_META[side].label}
        </span>
      ))}
    </span>
  );
}

function Legend() {
  return (
    <span className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
      <span className="flex items-center gap-1.5">
        <span className="h-[10px] w-[10px] rounded-[3px]" style={{ background: REMOVED }} /> Removed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[10px] w-[10px] rounded-[3px]" style={{ background: ADDED }} /> Added
      </span>
    </span>
  );
}

export function Stats({ openSettings }: { openSettings: () => void }) {
  const [data, setData] = useState<GitStats | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(force: boolean) {
    setLoading(true);
    setError(null);
    try {
      const result = await loadGitStats(force);
      setData(result.data);
      setFetchedAt(result.at);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(false);
  }, []);

  const byDay = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);
  const summary = useMemo(() => {
    if (!data) return null;
    const start = parseDay(data.start);
    const end = parseDay(data.end);
    const commits = data.days.reduce((s, d) => s + d.commits, 0);
    const added = data.days.reduce((s, d) => s + d.added, 0);
    const removed = data.days.reduce((s, d) => s + d.removed, 0);
    const weekStart = addDays(end, -((end.getDay() + 6) % 7));
    const thisWeek = data.days.filter((d) => parseDay(d.date) >= weekStart).reduce((s, d) => s + d.commits, 0);
    const elapsed = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    const weeks = Math.ceil(elapsed / 7);
    return { commits, added, removed, thisWeek, elapsed, weeks, ...streaks(byDay, start, end) };
  }, [data, byDay]);

  const state: TileState = error ? "error" : loading ? "loading" : "ok";

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-2 pb-8">
      <div className="rise flex items-end justify-between">
        <div>
          <h2 className="label !text-[13px] text-slate-200">Stats</h2>
          <p className="mt-1 font-mono text-[11px] text-slate-500">
            Local git · last 12 weeks
            {data && ` · ${data.repos.length} repo${data.repos.length === 1 ? "" : "s"}`}
            {data && data.emails.length > 0 && ` · ${data.emails.join(", ")}`}
            {fetchedAt && ` · read ${fetchedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <button
          onClick={() => refresh(true)}
          disabled={loading}
          className="label flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-50"
        >
          <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatTile
          label="Commits"
          value={summary?.commits ?? null}
          state={state}
          sub={
            summary
              ? `${summary.thisWeek} this week · ${Math.round(summary.commits / summary.weeks)}/wk avg`
              : undefined
          }
          icon={PrIcon}
          iconClass="text-amber-500"
          delay={40}
        />
        <StatTile
          label="Active days"
          value={data?.days.length ?? null}
          state={state}
          sub={
            summary ? `of ${summary.elapsed} · ${Math.round((data!.days.length / summary.elapsed) * 100)}%` : undefined
          }
          icon={CalendarIcon}
          iconClass="text-sky-500"
          delay={90}
        />
        <StatTile
          label="Lines added"
          value={summary?.added ?? null}
          state={state}
          sub={
            summary
              ? `−${fmt(summary.removed)} removed · net ${summary.added >= summary.removed ? "+" : "−"}${fmt(Math.abs(summary.added - summary.removed))}`
              : undefined
          }
          icon={PulseIcon}
          iconClass="text-blue-500"
          delay={140}
        />
        <StatTile
          label="Weekday streak"
          value={summary?.current ?? null}
          state={state}
          sub={summary ? `best ${summary.best} · weekends don't count` : undefined}
          icon={TasksIcon}
          iconClass="text-emerald-500"
          delay={190}
        />
      </div>

      {error && (
        <Card tone="glass" delay={220} className="flex items-center justify-between gap-4">
          <p className="text-sm text-rose-300">{error}</p>
          <button onClick={openSettings} className="label shrink-0 !text-[11px] text-amber-300 hover:text-amber-200">
            Settings
          </button>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-4">
            <Card tone="glass" delay={220}>
              <SectionHeader title="Commit activity" />
              <Heatmap stats={data} byDay={byDay} />
            </Card>
            <Card tone="glass" delay={270} className="flex flex-col">
              <SectionHeader title="When you commit" />
              <HoursChart hours={data.hours} />
            </Card>
          </div>

          <Card tone="glass" delay={320}>
            <SectionHeader title="Backend vs frontend" right={<SideLegend />} />
            <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-8">
              <SideSplit sides={data.sides} />
              <WeeklySides weeks={data.weeks} end={data.end} />
            </div>
            <p className="mt-4 font-mono text-[11px] text-slate-500">
              Sorted by language. .js/.ts follows the repo: frontend when its package.json uses React, Vue, Angular,
              Svelte or similar (or it has none), backend for a Node service. Views (.erb, .haml) count as frontend;
              docs, config and scripts as other.
            </p>
          </Card>

          <Card tone="glass" delay={370}>
            <SectionHeader title="Churn by repo" right={<Legend />} />
            <ChurnChart repos={data.repos} />
            {data.errors.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 border-t border-white/[0.06] pt-3 font-mono text-[11px] text-rose-300">
                {data.errors.map((e) => (
                  <li key={e.path}>
                    {e.path}: {e.error}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 font-mono text-[11px] text-slate-500">
              Every branch, merges left out. Lock files, minified and built files (dist/, node_modules/, vendor/) don't
              count.
            </p>
          </Card>
        </>
      )}

      <PrKpiCard openSettings={openSettings} delay={420} />
    </div>
  );
}
