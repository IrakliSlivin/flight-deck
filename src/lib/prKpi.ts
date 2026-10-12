import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getDb } from "./db";

// Monthly PR KPIs from Bitbucket (pr_kpi.rs). Computed only when asked; each computed month
// is kept in SQLite (pr_kpi_months + pr_kpi_prs) and read back from there.

export interface ReadyPr {
  repo: string;
  id: number;
  title: string;
  author: string;
  author_uuid: string;
  url: string;
  ready_on: string;
  /** The second approval; null while it hasn't come (the review time then runs until computed). */
  approved_on: string | null;
  /** Business seconds: Mon–Fri 9–18 Tbilisi, Georgian holidays off. */
  review_seconds: number;
}

export interface MergedPr {
  repo: string;
  id: number;
  title: string;
  author: string;
  author_uuid: string;
  url: string;
  rework: boolean;
}

export interface PrKpi {
  /** YYYY-MM */
  month: string;
  /** Your Bitbucket uuid. */
  me: string;
  repos: number;
  ready: ReadyPr[];
  merged: MergedPr[];
}

export interface StoredKpi extends PrKpi {
  computed_at: string;
}

export interface AuthorKpi {
  uuid: string;
  name: string;
  /** PRs that became ready for review in the month. */
  ready: number;
  /** Of those, still short of two approvals when computed. */
  waiting: number;
  reviewSeconds: number;
  /** Over every ready PR, waiting ones included (as the Ruby service does). */
  avgSeconds: number;
  merged: number;
  rework: number;
}

/** Per author, most PRs first. */
export function byAuthor(kpi: PrKpi): AuthorKpi[] {
  const map = new Map<string, AuthorKpi>();
  const get = (uuid: string, name: string) => {
    const key = uuid || name;
    let a = map.get(key);
    if (!a) {
      a = { uuid, name, ready: 0, waiting: 0, reviewSeconds: 0, avgSeconds: 0, merged: 0, rework: 0 };
      map.set(key, a);
    }
    return a;
  };
  for (const pr of kpi.ready) {
    const a = get(pr.author_uuid, pr.author);
    a.ready += 1;
    a.reviewSeconds += pr.review_seconds;
    if (!pr.approved_on) a.waiting += 1;
  }
  for (const pr of kpi.merged) {
    const a = get(pr.author_uuid, pr.author);
    a.merged += 1;
    if (pr.rework) a.rework += 1;
  }
  const authors = [...map.values()];
  authors.forEach((a) => (a.avgSeconds = a.ready ? a.reviewSeconds / a.ready : 0));
  return authors.sort((a, b) => b.ready + b.merged - (a.ready + a.merged) || a.name.localeCompare(b.name));
}

/** "2026-09" for the month `offset` months from the current one. */
export function monthKey(offset = 0): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- SQLite ----------

interface MonthRow {
  month: string;
  me: string;
  repos: number;
  computed_at: string;
}

interface PrRow {
  month: string;
  kind: "ready" | "merged";
  repo: string;
  pr_id: number;
  title: string;
  author: string;
  author_uuid: string;
  url: string;
  ready_on: string | null;
  approved_on: string | null;
  review_seconds: number | null;
  rework: number | null;
}

/** Every stored month, newest first. */
export async function loadStoredKpis(): Promise<StoredKpi[]> {
  const db = await getDb();
  const months = await db.select<MonthRow[]>("SELECT * FROM pr_kpi_months ORDER BY month DESC");
  const rows = await db.select<PrRow[]>("SELECT * FROM pr_kpi_prs ORDER BY month, kind, repo, pr_id");
  return months.map((m) => {
    const prs = rows.filter((r) => r.month === m.month);
    const base = (r: PrRow) => ({
      repo: r.repo,
      id: r.pr_id,
      title: r.title,
      author: r.author,
      author_uuid: r.author_uuid,
      url: r.url,
    });
    return {
      ...m,
      ready: prs
        .filter((r) => r.kind === "ready")
        .map((r) => ({
          ...base(r),
          ready_on: r.ready_on ?? "",
          approved_on: r.approved_on,
          review_seconds: r.review_seconds ?? 0,
        })),
      merged: prs.filter((r) => r.kind === "merged").map((r) => ({ ...base(r), rework: !!r.rework })),
    };
  });
}

const COLUMNS = [
  "month",
  "kind",
  "repo",
  "pr_id",
  "title",
  "author",
  "author_uuid",
  "url",
  "ready_on",
  "approved_on",
  "review_seconds",
  "rework",
] as const;
/** Rows per INSERT, well under SQLite's bound-parameter limit. */
const CHUNK = 50;

/** Replaces the month: its PRs first, then the month row, so a month listed is complete. */
async function saveKpi(kpi: PrKpi, computedAt: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM pr_kpi_months WHERE month = $1", [kpi.month]);
  await db.execute("DELETE FROM pr_kpi_prs WHERE month = $1", [kpi.month]);
  const rows: unknown[][] = [
    ...kpi.ready.map((p) => [
      kpi.month, "ready", p.repo, p.id, p.title, p.author, p.author_uuid, p.url,
      p.ready_on, p.approved_on, p.review_seconds, null,
    ]),
    ...kpi.merged.map((p) => [
      kpi.month, "merged", p.repo, p.id, p.title, p.author, p.author_uuid, p.url,
      null, null, null, p.rework ? 1 : 0,
    ]),
  ];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((_, r) => `(${COLUMNS.map((_, c) => `$${r * COLUMNS.length + c + 1}`).join(", ")})`)
      .join(", ");
    await db.execute(`INSERT INTO pr_kpi_prs (${COLUMNS.join(", ")}) VALUES ${values}`, chunk.flat());
  }
  await db.execute("INSERT INTO pr_kpi_months (month, me, repos, computed_at) VALUES ($1, $2, $3, $4)", [
    kpi.month,
    kpi.me,
    kpi.repos,
    computedAt,
  ]);
}

// ---------- the running computation, kept across tab switches ----------

export interface KpiProgress {
  step: string;
  done: number;
  total: number;
}

export interface KpiRun {
  month: string;
  progress: KpiProgress | null;
  error: string | null;
  running: boolean;
}

let run: KpiRun | null = null;
/** Bumped after every save, so views reload what's stored. */
let savedVersion = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

listen<KpiProgress & { month: string }>("pr-kpi-progress", ({ payload }) => {
  if (!run?.running || run.month !== payload.month) return;
  run = { ...run, progress: { step: payload.step, done: payload.done, total: payload.total } };
  notify();
}).catch(() => {});

/** Computes `month` from Bitbucket and stores it. One run at a time. */
export async function computeKpi(month: string): Promise<void> {
  if (run?.running) return;
  run = { month, progress: null, error: null, running: true };
  notify();
  try {
    const kpi = await invoke<PrKpi>("compute_pr_kpi", { month });
    await saveKpi(kpi, new Date().toISOString());
    run = null;
    savedVersion += 1;
  } catch (e) {
    run = { month, progress: null, error: String(e), running: false };
  }
  notify();
}

export function useKpiRun(): KpiRun | null {
  return useSyncExternalStore(subscribe, () => run);
}

export function useKpiSavedVersion(): number {
  return useSyncExternalStore(subscribe, () => savedVersion);
}
