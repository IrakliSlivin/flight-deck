// Stands in for @tauri-apps/plugin-sql in demo mode: an in-memory `todos` table that
// understands exactly the queries in src/lib/db.ts.
import { todos as seed } from "./data";

interface Todo {
  id: number;
  text: string;
  done: number;
  created_at: string;
}

let nextId = seed.length + 1;
const rows: Todo[] = seed.map((t, i) => ({ id: seed.length - i, created_at: new Date().toISOString(), ...t }));

export default class Database {
  static async load(_path: string): Promise<Database> {
    return new Database();
  }

  async select<T>(_query: string): Promise<T> {
    return [...rows].sort((a, b) => a.done - b.done || b.id - a.id) as T;
  }

  async execute(query: string, params: unknown[] = []): Promise<void> {
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
