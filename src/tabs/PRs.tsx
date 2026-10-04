import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card, GhostButton, SectionHeader } from "../components/Card";
import { StatTile, type TileState } from "../components/StatTile";
import { BitbucketIcon, GitlabIcon, PrIcon, TasksIcon, RefreshIcon } from "../components/Icons";
import { PROVIDER_NAME, loadPrs, type PrProvider, type PullRequest, type PullRequests } from "../lib/prs";

/** Approvals needed before a PR can merge. */
const REQUIRED_APPROVALS = 2;
const STALE_DAYS = 3;
const OLD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type Status = "draft" | "approved" | "waiting";

function ageDays(pr: PullRequest): number {
  return (Date.now() - new Date(pr.updated_on).getTime()) / DAY_MS;
}

function statusOf(pr: PullRequest): Status {
  if (pr.draft) return "draft";
  if (pr.approved_count >= REQUIRED_APPROVALS) return "approved";
  return "waiting";
}

const STATUS_META: Record<Status, { label: string; ring: string }> = {
  approved: {
    label: "Ready to merge",
    ring: "#34d399",
  },
  waiting: {
    label: "In review",
    ring: "#38bdf8",
  },
  draft: {
    label: "Draft",
    ring: "#64748b",
  },
};

function formatAge(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `${Math.max(min, 0)}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ageTone(pr: PullRequest): string {
  const d = ageDays(pr);
  if (d >= OLD_DAYS) return "text-rose-300";
  if (d >= STALE_DAYS) return "text-amber-300";
  return "text-slate-400";
}

const AVATAR_TONES = [
  "bg-violet-500/20 text-violet-200",
  "bg-sky-500/20 text-sky-200",
  "bg-emerald-500/20 text-emerald-200",
  "bg-rose-500/20 text-rose-200",
  "bg-amber-500/20 text-amber-200",
  "bg-teal-500/20 text-teal-200",
];

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span
      title={name}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-[11px] font-semibold ${
        AVATAR_TONES[hash % AVATAR_TONES.length]
      }`}
    >
      {initials || "?"}
    </span>
  );
}

/** Circular approvals meter: filled arc = approvals / required. */
function ApprovalRing({ pr }: { pr: PullRequest }) {
  const status = statusOf(pr);
  const r = 15;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, pr.approved_count / REQUIRED_APPROVALS);
  return (
    <div
      className="relative grid h-10 w-10 shrink-0 place-items-center"
      title={`${pr.approved_count} approval${pr.approved_count === 1 ? "" : "s"} of ${REQUIRED_APPROVALS} needed · ${pr.reviewers_total} reviewers`}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(148,163,184,.15)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={STATUS_META[status].ring}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-200">
        {pr.approved_count}/{REQUIRED_APPROVALS}
      </span>
    </div>
  );
}

function ProviderIcon({ provider }: { provider: PrProvider }) {
  const Icon = provider === "gitlab" ? GitlabIcon : BitbucketIcon;
  return (
    <span title={PROVIDER_NAME[provider]} className="flex shrink-0">
      <Icon className={`h-3.5 w-3.5 ${provider === "gitlab" ? "text-[#fc6d26]" : "text-[#2684ff]"}`} />
    </span>
  );
}

function PrRow({ pr, index }: { pr: PullRequest; index: number }) {
  return (
    <li className="rise" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
      <button
        onClick={() => openUrl(pr.url)}
        title={pr.url}
        className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-white/[0.07] hover:bg-white/[0.03]"
      >
        <ApprovalRing pr={pr} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-slate-100 group-hover:text-white">
            {pr.title}
          </p>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] whitespace-nowrap text-slate-400">
            <ProviderIcon provider={pr.provider} />
            <span className="min-w-0 truncate text-slate-300">{pr.source_repo.split("/").pop()}</span>
            <span className="text-slate-600">·</span>
            <span className="shrink-0">
              {pr.provider === "gitlab" ? "!" : "#"}
              {pr.id}
            </span>
            <span className="text-slate-600">·</span>
            <span className={`shrink-0 ${ageTone(pr)}`}>{formatAge(pr.updated_on)} ago</span>
          </p>
        </div>
        <Avatar name={pr.author} />
        <span className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-amber-300">
          ↗
        </span>
      </button>
    </li>
  );
}

