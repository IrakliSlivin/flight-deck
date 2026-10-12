// Made-up data for demo mode (VITE_DEMO=1). Times are relative to page load so the
// countdowns and "x ago" labels always look plausible.
import type { ClickupStatus, ClickupTask } from "../lib/clickup";
import type { BitbucketPr, BitbucketPrs } from "../lib/bitbucket";
import type { Meeting } from "../lib/calendar";
import type { NewsFeed } from "../lib/news";
import type { FeedItem } from "../lib/notifications";
import type { MailBrief, OutlookInbox } from "../lib/outlook";
import type { ReminderSettings } from "../lib/reminders";
import type { RateLimitSnapshot } from "../lib/usage";
import type { DayStat, GitStats, GitStatsSettings, RepoCandidate, Side, SideStat, WeekStat } from "../lib/gitStats";

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const sec = (offsetMs: number) => Math.round((now + offsetMs) / 1000);

export const credentials: Record<string, string> = {
  "clickup.api_token": "demo",
  "bitbucket.api_token": "demo",
  "bitbucket.email": "ada@example.com",
  "bitbucket.workspace": "acme",
  "gitlab.api_token": "demo",
  "outlook.calendar_ics_url": "demo",
};

export const clickupSetup = {
  user: "ada",
  locations: [
    { value: "space:9001", name: "Engineering", kind: "space", path: [] },
    { value: "folder:9101", name: "Sprints", kind: "folder", path: ["Engineering"] },
    { value: "list:9201", name: "Sprint 42", kind: "list", path: ["Engineering", "Sprints"] },
    { value: "list:9202", name: "Sprint 43", kind: "list", path: ["Engineering", "Sprints"] },
    { value: "list:9203", name: "Bugs", kind: "list", path: ["Engineering"] },
    { value: "space:9002", name: "Product", kind: "space", path: [] },
    { value: "list:9204", name: "Roadmap", kind: "list", path: ["Product"] },
  ],
};

export const bitbucketRepos: Record<string, string[]> = {
  acme: ["api-gateway", "billing", "design-system", "infra", "mobile-app", "web-app"],
  "acme-labs": ["experiments", "ml-pipeline"],
};

export const rateLimits: RateLimitSnapshot = {
  rate_limits: {
    five_hour: { used_percentage: 38, resets_at: sec(2 * HOUR + 14 * MIN) },
    seven_day: { used_percentage: 61, resets_at: sec(3 * 24 * HOUR + 5 * HOUR) },
  },
  updated_at: sec(-4 * MIN),
};

const task = (id: string, name: string, status: string, list = "Sprint 42"): ClickupTask => ({
  id,
  name,
  status,
  due_date: null,
  url: `https://example.com/task/${id}`,
  list_id: "list-1",
  list_name: list,
});

export const tasks: ClickupTask[] = [
  task("t1", "Add CSV export to the invoices page", "in progress"),
  task("t2", "Rate-limit the public search endpoint", "in progress"),
  task("t3", "Fix timezone drift in recurring reminders", "code review"),
  task("t4", "Migrate session store to Redis", "blocked"),
  task("t5", "Dark mode for the settings screen", "ready"),
  task("t6", "Write onboarding docs for the billing service", "to do", "Backlog"),
];

export const statuses: ClickupStatus[] = [
  { status: "to do", color: "#87909e", type: "open", orderindex: 0 },
  { status: "ready", color: "#4194f6", type: "custom", orderindex: 1 },
  { status: "in progress", color: "#f9d900", type: "custom", orderindex: 2 },
  { status: "code review", color: "#a875ff", type: "custom", orderindex: 3 },
  { status: "blocked", color: "#e50000", type: "custom", orderindex: 4 },
  { status: "done", color: "#6bc950", type: "done", orderindex: 5 },
];

const pr = (
  id: number,
  title: string,
  author: string,
  repo: string,
  ageMs: number,
  approved = 0,
  reviewers = 2,
  draft = false,
): BitbucketPr => ({
  id,
  title,
  author,
  source_repo: repo,
  url: `https://example.com/${repo}/pr/${id}`,
  updated_on: iso(-ageMs),
  draft,
  approved_count: approved,
  reviewers_total: reviewers,
});

export const bitbucketPrs: BitbucketPrs = {
  authored: [
    pr(412, "Invoices: CSV export with column picker", "Ada Lovelace", "billing-api", 3 * HOUR, 1),
    pr(409, "Search: per-IP rate limiting", "Ada Lovelace", "gateway", 26 * HOUR, 0, 2, true),
  ],
  reviewing: [
    pr(415, "Upgrade to Rails 8 and drop the Sprockets pipeline", "Grace Hopper", "billing-api", 5 * HOUR),
    pr(88, "Retry webhook deliveries with exponential backoff", "Linus Park", "notifier", 2 * 24 * HOUR, 1, 3),
    pr(203, "Cache plan lookups for the pricing page", "Mei Tanaka", "web", 6 * 24 * HOUR),
  ],
};

