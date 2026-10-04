import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Meeting } from "../lib/calendar";

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function isSameLocalDay(iso: string, day: Date): boolean {
  return new Date(iso).toDateString() === day.toDateString();
}

export function todaysMeetings(meetings: Meeting[]): Meeting[] {
  const today = new Date();
  return meetings.filter((m) => isSameLocalDay(m.start, today));
}

/** Re-renders every `ms` so relative times ("in 12m", live dots) stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy meeting link"
      className="label rounded-md border border-white/10 px-2 py-1 !text-[11px] text-slate-400 hover:text-slate-200"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function MeetingRow({ meeting, now }: { meeting: Meeting; now: number }) {
  const start = new Date(meeting.start).getTime();
  const end = new Date(meeting.end).getTime();
  const past = end <= now;
  const live = start <= now && now < end;

  return (
    <li
      className={`group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04] ${
        past ? "opacity-35" : ""
      }`}
    >
      <span className="w-[4.5rem] shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums text-slate-400">
        {meeting.all_day ? "all day" : formatTime(meeting.start)}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-200">
        {live && (
          <span className="text-rose-500">
            <span className="status-dot" />
          </span>
        )}
        <span className="truncate" title={meeting.title}>
          {meeting.title}
        </span>
      </span>
      {meeting.join_url && !past && (
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyLinkButton url={meeting.join_url} />
          <button
            onClick={() => openUrl(meeting.join_url!)}
            className={`label rounded-md px-2 py-1 !text-[11px] ${
              live ? "bg-rose-500 text-white" : "border border-white/10 text-slate-300 hover:text-white"
            }`}
          >
            Join
          </button>
        </div>
      )}
    </li>
  );
}

export function Schedule({
  meetings,
  error,
  loading,
}: {
  meetings: Meeting[] | null;
  error: string | null;
  loading: boolean;
}) {
  const now = useNow();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const today = meetings ? todaysMeetings(meetings) : [];
  const tomorrowMeetings = meetings?.filter((m) => isSameLocalDay(m.start, tomorrow)) ?? [];

  if (loading && !meetings) return <p className="blink font-mono text-xs text-slate-400">syncing calendar…</p>;
  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!meetings) return null;

  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1">
      {today.length === 0 ? (
        <p className="px-2 text-sm text-slate-400">No meetings today — deep work time.</p>
      ) : (
        <ul className="flex flex-col">
          {today.map((m) => (
            <MeetingRow key={`${m.title}-${m.start}`} meeting={m} now={now} />
          ))}
        </ul>
      )}
      {tomorrowMeetings.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="label px-2 !text-[11px] text-slate-500">Tomorrow</span>
          <ul className="flex flex-col">
            {tomorrowMeetings.map((m) => (
              <MeetingRow key={`${m.title}-${m.start}`} meeting={m} now={now} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
