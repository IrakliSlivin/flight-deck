// Stands in for @tauri-apps/api/core in demo mode (VITE_DEMO=1, see vite.config.ts):
// every command answers with made-up data from ./data, so the UI runs in a plain browser.
import * as data from "./data";
import { emit } from "./event";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  has_credential: ({ key }) => (key as string) in data.credentials,
  get_credential: ({ key }) => data.credentials[key as string] ?? null,
  save_credential: ({ key, value }) => void (data.credentials[key as string] = value as string),
  delete_credential: ({ key }) => void delete data.credentials[key as string],

  read_claude_rate_limits: () => data.rateLimits,
  compute_claude_usage: () => ({
    days: [],
    by_model: [],
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    window_days: 30,
  }),

  fetch_clickup_tasks: () => data.tasks,
  fetch_clickup_list_statuses: () => data.statuses,
  update_clickup_task_status: ({ taskId, status }) => {
    const task = data.tasks.find((t) => t.id === taskId);
    if (task) task.status = status as string;
  },

  check_clickup: () => data.clickupSetup,
  fetch_bitbucket_prs: () => data.bitbucketPrs,
  check_bitbucket: () => ({ user: "Ada Lovelace", workspaces: ["acme", "acme-labs"] }),
  list_bitbucket_repos: ({ workspace }) => data.bitbucketRepos[workspace as string] ?? [],
  fetch_gitlab_prs: () => data.gitlabPrs,
  check_gitlab: () => "@ada on gitlab.com",
  fetch_meetings: () => data.meetings,
  fetch_ai_news: () => data.newsFeed,

  get_outlook_inbox: () => data.inbox,
  refresh_outlook: () => {
    setTimeout(() => emit("outlook-inbox", data.inbox), 300);
    return true;
  },
  open_outlook: () => undefined,
  brief_outlook_inbox: async () => {
    await delay(1200);
    return data.mailBrief;
  },
  check_claude_cli: ({ path }) => ({
    path: (path as string | null) ?? "/home/demo/.local/bin/claude",
    version: "2.1.291 (Claude Code)",
  }),

  get_notification_feed: () => data.notificationFeed,
  dismiss_notification: ({ id }) => {
    const i = data.notificationFeed.findIndex((n) => n.id === id);
    if (i >= 0) data.notificationFeed.splice(i, 1);
    emit("notification-feed", data.notificationFeed);
  },
  clear_notifications: () => {
    const n = data.notificationFeed.length;
    data.notificationFeed.length = 0;
    emit("notification-feed", data.notificationFeed);
    return n;
  },

  get_reminder_settings: () => data.reminderSettings,
  set_reminder_settings: ({ settings }) => void Object.assign(data.reminderSettings, settings),
  preview_notification_sound: () => undefined,
  quit_app: () => undefined,
  send_claude_message: () => "This is demo mode, so there's no real Claude behind this reply.",
};

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) throw new Error(`demo mode: no mock for "${cmd}"`);
  await delay(250 + Math.random() * 350);
  return (await handler(args)) as T;
}