interface PrGroup {
  key: string;
  label: string;
  color: string;
  prs: PullRequest[];
  /** Muted group that starts collapsed (nothing for you to do). */
  quiet?: boolean;
}

function GroupHeader({ group, open, onToggle }: { group: PrGroup; open: boolean; onToggle?: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={!onToggle}
      className="mb-1 flex w-full items-center gap-2 px-3 text-left disabled:cursor-default"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: group.color }} />
      <span className="label !text-[11px] text-slate-400">{group.label}</span>
      <span className="font-mono text-[11px] text-slate-500">{group.prs.length}</span>
      <span className="ml-2 h-px flex-1 bg-white/[0.06]" />
      {onToggle && (
        <span className={`text-[10px] text-slate-500 transition ${open ? "rotate-90" : ""}`}>▶</span>
      )}
    </button>
  );
}

function PrColumn({
  title,
  groups,
  empty,
  delay,
}: {
  title: string;
  groups: PrGroup[];
  empty: string;
  delay: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const shown = groups.filter((g) => g.prs.length > 0);
  const actionable = groups.filter((g) => !g.quiet).reduce((n, g) => n + g.prs.length, 0);

  return (
    <Card tone="glass" delay={delay} className="relative isolate flex min-w-0 flex-col overflow-hidden">
      <SectionHeader
        title={
          <>
            {title} <span className="text-slate-500">· {actionable}</span>
          </>
        }
      />
      {actionable === 0 && (
        <div className="grid place-items-center py-8 text-center">
          <div>
            <p className="text-2xl text-emerald-400">✓</p>
            <p className="mt-1 text-sm text-slate-300">{empty}</p>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-4">
        {shown.map((group) => {
          const open = !group.quiet || !!expanded[group.key];
          return (
            <div key={group.key} className={group.quiet ? "opacity-70" : ""}>
              <GroupHeader
                group={group}
                open={open}
                onToggle={
                  group.quiet
                    ? () => setExpanded((e) => ({ ...e, [group.key]: !e[group.key] }))
                    : undefined
                }
              />
              {open && (
                <ul className="flex flex-col">
                  {group.prs.map((pr, i) => (
                    <PrRow key={`${pr.provider}:${pr.source_repo}#${pr.id}`} pr={pr} index={i} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 font-mono text-[11px] transition ${
        active
          ? "bg-slate-100 text-slate-900 shadow-[0_0_14px_rgba(226,232,240,.15)]"
          : "border border-white/[0.07] bg-white/[0.03] text-slate-400 hover:text-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

const byOldest = (a: PullRequest, b: PullRequest) =>
  new Date(a.updated_on).getTime() - new Date(b.updated_on).getTime();
const byNewest = (a: PullRequest, b: PullRequest) => byOldest(b, a);

export function PRs() {
  const [data, setData] = useState<PullRequests | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [hideDrafts, setHideDrafts] = useState(false);

  async function refresh(force = true) {
    setLoading(true);
    setError(null);
    try {
      const result = await loadPrs(force);
      setData(result.data);
      setFetchedAt(result.fetchedAt);
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(false);
  }, []);

  const repos = useMemo(() => {
    const all = [...(data?.reviewing ?? []), ...(data?.authored ?? [])].map((pr) =>
      pr.source_repo.split("/").pop()!,
    );
    return Array.from(new Set(all)).sort();
  }, [data]);

  function visible(prs: PullRequest[]): PullRequest[] {
    const q = query.trim().toLowerCase();
    return prs.filter(
      (pr) =>
        (!repo || pr.source_repo.split("/").pop() === repo) &&
        (!hideDrafts || !pr.draft) &&
        (!q ||
          pr.title.toLowerCase().includes(q) ||
          pr.author.toLowerCase().includes(q) ||
          String(pr.id).includes(q)),
    );
  }

  const reviewing = data ? visible(data.reviewing).sort(byOldest) : [];
  const authored = data ? visible(data.authored).sort(byNewest) : [];

  const state: TileState = error ? "error" : loading ? "loading" : "ok";
  const needsYou = data?.reviewing.filter((pr) => !pr.draft && pr.approved_count < REQUIRED_APPROVALS);
  const ready = data?.authored.filter((pr) => statusOf(pr) === "approved");
  const oldestWaiting = needsYou?.slice().sort(byOldest)[0];

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-2 pb-8">
      <div className="rise flex items-end justify-between">
        <div>
          <h2 className="label !text-[13px] text-slate-200">Pull requests</h2>
          <p className="mt-1 font-mono text-[11px] text-slate-500">
            {data ? data.providers.map((p) => PROVIDER_NAME[p]).join(" + ") : "Bitbucket + GitLab"}
            {fetchedAt &&
              ` · synced ${fetchedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={loading}
          className="label flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 !text-[11px] text-slate-300 transition hover:text-white disabled:opacity-50"
        >
          <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Syncing" : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatTile
          label="Needs your review"
          value={needsYou?.length ?? null}
          state={state}
          sub={oldestWaiting ? `oldest waiting ${formatAge(oldestWaiting.updated_on)}` : "queue clear"}
          icon={PrIcon}
          iconClass="text-sky-400"
          delay={40}
        />
        <StatTile
          label="Your open PRs"
          value={data?.authored.length ?? null}
          state={state}
          sub={`${data?.authored.filter((p) => p.draft).length ?? 0} drafts`}
          icon={TasksIcon}
          iconClass="text-violet-400"
          delay={90}
        />
        <StatTile
          label="Ready to merge"
          value={ready?.length ?? null}
          state={state}
          sub={`${REQUIRED_APPROVALS}+ approvals`}
          icon={PrIcon}
          iconClass="text-emerald-500"
          delay={140}
        />

      </div>

      {data?.errors.map((e) => (
        <Card key={e.provider} tone="glass" delay={200}>
          <p className="text-sm text-rose-400">
            {PROVIDER_NAME[e.provider]} failed: {e.error}
          </p>
        </Card>
      ))}

      {error ? (
        <Card tone="glass" delay={220}>
          <p className="whitespace-pre-line text-sm text-rose-400">{error}</p>
          <p className="mt-1 text-xs text-slate-400">Check the Bitbucket / GitLab credentials in Settings.</p>
        </Card>
      ) : (
        <>
          <div
            className="rise flex flex-wrap items-center gap-2"
            style={{ animationDelay: "220ms" }}
          >
            <div className="relative mr-2">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500">
                ⌕
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, author, #id…"
                className="w-64 rounded-full border border-white/10 bg-black/30 py-1.5 pr-3 pl-8 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/50"
              />
            </div>
            <Chip active={repo === null} onClick={() => setRepo(null)}>
              All repos
            </Chip>
            {repos.map((r) => (
              <Chip key={r} active={repo === r} onClick={() => setRepo(repo === r ? null : r)}>
                {r}
              </Chip>
            ))}
            <span className="ml-auto" />
            <GhostButton onClick={() => setHideDrafts((v) => !v)}>
              {hideDrafts ? "Show drafts" : "Hide drafts"}
            </GhostButton>
          </div>

          {loading && !data ? (
            <p className="blink font-mono text-xs text-slate-400">syncing pull requests…</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <PrColumn
                title="Needs your review"
                groups={[
                  {
                    key: "needed",
                    label: "Your review needed",
                    color: STATUS_META.waiting.ring,
                    prs: reviewing.filter((pr) => statusOf(pr) === "waiting"),
                  },
                  {
                    key: "covered",
                    label: `No action needed · has ${REQUIRED_APPROVALS} approvals`,
                    color: STATUS_META.approved.ring,
                    prs: reviewing.filter((pr) => statusOf(pr) === "approved"),
                    quiet: true,
                  },
                ]}
                empty="Nothing waiting on you."
                delay={260}
              />
              <PrColumn
                title="Your PRs"
                groups={[
                  {
                    key: "ready",
                    label: "Ready to merge",
                    color: STATUS_META.approved.ring,
                    prs: authored.filter((pr) => statusOf(pr) === "approved"),
                  },
                  {
                    key: "waiting",
                    label: "Waiting for approvals",
                    color: STATUS_META.waiting.ring,
                    prs: authored.filter((pr) => statusOf(pr) === "waiting"),
                  },
                  {
                    key: "draft",
                    label: "Draft",
                    color: STATUS_META.draft.ring,
                    prs: authored.filter((pr) => statusOf(pr) === "draft"),
                  },
                ]}
                empty="No open PRs."
                delay={320}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
