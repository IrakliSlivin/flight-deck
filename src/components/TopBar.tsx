import { useEffect, useState } from "react";
import { TABS, TabId } from "../tabs";
import { hasCredential } from "../lib/credentials";
import { REQUIRED_KEY } from "./SettingsDrawer";
import { GearIcon } from "./Icons";
import { NotificationBell } from "./NotificationBell";

function useLinkedCount(recheck: unknown): [number, number] {
  const keys = Object.values(REQUIRED_KEY);
  const [linked, setLinked] = useState(0);
  useEffect(() => {
    Promise.all(keys.map((k) => hasCredential(k).catch(() => false))).then((r) =>
      setLinked(r.filter(Boolean).length),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck]);
  return [linked, keys.length];
}

export function TopBar({
  active,
  onSelect,
  onOpenSettings,
  onOpenPalette,
  settingsOpen,
}: {
  active: TabId;
  onSelect: (id: TabId) => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  settingsOpen: boolean;
}) {
  const [now, setNow] = useState(new Date());
  const [linked, total] = useLinkedCount(settingsOpen);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);

  const allLinked = linked === total;

  return (
    // z-20: above <main> (z-10) so dropdowns like the bell menu stay clickable.
    <header className="relative z-20 mx-auto flex w-full max-w-[1600px] items-center justify-between gap-4 px-4 pt-4 pb-3 whitespace-nowrap">
      <div className="flex shrink-0 items-center gap-3">
        <img src="/logo.svg" alt="" className="h-8 w-8 drop-shadow-[0_0_10px_rgba(251,191,36,.35)]" />
        <span className="font-mono text-[15px] font-bold tracking-[0.32em] text-slate-100">
          FLIGHT DECK
        </span>
        <button
          onClick={onOpenSettings}
          title="Integrations"
          className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-700 shadow-[0_0_16px_rgba(226,232,240,.15)] transition hover:bg-white"
        >
          <span className={allLinked ? "text-emerald-500" : "text-amber-500"}>
            <span className="status-dot !h-[6px] !w-[6px]" />
          </span>
          {linked}/{total} linked
        </button>
      </div>

      <nav className="flex shrink-0 items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.03] p-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={`label rounded-lg px-3.5 py-1.5 !text-[11px] transition-all duration-300 ${
              active === tab.id
                ? "bg-slate-100 text-slate-900 shadow-[0_0_18px_rgba(226,232,240,.18)]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        <div className="mr-2 flex flex-col items-end leading-tight">
          <span className="font-mono text-sm tabular-nums text-slate-200">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <span className="blink text-slate-400">:</span>
            <span className="text-slate-400">{String(now.getSeconds()).padStart(2, "0")}</span>
          </span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-slate-500">
            {now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
          </span>
        </div>
        <button
          onClick={onOpenPalette}
          className="label rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 !text-[11px] text-slate-400 transition hover:text-slate-200"
        >
          Ctrl K
        </button>
        <NotificationBell />
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
          className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-slate-400 transition duration-500 hover:rotate-90 hover:text-slate-200"
        >
          <GearIcon className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
