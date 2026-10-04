import { useEffect, useState } from "react";
import { briefOutlookInbox, getOutlookInbox, onOutlookInbox, type MailBrief, type OutlookInbox } from "./outlook";

// The AI mail brief, shared by InboxCard and the "Intel brief" action. Module state, so it
// survives tab switches (lost when the app quits) and a brief isn't paid for twice.

export interface MailBriefState {
  brief: MailBrief | null;
  /** The unread mail the brief summarized (see unreadKey), to flag it once that changes. */
  unreadKey: string;
  running: boolean;
  error: string | null;
}

let state: MailBriefState = { brief: null, unreadKey: "", running: false, error: null };
const listeners = new Set<(s: MailBriefState) => void>();
let inFlight: Promise<void> | null = null;

function set(patch: Partial<MailBriefState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}

export const unreadKey = (inbox: OutlookInbox | null) =>
  (inbox?.messages ?? []).filter((m) => m.unread).map((m) => m.id).join(",");

/** Summarizes the last scraped unread mail with Claude. Joins a run already in progress. */
export function runMailBrief(): Promise<void> {
  inFlight ??= (async () => {
    set({ running: true, error: null });
    try {
      const inbox = await getOutlookInbox();
      if (!inbox?.signed_in || unreadKey(inbox) === "") return;
      const key = unreadKey(inbox);
      set({ brief: await briefOutlookInbox(), unreadKey: key });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ running: false });
      inFlight = null;
    }
  })();
  return inFlight;
}

const OPEN_BRIEF_TIMEOUT_MS = 3 * 60_000;
let openBriefStarted = false;

/**
 * Runs the brief once per app launch, as soon as Outlook has reported unread mail. Waits for the
 * background scrape instead of forcing one, which would pop Outlook up for sign-in at startup.
 * Gives up after a few minutes (for example when Outlook isn't signed in).
 */
export function briefOnOpen() {
  if (openBriefStarted) return;
  openBriefStarted = true;

  let done = false;
  let unlisten: (() => void) | null = null;
  const finish = () => {
    done = true;
    clearTimeout(timer);
    unlisten?.();
  };
  const timer = setTimeout(finish, OPEN_BRIEF_TIMEOUT_MS);
  const check = (inbox: OutlookInbox | null) => {
    if (done || !inbox?.signed_in || unreadKey(inbox) === "") return;
    finish();
    if (!state.brief && !inFlight) runMailBrief();
  };

  onOutlookInbox(check).then((fn) => {
    if (done) fn();
    else unlisten = fn;
  });
  getOutlookInbox().then(check);
}

export function useMailBrief(): MailBriefState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
