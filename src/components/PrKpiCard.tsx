import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card, SectionHeader } from "./Card";
import { RefreshIcon } from "./Icons";
import {
  byAuthor,
  computeKpi,
  loadStoredKpis,
  monthKey,
  useKpiRun,
  useKpiSavedVersion,
  type AuthorKpi,
  type StoredKpi,
} from "../lib/prKpi";

const MONTHS_SHOWN = 12;

const hours = (seconds: number) => (seconds / 3600).toFixed(1);
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

function monthLabel(month: string, style: "long" | "short" = "long"): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: style === "long" ? "numeric" : "2-digit",
  });
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#0b1220] px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-lg group-hover:block">
      {children}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <span className="label !text-[10.5px] text-slate-500">{label}</span>
      <span className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-slate-100">{value}</span>
      <span className="font-mono text-[11px] text-slate-500">{sub}</span>
    </div>
  );
}

function teamTotals(authors: AuthorKpi[]) {
  const sum = (f: (a: AuthorKpi) => number) => authors.reduce((s, a) => s + f(a), 0);
  const ready = sum((a) => a.ready);
  return {
    ready,
    avgSeconds: ready ? sum((a) => a.reviewSeconds) / ready : 0,
    merged: sum((a) => a.merged),
    rework: sum((a) => a.rework),
  };
}