export const gitlabPrs: BitbucketPrs = {
  authored: [pr(57, "CI: run the e2e suite in parallel shards", "Ada Lovelace", "infra/pipelines", 8 * HOUR, 2, 2)],
  reviewing: [pr(61, "Terraform: move staging to the new VPC", "Sam Okafor", "infra/terraform", 20 * HOUR)],
};

const meeting = (title: string, startMs: number, mins: number, join = true): Meeting => ({
  title,
  start: iso(startMs),
  end: iso(startMs + mins * MIN),
  all_day: false,
  location: join ? "Microsoft Teams Meeting" : "Room 4B",
  join_url: join ? `https://example.com/meet/${encodeURIComponent(title)}/${startMs}` : null,
  busy_status: "BUSY",
});

// Anchored to today so they land on the right day in the schedule.
const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - now;
const at = (h: number, m = 0) => midnight + h * HOUR + m * MIN;

export const meetings: Meeting[] = [
  meeting("Daily stand-up", at(9, 30), 15),
  meeting("Billing service design review", at(11), 45, false),
  meeting("1:1 with Grace", 25 * MIN, 30),
  meeting("Sprint planning", at(15), 60),
  meeting("Release go/no-go", at(16, 30), 30),
  meeting("Daily stand-up", at(24 + 9, 30), 15),
  meeting("Customer call: Northwind", at(24 + 13), 45),
].sort((a, b) => a.start.localeCompare(b.start));

const news = (title: string, source: string, ageMs: number, summary: string) => ({
  title,
  url: `https://example.com/news/${encodeURIComponent(title)}`,
  source,
  published: iso(-ageMs),
  summary,
});

export const newsFeed: NewsFeed = {
  items: [
    news("Smaller models, longer context: what changed this quarter", "The Model Report", 2 * HOUR, "A look at how context windows and distillation moved in the last three months."),
    news("Agents that write their own tests", "Dev Weekly", 5 * HOUR, "Teams report fewer regressions when coding agents are asked to write tests first."),
    news("A practical guide to evaluating RAG pipelines", "ML Notes", 9 * HOUR, "Retrieval quality, answer faithfulness and the metrics that actually matter."),
    news("Open-weight model tops the coding leaderboard", "AI Digest", 14 * HOUR, "The new release closes the gap with hosted models on several benchmarks."),
    news("Prompt caching cuts inference costs in half", "Infra Today", 20 * HOUR, "How caching shared prefixes changes the economics of long system prompts."),
    news("Why tool use is the new API design problem", "The Model Report", 30 * HOUR, "Designing tools for models looks a lot like designing APIs for people."),
    news("Speech models get real-time translation", "AI Digest", 40 * HOUR, "Latency is finally low enough for live conversations."),
  ],
  failed_sources: [],
};

export const inbox: OutlookInbox = {
  signed_in: true,
  unread_count: 4,
  updated_at: now,
  messages: [
    { id: "m1", unread: true, sender: "Grace Hopper", subject: "Rails 8 upgrade: can you review today?", time: "9:12", preview: "" },
    { id: "m2", unread: true, sender: "Finance Ops", subject: "Invoice export format for Q4", time: "8:47", preview: "" },
    { id: "m3", unread: true, sender: "Status Page", subject: "Resolved: elevated API latency", time: "8:05", preview: "" },
    { id: "m4", unread: true, sender: "Linus Park", subject: "Webhook retries PR", time: "Yesterday", preview: "" },
  ],
};

export const mailBrief: MailBrief = {
  headline: "Two people are waiting on you: a code review from Grace and an export format question from Finance.",
  items: [
    { id: "m1", sender: "Grace Hopper", point: "Asks for a review of the Rails 8 upgrade PR before today's release check.", needs_reply: true },
    { id: "m2", sender: "Finance Ops", point: "Wants the Q4 invoice export as CSV with tax broken out per line.", needs_reply: true },
    { id: "m4", sender: "Linus Park", point: "Pushed the backoff changes you asked for on the webhook PR.", needs_reply: false },
    { id: "m3", sender: "Status Page", point: "Yesterday's API latency incident is resolved.", needs_reply: false },
  ],
};

export const notificationFeed: FeedItem[] = [
  { id: 3, kind: "meeting", title: "1:1 with Grace", body: "Starts in 5 min", at: now - 2 * MIN, target: "https://example.com/meet/1-1" },
  { id: 2, kind: "email", title: "Grace Hopper", body: "Rails 8 upgrade: can you review today?", at: now - 18 * MIN, target: "m1" },
  { id: 1, kind: "email", title: "Finance Ops", body: "Invoice export format for Q4", at: now - 45 * MIN, target: "m2" },
];

export const reminderSettings: ReminderSettings = {
  sound: true,
  sound_name: "bell",
  mail_sound: true,
  mail_sound_name: "chime",
  lead_minutes: 5,
};

export const todos = [
  { text: "Reply to Finance about the export format", done: 0 },
  { text: "Review Grace's Rails 8 PR before 4:30", done: 0 },
  { text: "Book a room for Thursday's retro", done: 1 },
];

export const gitStatsSettings: GitStatsSettings = {
  repos: ["/home/ada/work/billing", "/home/ada/work/billing-web", "/home/ada/work/notify-worker"],
  manual: [],
  emails: [],
};

