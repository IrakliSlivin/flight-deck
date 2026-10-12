// Stands in for @tauri-apps/plugin-sql in demo mode: in-memory tables that understand exactly
// the queries in src/lib/db.ts (todos) and src/lib/prKpi.ts (pr_kpi_*).
import { prKpi, todos as seed } from "./data";

interface Todo {
  id: number;
  text: string;
  done: number;
  created_at: string;
}

let nextId = seed.length + 1;
const rows: Todo[] = seed.map((t, i) => ({ id: seed.length - i, created_at: new Date().toISOString(), ...t }));

type Row = Record<string, unknown>;
const PR_COLUMNS = [
  "month", "kind", "repo", "pr_id", "title", "author", "author_uuid", "url",
  "ready_on", "approved_on", "review_seconds", "rework",
];
const kpiMonths: Row[] = [];
const kpiPrs: Row[] = [];

// Five past months already computed, so the history chart has something to show.
for (let offset = 1; offset <= 5; offset++) {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() - offset, 1);
  const k = prKpi(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  const [y, m] = k.month.split("-").map(Number);
  kpiMonths.push({ month: k.month, me: k.me, repos: k.repos, computed_at: new Date(y, m, 1, 9, 12).toISOString() });
  for (const p of k.ready) kpiPrs.push({ ...p, month: k.month, kind: "ready", pr_id: p.id, rework: null });
  for (const p of k.merged) kpiPrs.push({ ...p, month: k.month, kind: "merged", pr_id: p.id, rework: p.rework ? 1 : 0 });
}

export default class Database {
  static async load(_path: string): Promise<Database> {
    return new Database();
  }

  async select<T>(query: string): Promise<T> {
    if (query.includes("pr_kpi_months")) return [...kpiMonths].sort((a, b) => (b.month as string).localeCompare(a.month as string)) as T;
    if (query.includes("pr_kpi_prs")) return [...kpiPrs] as T;
    return [...rows].sort((a, b) => a.done - b.done || b.id - a.id) as T;
  }

  async execute(query: string, params: unknown[] = []): Promise<void> {
    const table = query.includes("pr_kpi_months") ? kpiMonths : query.includes("pr_kpi_prs") ? kpiPrs : null;
    if (table) {
      if (query.startsWith("DELETE")) {
        for (let i = table.length - 1; i >= 0; i--) if (table[i].month === params[0]) table.splice(i, 1);
      } else if (table === kpiMonths) {
        kpiMonths.push({ month: params[0], me: params[1], repos: params[2], computed_at: params[3] });
      } else {
        for (let i = 0; i < params.length; i += PR_COLUMNS.length) {
          kpiPrs.push(Object.fromEntries(PR_COLUMNS.map((c, j) => [c, params[i + j]])));
        }
      }
      return;
    }
    if (query.startsWith("INSERT")) {
      rows.push({ id: nextId++, text: params[0] as string, done: 0, created_at: new Date().toISOString() });
    } else if (query.startsWith("UPDATE")) {
      const row = rows.find((r) => r.id === params[1]);
      if (row) row.done = params[0] as number;
    } else if (query.startsWith("DELETE")) {
      const i = rows.findIndex((r) => r.id === params[0]);
      if (i >= 0) rows.splice(i, 1);
    }
  }
}
