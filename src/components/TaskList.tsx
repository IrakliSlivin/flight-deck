import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  fetchClickupListStatuses,
  updateClickupTaskStatus,
  type ClickupStatus,
  type ClickupTask,
} from "../lib/clickup";

// First match wins, so the specific statuses come first. Each entry is [pattern, pill, dot].
const STATUS_TONE: [RegExp, string, string][] = [
  [
    /ready/i,
    "text-emerald-300 border-emerald-300/30 bg-emerald-300/10",
    "bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,.6)]",
  ],
  [/hold/i, "text-sky-300 border-sky-300/30 bg-sky-300/10", "bg-sky-300 shadow-[0_0_6px_rgba(125,211,252,.6)]"],
  [/block/i, "text-rose-300 border-rose-300/30", "bg-rose-300 shadow-[0_0_6px_rgba(253,164,175,.6)]"],
  [/progress|doing|dev/i, "text-amber-300 border-amber-300/30", "bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,.6)]"],
  [/review|qa|test/i, "text-violet-300 border-violet-300/30", "bg-violet-300 shadow-[0_0_6px_rgba(196,181,253,.6)]"],
];

function statusTone(status: string): { pill: string; dot: string } {
  const match = STATUS_TONE.find(([re]) => re.test(status));
  return match ? { pill: match[1], dot: match[2] } : { pill: "text-slate-400 border-white/10", dot: "bg-slate-500" };
}

// Group order in the list: work in flight first, then waiting states, then everything else (to do, open…).
const GROUP_ORDER: RegExp[] = [/progress|doing|dev/i, /review|qa|test/i, /block/i, /hold/i, /ready/i];

function groupRank(status: string): number {
  const i = GROUP_ORDER.findIndex((re) => re.test(status));
  return i === -1 ? GROUP_ORDER.length : i;
}

/** Tasks grouped by status, ordered by `groupRank`; tasks keep their fetched order within a group. */
function groupByStatus(tasks: ClickupTask[], statusOf: (t: ClickupTask) => string) {
  const groups = new Map<string, { status: string; tasks: ClickupTask[] }>();
  for (const task of tasks) {
    const status = statusOf(task);
    const key = status.toLowerCase();
    const group = groups.get(key) ?? { status, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => groupRank(a.status) - groupRank(b.status));
}

type ListStatuses = ClickupStatus[] | "loading" | { error: string };

interface Menu {
  task: ClickupTask;
  /** The pill's rect; the menu opens below it, or above when there's no room. */
  anchor: DOMRect;
}

const EDGE = 8;

/** Status picker, positioned fixed so the scrolling task list doesn't clip it. */
function StatusMenu({
  menu,
  current,
  statuses,
  onPick,
  onClose,
}: {
  menu: Menu;
  current: string;
  statuses: ListStatuses | undefined;
  onPick: (status: ClickupStatus) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);

  // Measure after each render (the list grows once statuses load) and flip above the pill if needed.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const below = menu.anchor.bottom + 4;
    const fits = below + height <= window.innerHeight - EDGE;
    setTop(fits ? below : Math.max(EDGE, menu.anchor.top - 4 - height));
  }, [menu, statuses]);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Scrolling the page moves the pill away from the menu; scrolling the menu itself is fine.
    function onScroll(e: Event) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        top: top ?? menu.anchor.bottom + 4,
        right: window.innerWidth - menu.anchor.right,
        maxHeight: window.innerHeight - 2 * EDGE,
        visibility: top === null ? "hidden" : undefined,
      }}
      className="glass fixed z-50 min-w-44 overflow-y-auto rounded-lg p-1 shadow-xl shadow-black/40"
    >
      {statuses === undefined || statuses === "loading" ? (
        <p className="blink px-2 py-1.5 font-mono text-[11px] text-slate-400">loading statuses…</p>
      ) : "error" in statuses ? (
        <p className="max-w-64 px-2 py-1.5 text-xs text-rose-400">{statuses.error}</p>
      ) : (
        statuses.map((s) => {
          const active = s.status.toLowerCase() === current.toLowerCase();
          return (
            <button
              key={s.status}
              disabled={active}
              onClick={() => onPick(s)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-slate-300 transition-colors hover:bg-white/[0.06] disabled:cursor-default disabled:text-slate-500 disabled:hover:bg-transparent"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="flex-1">{s.status}</span>
              {active && <span className="text-slate-500">✓</span>}
            </button>
          );
        })
      )}
    </div>
  );
}