export const repoCandidates: RepoCandidate[] = [
  { path: "/home/ada/work/billing", name: "billing", remote: "bitbucket.org/acme/billing", email: "ada@example.com", sources: ["claude", "jetbrains"], last_used: sec(-HOUR) },
  { path: "/home/ada/work/billing-web", name: "billing-web", remote: "bitbucket.org/acme/billing-web", email: "ada@example.com", sources: ["claude"], last_used: sec(-26 * HOUR) },
  { path: "/home/ada/work/notify-worker", name: "notify-worker", remote: "gitlab.com/acme/notify-worker", email: "ada@example.com", sources: ["jetbrains"], last_used: sec(-80 * HOUR) },
  { path: "/home/ada/work/infra", name: "infra", remote: "gitlab.com/acme/infra", email: "ada@example.com", sources: ["jetbrains"], last_used: sec(-400 * HOUR) },
  { path: "/home/ada/side/flight-deck", name: "flight-deck", remote: "github.com/ada/flight-deck", email: "ada@users.noreply.github.com", sources: ["claude"], last_used: sec(-30 * HOUR) },
];

/** 12 weeks of plausible commits: weekday-heavy, a quiet week, busier lately. Seeded, so it's stable. */
export function gitStats(): GitStats {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - 77);
  const repos = gitStatsSettings.repos.map((path) => ({
    path,
    name: path.split("/").pop()!,
    commits: 0,
    added: 0,
    removed: 0,
    backend: 0,
    frontend: 0,
    other: 0,
    last_commit: null as number | null,
  }));
  const weights = [0.6, 0.3, 0.1];
  // What each repo's commits touch: [side, language, share].
  const mix: [Side, string, number][][] = [
    [["backend", "Ruby", 0.62], ["frontend", "Views", 0.14], ["frontend", "JavaScript", 0.06], ["other", "Config", 0.08], ["other", "Docs", 0.1]],
    [["frontend", "TypeScript", 0.74], ["frontend", "CSS", 0.14], ["other", "Config", 0.07], ["other", "Docs", 0.05]],
    [["backend", "TypeScript", 0.82], ["other", "Config", 0.12], ["other", "Shell", 0.06]],
  ];
  const sides: Record<Side, SideStat> = {
    backend: { side: "backend", commits: 0, added: 0, removed: 0, languages: [] },
    frontend: { side: "frontend", commits: 0, added: 0, removed: 0, languages: [] },
    other: { side: "other", commits: 0, added: 0, removed: 0, languages: [] },
  };
  const weeks: WeekStat[] = Array.from({ length: 12 }, (_, w) => ({
    start: key(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7)),
    backend: 0,
    frontend: 0,
    other: 0,
  }));
  const days: DayStat[] = [];
  const hours = Array(24).fill(0);
  for (let d = new Date(start); d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const week = Math.floor((d.getTime() - start.getTime()) / (7 * 24 * HOUR));
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const base = week === 5 ? 0.4 : weekend ? 0.6 : 2.5 + week * 0.25;
    const commits = Math.max(0, Math.round(base * (rand() * 2) - (weekend ? 0.4 : 0)));
    if (!commits) continue;
    const day: DayStat = { date: key(d), commits, added: 0, removed: 0 };
    for (let i = 0; i < commits; i++) {
      const added = Math.round(10 + rand() * rand() * 400);
      const removed = Math.round(added * rand() * 0.6);
      day.added += added;
      day.removed += removed;
      const r = rand();
      const ri = r < weights[0] ? 0 : r < weights[0] + weights[1] ? 1 : 2;
      const repo = repos[ri];
      repo.commits += 1;
      repo.added += added;
      repo.removed += removed;
      const touched = new Set<Side>();
      for (const [side, lang, share] of mix[ri]) {
        // Not every commit touches every part.
        if (share < 0.5 && rand() > share * 3) continue;
        const a = Math.round(added * share);
        const rm = Math.round(removed * share);
        touched.add(side);
        repo[side] += a + rm;
        weeks[week][side] += a + rm;
        sides[side].added += a;
        sides[side].removed += rm;
        let l = sides[side].languages.find((x) => x.name === lang);
        if (!l) sides[side].languages.push((l = { name: lang, added: 0, removed: 0 }));
        l.added += a;
        l.removed += rm;
      }
      touched.forEach((side) => (sides[side].commits += 1));
      const hour = weekend ? 20 + Math.floor(rand() * 3) : Math.min(23, Math.round(9 + rand() * 6 + rand() * 4));
      hours[hour] += 1;
      repo.last_commit = Math.round(d.getTime() / 1000) + hour * 3600;
    }
    days.push(day);
  }
  return {
    start: key(start),
    end: key(today),
    days,
    hours,
    sides: Object.values(sides).map((x) => ({
      ...x,
      languages: x.languages.sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    })),
    weeks,
    repos: [...repos.sort((a, b) => b.added + b.removed - (a.added + a.removed))],
    emails: ["ada@example.com"],
    errors: [],
  };
}
