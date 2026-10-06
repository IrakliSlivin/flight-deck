import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface OutlookMessage {
  /** Outlook's conversation id (`data-convid`). */
  id: string;
  unread: boolean;
  sender: string;
  subject: string;
  time: string;
  preview: string;
}

export interface OutlookInbox {
  signed_in: boolean;
  unread_count: number;
  messages: OutlookMessage[];
  updated_at: number;
}

/** Last inbox scraped from the background Outlook Web window, or null before its first report. */
export function getOutlookInbox(): Promise<OutlookInbox | null> {
  return invoke("get_outlook_inbox");
}

export function onOutlookInbox(handler: (inbox: OutlookInbox) => void): Promise<UnlistenFn> {
  return listen<OutlookInbox>("outlook-inbox", (e) => handler(e.payload));
}

/** Shows the Outlook window, opening a conversation when `messageId` is given. */
export function openOutlook(messageId?: string): Promise<void> {
  return invoke("open_outlook", { messageId: messageId ?? null });
}

/**
 * Asks the hidden Outlook window for a fresh report without showing it. Resolves false when
 * Outlook isn't signed in, in which case the window has been shown for sign-in.
 */
export function refreshOutlook(): Promise<boolean> {
  return invoke("refresh_outlook");
}

/** Resolves with the next inbox report, or null if none arrives within `timeoutMs`. */
export function nextOutlookInbox(timeoutMs: number): Promise<OutlookInbox | null> {
  return new Promise((resolve) => {
    let unlisten: UnlistenFn | null = null;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, timeoutMs);
    onOutlookInbox((inbox) => {
      clearTimeout(timer);
      unlisten?.();
      resolve(inbox);
    }).then((fn) => (unlisten = fn));
  });
}

// Covers Outlook navigating back to the Inbox plus its 10s wait for a still-loading page.
const FILL_TIMEOUT_MS = 20_000;

/** Rescrapes in the background; shows the Outlook window only when it needs a sign-in. */
export async function fillMailBrief(): Promise<void> {
  const report = nextOutlookInbox(FILL_TIMEOUT_MS);
  if (!(await refreshOutlook())) return;
  const inbox = await report;
  if (!inbox || !inbox.signed_in) await openOutlook();
}

export interface MailBriefItem {
  /** Conversation id of the message the point is about. */
  id: string;
  sender: string;
  point: string;
  needs_reply: boolean;
}

export interface MailBrief {
  headline: string;
  items: MailBriefItem[];
}

/** Has Claude summarize the unread mail from the last scrape. */
export function briefOutlookInbox(): Promise<MailBrief> {
  return invoke("brief_outlook_inbox");
}

export const CLAUDE_CLI_KEY = "claude.cli_path";

export interface ClaudeCliCheck {
  path: string;
  version: string;
}

export function checkClaudeCli(path?: string): Promise<ClaudeCliCheck> {
  return invoke("check_claude_cli", { path: path?.trim() || null });
}
