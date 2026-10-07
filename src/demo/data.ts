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
