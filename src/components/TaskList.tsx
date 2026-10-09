import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  fetchClickupListStatuses,
  updateClickupTaskStatus,
  type ClickupStatus,
  type ClickupTask,
} from "../lib/clickup";

// Pill and dot classes per color, written out in full so Tailwind sees them.
const TONES = {
  slate: {
    pill: "text-slate-300 border-slate-300/30 bg-slate-300/10",
    dot: "bg-slate-300 shadow-[0_0_6px_rgba(203,213,225,.5)]",
  },
  pink: {
    pill: "text-pink-300 border-pink-300/30 bg-pink-300/10",
    dot: "bg-pink-300 shadow-[0_0_6px_rgba(249,168,212,.6)]",
  },
  fuchsia: {
    pill: "text-fuchsia-300 border-fuchsia-300/30 bg-fuchsia-300/10",
    dot: "bg-fuchsia-300 shadow-[0_0_6px_rgba(240,171,252,.6)]",
  },
  orange: {
    pill: "text-orange-300 border-orange-300/30 bg-orange-300/10",
    dot: "bg-orange-300 shadow-[0_0_6px_rgba(253,186,116,.6)]",
  },
  yellow: {
    pill: "text-yellow-300 border-yellow-300/30 bg-yellow-300/10",
    dot: "bg-yellow-300 shadow-[0_0_6px_rgba(253,224,71,.6)]",
  },
  amber: {
    pill: "text-amber-300 border-amber-300/30 bg-amber-300/10",
    dot: "bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,.6)]",
  },
  indigo: {
    pill: "text-indigo-300 border-indigo-300/30 bg-indigo-300/10",
    dot: "bg-indigo-300 shadow-[0_0_6px_rgba(165,180,252,.6)]",
  },
  blue: {
    pill: "text-blue-300 border-blue-300/30 bg-blue-300/10",
    dot: "bg-blue-300 shadow-[0_0_6px_rgba(147,197,253,.6)]",
  },
  sky: {
    pill: "text-sky-300 border-sky-300/30 bg-sky-300/10",
    dot: "bg-sky-300 shadow-[0_0_6px_rgba(125,211,252,.6)]",
  },
  violet: {
    pill: "text-violet-300 border-violet-300/30 bg-violet-300/10",
    dot: "bg-violet-300 shadow-[0_0_6px_rgba(196,181,253,.6)]",
  },
  emerald: {
    pill: "text-emerald-300 border-emerald-300/30 bg-emerald-300/10",
    dot: "bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,.6)]",
  },
  green: {
    pill: "text-green-300 border-green-300/30 bg-green-300/10",
    dot: "bg-green-300 shadow-[0_0_6px_rgba(134,239,172,.6)]",
  },
  rose: {
    pill: "text-rose-300 border-rose-300/30 bg-rose-300/10",
    dot: "bg-rose-300 shadow-[0_0_6px_rgba(253,164,175,.6)]",
  },
};
type ToneName = keyof typeof TONES;

// Every status in the ClickUp workspace, fetched once (2026-10-09) and colored by stage. ClickUp's
// own colors differ between lists, so these are fixed here instead.
const STATUS_COLORS: Record<string, ToneName> = {
  // not started
  "to do": "slate",
  "not started": "slate",
  future: "slate",
  requested: "slate",
  "for triage": "slate",
  // triage and grooming
  triaged: "pink",
  "to be confirmed": "pink",
  confirmed: "pink",
  "for grooming": "pink",
  analysing: "fuchsia",
  "sd to be confirmed": "fuchsia",
  "for sizing": "orange",
  "for development": "orange",
  returned: "orange",
  "for planning": "yellow",
  // in flight
  "in progress": "amber",
  created: "amber",
  investigating: "indigo",
  "for investigation": "indigo",
  "pull request": "blue",
  "on hold": "sky",
  review: "violet",
  testing: "violet",
  ready: "emerald",
  // done
  accepted: "green",
  appproved: "green", // spelled this way in ClickUp
  classified: "green",
  resolved: "green",
  complete: "green",
  closed: "green",
  released: "green",
  // stopped
  stuck: "rose",
  declined: "rose",
  rejected: "rose",
};

// For statuses added later: first match wins.
const STATUS_PATTERNS: [RegExp, ToneName][] = [
  [/ready/i, "emerald"],
  [/hold/i, "sky"],
  [/block|stuck/i, "rose"],
  [/progress|doing|dev/i, "amber"],
  [/review|qa|test/i, "violet"],
];

function statusTone(status: string): { pill: string; dot: string } {
  const name = STATUS_COLORS[status.trim().toLowerCase()] ?? STATUS_PATTERNS.find(([re]) => re.test(status))?.[1];
  return name ? TONES[name] : { pill: "text-slate-400 border-white/10", dot: "bg-slate-500" };
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
