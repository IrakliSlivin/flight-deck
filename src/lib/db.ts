import Database from "@tauri-apps/plugin-sql";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:dashboard.db");
  }
  return dbPromise;
}

export interface Todo {
  id: number;
  text: string;
  done: number;
  created_at: string;
}

export async function listTodos(): Promise<Todo[]> {
  const db = await getDb();
  return db.select<Todo[]>("SELECT * FROM todos ORDER BY done ASC, id DESC");
}

export async function addTodo(text: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO todos (text) VALUES ($1)", [text]);
}

export async function toggleTodo(id: number, done: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE todos SET done = $1 WHERE id = $2", [done ? 1 : 0, id]);
}

export async function deleteTodo(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM todos WHERE id = $1", [id]);
}
