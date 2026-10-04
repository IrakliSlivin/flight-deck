import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card } from "../components/Card";
import { RefreshIcon } from "../components/Icons";
import { formatAge } from "../components/Headlines";
import { fetchAiNews, type NewsFeed, type NewsItem } from "../lib/news";

const REFRESH_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Accent per source (dot, badge). Unknown sources fall back to a hashed tone. */
const SOURCE_COLORS: Record<string, string> = {
  "Claude Code": "#fbbf24",
  "Hacker News": "#fb923c",
  OpenAI: "#34d399",
  "Google DeepMind": "#38bdf8",
  "Hugging Face": "#facc15",
  "Simon Willison": "#a78bfa",
  "TechCrunch AI": "#4ade80",
  "The Verge AI": "#f472b6",
};
const FALLBACK_COLORS = ["#a78bfa", "#38bdf8", "#34d399", "#f472b6", "#fbbf24", "#2dd4bf"];

function sourceColor(source: string): string {
  if (SOURCE_COLORS[source]) return SOURCE_COLORS[source];
  const hash = [...source].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function initials(source: string): string {
  return source
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function SourceBadge({ source }: { source: string }) {
  const color = sourceColor(source);
  return (
    <span
      title={source}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border font-mono text-[11px] font-semibold"
      style={{ color, borderColor: `${color}40`, background: `${color}14` }}
    >
      {initials(source)}
    </span>
  );
}

function NewsRow({ item, index }: { item: NewsItem; index: number }) {
  return (
    <li className="rise" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
      <button
        onClick={() => openUrl(item.url)}
        title={item.url}
        className="group flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-white/[0.07] hover:bg-white/[0.03]"
      >
        <SourceBadge source={item.source} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-slate-100 group-hover:text-white">
            {item.title}
          </p>
          {item.summary && (
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-slate-400">{item.summary}</p>
          )}
          <p className="mt-1 flex items-center gap-2 font-mono text-[11px] whitespace-nowrap text-slate-500">
            <span className="min-w-0 truncate" style={{ color: sourceColor(item.source) }}>
              {item.source}
            </span>
            {item.published && (
              <>
                <span className="text-slate-600">·</span>
                <span className="shrink-0">{formatAge(item.published)}</span>
              </>
            )}
          </p>
        </div>
        <span className="mt-1 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-amber-300">
          ↗
        </span>
      </button>
    </li>
  );
}

/** The most relevant story (the feed is relevance-sorted), shown large above the list. */
function LeadStory({ item }: { item: NewsItem }) {
  const color = sourceColor(item.source);
  return (
    <Card tone="glass" delay={120} className="relative isolate overflow-hidden !p-0">
      <div
        className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-2/3 opacity-60"
        style={{ background: `radial-gradient(600px circle at 0% 0%, ${color}22, transparent 60%)` }}
      />
      <button onClick={() => openUrl(item.url)} title={item.url} className="group block w-full p-6 text-left">
        <div className="flex items-center gap-2">
          <span className="status-dot" style={{ color }} />
          <span className="label !text-[11px]" style={{ color }}>
            Top story · {item.source}
          </span>
          {item.published && (
            <span className="font-mono text-[11px] text-slate-500">{formatAge(item.published)}</span>
          )}
        </div>
        <h3 className="mt-3 max-w-4xl text-xl leading-snug font-semibold text-slate-50 group-hover:text-white">
          {item.title}
        </h3>
        {item.summary && (
          <p className="mt-2 line-clamp-3 max-w-4xl text-sm leading-relaxed text-slate-400">{item.summary}</p>
        )}
        <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-400 transition group-hover:text-amber-300">
          Read story <span className="transition group-hover:translate-x-0.5">↗</span>
        </span>
      </button>
    </Card>
  );
}

interface DayGroup {
  key: string;
  label: string;
  items: NewsItem[];
}

function groupByDay(items: NewsItem[]): DayGroup[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const buckets: DayGroup[] = [
    { key: "today", label: "Today", items: [] },
    { key: "yesterday", label: "Yesterday", items: [] },
    { key: "week", label: "Earlier this week", items: [] },
    { key: "older", label: "Older", items: [] },
  ];
  for (const item of items) {
    const t = item.published ? new Date(item.published).getTime() : NaN;
    const idx = isNaN(t) ? 3 : t >= today ? 0 : t >= today - DAY_MS ? 1 : t >= today - 6 * DAY_MS ? 2 : 3;
    buckets[idx].items.push(item);
  }
  return buckets.filter((b) => b.items.length > 0);
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1 flex items-center gap-2 px-3">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
      <span className="label !text-[11px] text-slate-400">{label}</span>
      <span className="font-mono text-[11px] text-slate-500">{count}</span>
      <span className="ml-2 h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

function Chip({
  active,
  onClick,
  color,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  color?: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[11px] transition ${
        active
          ? "bg-slate-100 text-slate-900 shadow-[0_0_14px_rgba(226,232,240,.15)]"
          : "border border-white/[0.07] bg-white/[0.03] text-slate-400 hover:text-slate-100"
      }`}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
      <span className={active ? "text-slate-500" : "text-slate-600"}>{count}</span>
    </button>
  );
}

export function News() {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchAiNews());
      setFetchedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of feed?.items ?? []) counts.set(i.source, (counts.get(i.source) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [feed]);

  const q = query.trim().toLowerCase();
  const items =
    feed?.items.filter(
      (i) =>
        (!source || i.source === source) &&
        (!q || i.title.toLowerCase().includes(q) || (i.summary ?? "").toLowerCase().includes(q)),
    ) ?? [];
  const [lead, ...rest] = items;
  const groups = groupByDay(rest);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-2 pb-8">
      <div className="rise flex items-end justify-between">
        <div>
          <h2 className="label !text-[13px] text-slate-200">AI news</h2>
          <p className="mt-1 font-mono text-[11px] text-slate-500">
            {sources.length} sources · {feed?.items.length ?? 0} stories
            {fetchedAt &&
              ` · synced ${fetchedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="label flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-50"
        >
          <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Syncing" : "Refresh"}
        </button>
      </div>

      {error ? (
        <Card tone="glass" delay={80}>
          <p className="text-sm text-rose-400">{error}</p>
        </Card>
      ) : !feed ? (
        <p className="blink font-mono text-xs text-slate-400">tuning in…</p>
      ) : (
        <>
          <div className="rise flex flex-wrap items-center gap-2" style={{ animationDelay: "60ms" }}>
            <div className="relative mr-2">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500">
                ⌕
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search headlines…"
                className="w-64 rounded-full border border-white/10 bg-black/30 py-1.5 pr-3 pl-8 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50"
              />
            </div>
            <Chip active={source === null} onClick={() => setSource(null)} count={feed.items.length}>
              All
            </Chip>
            {sources.map(([s, n]) => (
              <Chip
                key={s}
                active={source === s}
                onClick={() => setSource(source === s ? null : s)}
                color={sourceColor(s)}
                count={n}
              >
                {s}
              </Chip>
            ))}
          </div>

          {feed.failed_sources.length > 0 && (
            <p className="font-mono text-[11px] text-amber-300/80">
              ⚠ couldn't reach {feed.failed_sources.join(", ")}
            </p>
          )}

          {!lead ? (
            <Card tone="glass" delay={120}>
              <p className="py-6 text-center text-sm text-slate-400">No stories match.</p>
            </Card>
          ) : (
            <>
              <LeadStory item={lead} />
              {groups.length > 0 && (
                <Card tone="glass" delay={180} className="flex flex-col gap-4">
                  {groups.map((g) => (
                    <div key={g.key}>
                      <GroupHeader label={g.label} count={g.items.length} />
                      <ul className="grid grid-cols-1 gap-x-4 xl:grid-cols-2">
                        {g.items.map((item, i) => (
                          <NewsRow key={item.url} item={item} index={i} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