export function TaskList({
  tasks,
  error,
  loading,
  onChanged,
}: {
  tasks: ClickupTask[] | null;
  error: string | null;
  loading: boolean;
  /** Called after a status change is saved, so the parent can refetch. */
  onChanged?: () => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ListStatuses>>({});
  // Optimistic status per task id, and tasks moved to a done/closed status.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fresh data from ClickUp replaces the optimistic state.
  useEffect(() => {
    setOverrides({});
    setHidden(new Set());
  }, [tasks]);

  function openMenu(task: ClickupTask, button: HTMLElement) {
    setMenu({ task, anchor: button.getBoundingClientRect() });
    const cached = statuses[task.list_id];
    if (Array.isArray(cached) || cached === "loading") return;
    setStatuses((s) => ({ ...s, [task.list_id]: "loading" }));
    fetchClickupListStatuses(task.list_id)
      .then((list) => setStatuses((s) => ({ ...s, [task.list_id]: list })))
      .catch((e) => setStatuses((s) => ({ ...s, [task.list_id]: { error: String(e) } })));
  }

  async function pick(task: ClickupTask, status: ClickupStatus) {
    setMenu(null);
    setSaveError(null);
    const closes = status.type === "done" || status.type === "closed";
    setOverrides((o) => ({ ...o, [task.id]: status.status }));
    try {
      await updateClickupTaskStatus(task.id, task.list_id, status.status);
      if (closes) setHidden((h) => new Set(h).add(task.id));
      onChanged?.();
    } catch (e) {
      setOverrides(({ [task.id]: _, ...rest }) => rest);
      // The cached statuses were dropped in Rust; reload them on the next open.
      setStatuses(({ [task.list_id]: _, ...rest }) => rest);
      setSaveError(`Couldn't update "${task.name}": ${e}`);
    }
  }

  if (loading && !tasks) return <p className="blink font-mono text-xs text-slate-400">syncing ClickUp…</p>;
  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!tasks) return null;
  const visible = tasks.filter((t) => !hidden.has(t.id));
  if (visible.length === 0) return <p className="text-sm text-slate-400">No open tasks assigned to you.</p>;

  return (
    <>
      {saveError && <p className="mb-2 text-xs text-rose-400">{saveError}</p>}
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
        {groupByStatus(visible, (t) => overrides[t.id] ?? t.status).map((group) => (
          <section key={group.status.toLowerCase()}>
            <h4 className="flex items-center gap-2 px-2 pb-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
              <span className={`h-1 w-1 rounded-full ${statusTone(group.status).dot}`} />
              {group.status}
              <span className="text-slate-600">{group.tasks.length}</span>
            </h4>
            <ul className="flex flex-col">
              {group.tasks.map((task) => {
                const status = overrides[task.id] ?? task.status;
                const tone = statusTone(status);
                const pending = task.id in overrides;
                return (
                  <li
                    key={task.id}
                    className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full transition-transform group-hover:scale-150 ${tone.dot}`}
                    />
                    <button
                      onClick={() => openUrl(task.url)}
                      title={`${task.name} — ${task.list_name}`}
                      className="min-w-0 flex-1 truncate text-left text-sm text-slate-200"
                    >
                      {task.name}
                    </button>
                    <button
                      onClick={(e) => openMenu(task, e.currentTarget)}
                      title="Change status"
                      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider transition hover:brightness-125 ${tone.pill} ${pending ? "blink" : ""}`}
                    >
                      {status} <span className="opacity-60">▾</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {menu && (
        <StatusMenu
          menu={menu}
          current={overrides[menu.task.id] ?? menu.task.status}
          statuses={statuses[menu.task.list_id]}
          onPick={(s) => pick(menu.task, s)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
