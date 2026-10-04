import { useEffect, useState } from "react";
import { Card, GhostButton, SectionHeader } from "./Card";
import { runMailBrief, unreadKey, useMailBrief } from "../lib/mailBrief";
import { getOutlookInbox, onOutlookInbox, openOutlook, type MailBrief, type OutlookInbox } from "../lib/outlook";

function AiBrief({ brief, stale }: { brief: MailBrief; stale: boolean }) {
  return (
    <div className="mb-3 rounded-lg border border-[#3a3a33] bg-[#191e27] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-amber-300">✦</span>
        <p className="min-w-0 flex-1 text-sm text-slate-200">{brief.headline}</p>
        {stale && <span className="shrink-0 font-mono text-[10px] text-slate-500">inbox changed</span>}
      </div>
      {brief.items.length > 0 && (
        <ul className="mt-1.5 flex flex-col">
          {brief.items.map((item, i) => (
            <li key={`${item.id}-${i}`}>
              <button
                onClick={() => openOutlook(item.id)}
                className="flex w-full items-baseline gap-3 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full ${item.needs_reply ? "bg-amber-300" : "bg-slate-500"}`}
                />
                <span className="w-32 shrink-0 truncate text-xs font-semibold text-slate-300">{item.sender}</span>
                <span className="min-w-0 flex-1 text-xs text-slate-400">{item.point}</span>
                {item.needs_reply && (
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-amber-300/80">reply</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InboxCard({ delay = 0 }: { delay?: number }) {
  const [inbox, setInbox] = useState<OutlookInbox | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { brief, unreadKey: briefKey, running: briefing, error: briefError } = useMailBrief();
  const aiBrief = () => void runMailBrief();

  useEffect(() => {
    getOutlookInbox()
      .then(setInbox)
      .finally(() => setLoaded(true));
    const unlisten = onOutlookInbox(setInbox);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Outlook only renders the rows on screen, so this can be fewer than unread_count.
  const seen = (inbox?.messages ?? []).filter((m) => m.unread).length;

  return (
    <Card tone="glass" delay={delay}>
      <SectionHeader
        title={
          <>
            Mail brief{" "}
            {inbox?.signed_in && <span className="text-slate-500">· {inbox.unread_count} unread</span>}
          </>
        }
        right={
          <div className="flex gap-1.5">
            {inbox?.signed_in && seen > 0 && (
              <GhostButton onClick={aiBrief} title="Summarize the unread mail with Claude">
                {briefing ? <span className="blink">Thinking…</span> : "✦ AI brief"}
              </GhostButton>
            )}
            <GhostButton onClick={() => openOutlook()}>Open Outlook</GhostButton>
          </div>
        }
      />
      {!inbox || !inbox.signed_in ? (
        <p className="text-sm text-slate-400">
          {loaded ? (
            <>
              Waiting for Outlook.{" "}
              <button onClick={() => openOutlook()} className="text-amber-300 hover:text-amber-200">
                Open it
              </button>{" "}
              to sign in, then leave it on the Inbox. Ctrl+W hides it; it keeps running in the background.
            </>
          ) : (
            <span className="blink font-mono text-xs">checking mail…</span>
          )}
        </p>
      ) : seen === 0 && inbox.unread_count > 0 ? (
        <p className="blink font-mono text-xs text-slate-400">
          {inbox.unread_count} unread — loading Outlook's message list…
        </p>
      ) : seen === 0 ? (
        <p className="text-sm text-slate-400">Inbox zero — nothing unread.</p>
      ) : (
        <>
          {briefError && <p className="mb-2 text-xs text-rose-300">{briefError}</p>}
          {brief ? (
            <AiBrief brief={brief} stale={briefKey !== unreadKey(inbox)} />
          ) : (
            <p className="text-sm text-slate-400">
              {briefing ? (
                <span className="blink font-mono text-xs">Claude is reading {seen} unread…</span>
              ) : (
                <>
                  {seen} unread.{" "}
                  <button onClick={aiBrief} className="text-amber-300 hover:text-amber-200">
                    ✦ AI brief
                  </button>{" "}
                  summarizes them with Claude.
                </>
              )}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
