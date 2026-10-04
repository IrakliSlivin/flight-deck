import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
  clearNotifications,
  dismissNotification,
  getNotificationFeed,
  onNotificationFeed,
  type FeedItem,
} from "../lib/notifications";
import { openOutlook } from "../lib/outlook";
import { BellIcon, CalendarIcon, CloseIcon, MailIcon } from "./Icons";

function ago(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const KIND = {
  email: { label: "Email", Icon: MailIcon, tone: "text-sky-300 bg-sky-400/10" },
  meeting: { label: "Meeting", Icon: CalendarIcon, tone: "text-amber-300 bg-amber-400/10" },
} as const;

/** Opens what the notification was about; returns false when there is nothing to open. */
function openItem(item: FeedItem): boolean {
  if (item.kind === "email") {
    openOutlook(item.target ?? undefined).catch(() => {});
    return true;
  }
  if (item.target) {
    openUrl(item.target).catch(() => {});
    return true;
  }
  return false;
}

/** TopBar bell: recent meeting reminders and new-mail notifications, each clearable on hover. */
export function NotificationBell() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getNotificationFeed().then(setItems).catch(() => {});
    const unlisten = onNotificationFeed(setItems);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = items.length;
  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${count ? ` (${count})` : ""}`}
        title="Notifications"
        className={`relative rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 transition hover:text-slate-200 ${
          open ? "text-slate-200" : "text-slate-400"
        }`}
      >
        <BellIcon className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full bg-amber-400 px-1 font-mono text-[10px] leading-[18px] font-bold text-slate-900">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="glass absolute top-full right-0 z-30 mt-2 w-[360px] overflow-hidden rounded-xl border border-white/[0.08] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
            <span className="label !text-[11px] text-slate-300">Notifications</span>
            {count > 0 && (
              <button
                onClick={() => clearNotifications().catch(() => {})}
                className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-400 transition hover:text-amber-300"
              >
                Clear all
              </button>
            )}
          </div>
          {count === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-slate-500">Nothing new.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto py-1 whitespace-normal">
              {items.map((item) => {
                const kind = KIND[item.kind];
                return (
                  <li key={item.id} className="group relative">
                    <button
                      onClick={() => {
                        if (openItem(item)) {
                          dismissNotification(item.id).catch(() => {});
                          setOpen(false);
                        }
                      }}
                      className="flex w-full gap-3 px-4 py-2.5 pr-10 text-left transition hover:bg-white/[0.04]"
                    >
                      <span className={`mt-0.5 shrink-0 rounded-md p-1.5 ${kind.tone}`}>
                        <kind.Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={`font-mono text-[9.5px] font-semibold uppercase tracking-[0.16em] ${kind.tone.split(" ")[0]}`}>
                            {kind.label}
                          </span>
                          <span className="truncate text-[13px] font-medium text-slate-100">{item.title}</span>
                          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-500">{ago(item.at, now)}</span>
                        </span>
                        {item.body && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-400">{item.body}</span>}
                      </span>
                    </button>
                    <button
                      onClick={() => dismissNotification(item.id).catch(() => {})}
                      aria-label="Dismiss"
                      title="Dismiss"
                      className="absolute top-2.5 right-3 rounded-md p-1 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-slate-200 focus-visible:opacity-100"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
