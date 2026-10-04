import { useEffect, useState } from "react";
import { TrashIcon } from "./Icons";
import { addTodo, deleteTodo, listTodos, toggleTodo, type Todo } from "../lib/db";

export function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setTodos(await listTodos());
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function handleAdd() {
    if (!text.trim()) return;
    await addTodo(text.trim());
    setText("");
    await refresh();
  }

  async function handleToggle(todo: Todo) {
    await toggleTodo(todo.id, !todo.done);
    await refresh();
  }

  async function handleDelete(id: number) {
    await deleteTodo(id);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          id="todo-input"
          placeholder="Add a note or todo…"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50 focus:shadow-[0_0_0_3px_rgba(251,191,36,.08)]"
        />
        <button
          onClick={handleAdd}
          className="label shrink-0 rounded-lg bg-slate-100 px-3 py-1.5 !text-[11px] text-slate-900 transition hover:bg-white"
        >
          Add
        </button>
      </div>
      <ul className="flex max-h-64 flex-col overflow-y-auto pr-1">
        {loading && <li className="blink font-mono text-xs text-slate-400">loading…</li>}
        {!loading && todos.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-slate-400">Nothing yet.</li>
        )}
        {todos.map((todo) => (
          <li key={todo.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
            <button
              onClick={() => handleToggle(todo)}
              aria-label={todo.done ? "Mark not done" : "Mark done"}
              className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border transition ${
                todo.done
                  ? "border-emerald-400 bg-emerald-400 text-slate-950"
                  : "border-slate-500 hover:border-amber-300"
              }`}
            >
              {!!todo.done && (
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M2.5 6.5l2.2 2L9.5 3.5" />
                </svg>
              )}
            </button>
            <span
              className={`flex-1 text-sm ${
                todo.done ? "text-slate-500 line-through" : "text-slate-200"
              }`}
            >
              {todo.text}
            </span>
            <button
              onClick={() => handleDelete(todo.id)}
              title="Delete note"
              aria-label="Delete note"
              className="shrink-0 rounded-md border border-white/10 p-1 text-slate-400 transition hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-rose-300"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
