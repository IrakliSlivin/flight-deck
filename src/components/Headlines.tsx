import { openUrl } from "@tauri-apps/plugin-opener";
import type { NewsFeed } from "../lib/news";

export function formatAge(iso: string | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `${Math.max(min, 0)}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Headlines({
  feed,
  error,
  limit = 6,
}: {
  feed: NewsFeed | null;
  error: string | null;
  limit?: number;
}) {
  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!feed) return <p className="blink font-mono text-xs text-slate-400">tuning in…</p>;

  return (
    <ul className="flex flex-col gap-3">
      {feed.items.slice(0, limit).map((item, i) => (
        <li
          key={item.url}
          className="rise group flex gap-3"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-500 transition group-hover:bg-amber-300 group-hover:shadow-[0_0_6px_rgba(251,191,36,.8)]" />
          <div className="min-w-0">
            <button
              onClick={() => openUrl(item.url)}
              className="text-left font-mono text-[14px] text-slate-200 transition hover:text-amber-200"
            >
              <span className="text-slate-400">{item.source} /</span> {item.title}
            </button>
            {item.summary && (
              <p className="mt-0.5 line-clamp-1 font-mono text-[12px] text-slate-500">
                {item.summary}
                {item.published && <span className="text-slate-400"> · {formatAge(item.published)}</span>}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