function TeamTable({
  authors,
  me,
  selected,
  onSelect,
}: {
  authors: AuthorKpi[];
  me: string;
  selected: string;
  onSelect: (uuid: string) => void;
}) {
  const maxAvg = Math.max(1, ...authors.map((a) => a.avgSeconds));
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[minmax(140px,1fr)_60px_minmax(110px,1.2fr)_60px_60px_90px] gap-3 border-b border-white/[0.06] px-2 pb-1.5 font-mono text-[10.5px] uppercase tracking-wider text-slate-500">
        <span>Author</span>
        <span className="text-right">Ready</span>
        <span>Avg review</span>
        <span className="text-right">Waiting</span>
        <span className="text-right">Merged</span>
        <span className="text-right">Rework</span>
      </div>
      {authors.map((a) => {
        const key = a.uuid || a.name;
        const mine = a.uuid === me;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`grid grid-cols-[minmax(140px,1fr)_60px_minmax(110px,1.2fr)_60px_60px_90px] items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm tabular-nums transition hover:bg-white/[0.04] ${
              selected === key ? "bg-white/[0.07] ring-1 ring-amber-300/25" : ""
            }`}
          >
            <span className={`truncate ${mine ? "text-amber-200" : "text-slate-200"}`}>
              {a.name || "Unknown"}
              {mine && <span className="ml-1.5 font-mono text-[10.5px] text-amber-300/70">you</span>}
            </span>
            <span className="text-right font-mono text-[12px] text-slate-300">{a.ready || "—"}</span>
            <span className="flex items-center gap-2">
              <span className="w-[42px] shrink-0 text-right font-mono text-[12px] text-slate-200">
                {a.ready ? hours(a.avgSeconds) : "—"}
              </span>
              <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                <span
                  className={`block h-full rounded-full ${mine ? "bg-amber-400" : "bg-slate-400/60"}`}
                  style={{ width: `${(a.avgSeconds / maxAvg) * 100}%` }}
                />
              </span>
            </span>
            <span className="text-right font-mono text-[12px] text-slate-400">{a.waiting || "—"}</span>
            <span className="text-right font-mono text-[12px] text-slate-300">{a.merged || "—"}</span>
            <span className="text-right font-mono text-[12px] text-slate-300">
              {a.merged ? (
                <>
                  {pct(a.rework, a.merged)} <span className="text-slate-500">({a.rework})</span>
                </>
              ) : (
                "—"
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Your average review time per stored month, oldest first; click a month to open it. */
function History({ stored, month, onSelect }: { stored: StoredKpi[]; month: string; onSelect: (m: string) => void }) {
  const points = [...stored]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((k) => {
      const mine = byAuthor(k).find((a) => a.uuid === k.me);
      return { month: k.month, mine };
    });
  const max = Math.max(1, ...points.map((p) => p.mine?.avgSeconds ?? 0));

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex h-[170px] items-end gap-[6px] border-b border-slate-500/40">
        {points.map((p) => (
          <button
            key={p.month}
            onClick={() => onSelect(p.month)}
            className="group relative flex h-full max-w-[56px] flex-1 flex-col justify-end pt-5"
          >
            {!!p.mine?.ready && (
              <span className="mb-1 text-center font-mono text-[10px] text-slate-400">{hours(p.mine.avgSeconds)}</span>
            )}
            <div
              className={`w-full rounded-t-[4px] transition group-hover:brightness-125 ${
                p.month === month ? "bg-amber-400" : "bg-amber-400/45"
              }`}
              style={{ height: p.mine?.ready ? `${Math.max((p.mine.avgSeconds / max) * 100, 3)}%` : 0 }}
            />
            <Tip>
              <span className="text-slate-400">{monthLabel(p.month)}</span>
              {p.mine ? (
                <>
                  {" "}
                  · {p.mine.ready ? `${hours(p.mine.avgSeconds)} h avg review` : "no PRs ready"} · rework{" "}
                  {pct(p.mine.rework, p.mine.merged)}
                </>
              ) : (
                " · no PRs of yours"
              )}
            </Tip>
          </button>
        ))}
      </div>
      <div className="flex gap-[6px] font-mono text-[10px] text-slate-500">
        {points.map((p) => (
          <span
            key={p.month}
            className={`flex max-w-[56px] flex-1 flex-col items-center ${p.month === month ? "text-slate-200" : ""}`}
          >
            <span>{monthLabel(p.month, "short")}</span>
            <span className="text-slate-600">{p.mine?.merged ? pct(p.mine.rework, p.mine.merged) : "—"}</span>
          </span>
        ))}
      </div>
      <p className="mt-auto font-mono text-[11px] text-slate-500">
        Your average review time per saved month (hours), rework rate under each.
      </p>
    </div>
  );
}

function PrList({ kpi, author }: { kpi: StoredKpi; author: string }) {
  const ready = kpi.ready
    .filter((p) => (p.author_uuid || p.author) === author)
    .sort((a, b) => a.ready_on.localeCompare(b.ready_on));
  const merged = kpi.merged.filter((p) => (p.author_uuid || p.author) === author);
  const row = "group flex items-baseline gap-3 rounded-md px-2 py-1 text-left transition hover:bg-white/[0.04]";
  const ref = (p: { repo: string; id: number }) => `${p.repo.split("/").pop()} #${p.id}`;

  return (
    <div className="grid grid-cols-2 gap-6">
      <div className="flex flex-col">
        <span className="label mb-1.5 px-2 !text-[10.5px] text-slate-500">Ready for review · {ready.length}</span>
        {ready.length === 0 && <span className="px-2 font-mono text-[11px] text-slate-500">none</span>}
        {ready.map((p) => (
          <button key={`${p.repo}#${p.id}`} onClick={() => openUrl(p.url)} className={row}>
            <span className="w-[160px] shrink-0 truncate font-mono text-[11px] text-slate-500">{ref(p)}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-200 group-hover:text-amber-200">{p.title}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
              {shortDate(p.ready_on)} ·{" "}
              {p.approved_on ? (
                <span className="text-slate-200">{hours(p.review_seconds)} h</span>
              ) : (
                <span className="text-amber-300" title="Not approved twice yet: counted until it was computed">
                  {hours(p.review_seconds)} h, waiting
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-col">
        <span className="label mb-1.5 px-2 !text-[10.5px] text-slate-500">Merged · {merged.length}</span>
        {merged.length === 0 && <span className="px-2 font-mono text-[11px] text-slate-500">none</span>}
        {merged.map((p) => (
          <button key={`${p.repo}#${p.id}`} onClick={() => openUrl(p.url)} className={row}>
            <span className="w-[160px] shrink-0 truncate font-mono text-[11px] text-slate-500">{ref(p)}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-200 group-hover:text-amber-200">{p.title}</span>
            {p.rework && (
              <span className="shrink-0 rounded bg-rose-400/15 px-1.5 py-0.5 font-mono text-[10.5px] text-rose-300">
                changes requested
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Monthly PR KPIs from Bitbucket: computed on demand, every computed month kept in SQLite. */
export function PrKpiCard({ openSettings, delay = 0 }: { openSettings: () => void; delay?: number }) {
  const run = useKpiRun();
  const version = useKpiSavedVersion();
  const [stored, setStored] = useState<StoredKpi[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => monthKey(-1));
  const [author, setAuthor] = useState<string | null>(null);
  const [showPrs, setShowPrs] = useState(false);

  useEffect(() => {
    loadStoredKpis()
      .then(setStored)
      .catch((e) => setLoadError(String(e)));
  }, [version]);

  const months = useMemo(() => Array.from({ length: MONTHS_SHOWN }, (_, i) => monthKey(-i)), []);
  const kpi = stored?.find((k) => k.month === month) ?? null;
  const authors = useMemo(() => (kpi ? byAuthor(kpi) : []), [kpi]);
  const mine = kpi ? authors.find((a) => a.uuid === kpi.me) : undefined;
  const team = teamTotals(authors);
  const selected = author && authors.some((a) => (a.uuid || a.name) === author) ? author : (kpi?.me ?? "");
  const selectedName = authors.find((a) => (a.uuid || a.name) === selected)?.name;
  const current = month === monthKey(0);
  const runHere = run?.month === month ? run : null;
  const busy = !!run?.running;
  const savedMonths = new Set(stored?.map((k) => k.month));

  const progress = runHere?.progress;
  const progressPct = progress && progress.total ? (progress.done / progress.total) * 100 : 0;

  return (
    <Card tone="glass" delay={delay}>
      <SectionHeader
        title="PR KPI · Bitbucket"
        right={
          <div className="flex items-center gap-2">
            <select
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setAuthor(null);
              }}
              className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[12px] text-slate-100 outline-none transition focus:border-amber-300/50"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                  {m === monthKey(0) ? " (so far)" : ""}
                  {savedMonths.has(m) ? " · saved" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => computeKpi(month)}
              disabled={busy}
              className="label flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-50"
            >
              <RefreshIcon className={`h-3.5 w-3.5 ${runHere?.running ? "animate-spin" : ""}`} />
              {runHere?.running ? "Computing" : kpi ? "Recompute" : "Compute"}
            </button>
          </div>
        }
      />

      <p className="-mt-1 mb-4 font-mono text-[11px] text-slate-500">
        {kpi ? (
          <>
            {monthLabel(month)}
            {current && " (month in progress)"} · computed{" "}
            {new Date(kpi.computed_at).toLocaleString(undefined, {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            · {kpi.repos} repos · {kpi.ready.length} PRs ready for review · {kpi.merged.length} merged
          </>
        ) : stored === null && !loadError ? (
          "Reading saved months…"
        ) : (
          <>
            {monthLabel(month)} isn't computed yet. Compute reads every PR in your Bitbucket workspace for the month, so
            it takes a minute or so; the result is saved here.
          </>
        )}
      </p>

      {runHere?.running && (
        <div className="mb-4 flex flex-col gap-1.5">
          <div className="h-[6px] overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full bg-amber-400 transition-[width] duration-300 ${progress?.total ? "" : "w-1/4 animate-pulse"}`}
              style={progress?.total ? { width: `${progressPct}%` } : undefined}
            />
          </div>
          <span className="font-mono text-[11px] text-slate-400">
            {progress ? progress.step : "Starting"}
            {progress?.total ? ` · ${progress.done}/${progress.total}` : "…"}
          </span>
        </div>
      )}
      {busy && !runHere && (
        <p className="mb-4 font-mono text-[11px] text-slate-500">Computing {monthLabel(run!.month)}…</p>
      )}

      {(runHere?.error || loadError) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-sm text-rose-300">{runHere?.error ?? loadError}</p>
          {runHere?.error && (
            <button onClick={openSettings} className="label shrink-0 !text-[11px] text-amber-300 hover:text-amber-200">
              Settings
            </button>
          )}
        </div>
      )}

      {kpi && (
        <>
          <div className="grid grid-cols-[minmax(0,7fr)_minmax(0,4fr)] gap-8">
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-4 gap-3">
                <Metric
                  label="Review time"
                  value={mine?.ready ? `${hours(mine.avgSeconds)} h` : "—"}
                  sub={`team ${team.ready ? hours(team.avgSeconds) : "—"} h avg`}
                />
                <Metric
                  label="Ready for review"
                  value={mine?.ready ?? 0}
                  sub={mine?.waiting ? `${mine.waiting} not approved twice` : `of ${team.ready} in the team`}
                />
                <Metric label="Merged" value={mine?.merged ?? 0} sub={`of ${team.merged} in the team`} />
                <Metric
                  label="Rework"
                  value={mine?.merged ? pct(mine.rework, mine.merged) : "—"}
                  sub={`${mine?.rework ?? 0} PRs · team ${pct(team.rework, team.merged)}`}
                />
              </div>
              {authors.length === 0 ? (
                <p className="text-sm text-slate-400">No PRs in {monthLabel(month)}.</p>
              ) : (
                <TeamTable
                  authors={authors}
                  me={kpi.me}
                  selected={selected}
                  onSelect={(uuid) => {
                    setAuthor(uuid);
                    setShowPrs(true);
                  }}
                />
              )}
            </div>
            <History stored={stored ?? []} month={month} onSelect={setMonth} />
          </div>

          {authors.length > 0 && (
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <button
                onClick={() => setShowPrs((v) => !v)}
                className="label mb-2 px-2 !text-[11px] text-slate-400 transition hover:text-amber-200"
              >
                {showPrs ? "▾" : "▸"} PRs of {selected === kpi.me ? "yours" : (selectedName ?? "—")}
              </button>
              {showPrs && <PrList kpi={kpi} author={selected} />}
            </div>
          )}
        </>
      )}

      <p className="mt-4 font-mono text-[11px] text-slate-500">
        Review time: business hours (Mon–Fri 09:00–18:00 Tbilisi, Georgian holidays off) from ready for review to the
        second approval, for PRs that became ready that month; a PR not approved twice yet counts until it was computed.
        Rework: merged PRs updated that month on which someone requested changes. Every repo in your workspaces.
      </p>
    </Card>
  );
}
