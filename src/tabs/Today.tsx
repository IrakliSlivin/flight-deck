import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card, GhostButton, SectionHeader } from "../components/Card";
import { StatTile, type TileState } from "../components/StatTile";
import { TodoList } from "../components/TodoList";
import { TaskList } from "../components/TaskList";
import { ActionGrid, type Action } from "../components/ActionGrid";
import { UsageHero } from "../components/UsageHero";
import { NextUpCard } from "../components/NextUpCard";
import { Schedule, todaysMeetings, formatTime } from "../components/Schedule";
import { Headlines } from "../components/Headlines";
import { AtlasCard } from "../components/AtlasCard";
import { InboxCard } from "../components/InboxCard";
import { CalendarIcon, NewsIcon, PrIcon, TasksIcon } from "../components/Icons";
import { fetchClickupTasks, type ClickupTask } from "../lib/clickup";
import { loadPrs } from "../lib/prs";
import { fetchMeetings, type Meeting } from "../lib/calendar";
import { fetchAiNews, type NewsFeed } from "../lib/news";
import { briefOnOpen, runMailBrief } from "../lib/mailBrief";
import { fillMailBrief } from "../lib/outlook";
import type { TabContext } from ".";

const REVIEW_REFRESH_MS = 2 * 60 * 60 * 1000;
const STALE_CHECK_MS = 5 * 60 * 1000;
const MEETINGS_REFRESH_MS = 15 * 60 * 1000;
const NEWS_REFRESH_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const initial = <T,>(): Remote<T> => ({ data: null, error: null, loading: true });

/** Fetch wrapper that keeps the last good data visible while refreshing. */
function useRemote<T>(fetcher: () => Promise<T>) {
  const [state, setState] = useState<Remote<T>>(initial<T>());
  async function refresh() {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await fetcher(), error: null, loading: false });
    } catch (e) {
      setState({ data: null, error: String(e), loading: false });
    }
  }
  return [state, refresh] as const;
}

function tileState(r: Remote<unknown>): TileState {
  if (r.error) return "error";
  if (r.loading) return "loading";
  return "ok";
}

export function Today({ navigate, openSettings }: TabContext) {
  const [clickup, refreshClickup] = useRemote<ClickupTask[]>(fetchClickupTasks);
  // Forced except on mount, so returning to Overview reuses the PRs tab's fetch.
  const reviewForce = useRef(false);
  const [reviews, refreshReviewsRaw] = useRemote<number>(async () => {
    const { data: prs } = await loadPrs(reviewForce.current);
    reviewForce.current = true;
    // PRs with 2+ approvals already have enough reviews to merge.
    return prs.reviewing.filter((pr) => pr.approved_count < 2).length;
  });
  const [meetings, refreshMeetings] = useRemote<Meeting[]>(fetchMeetings);
  const [news, refreshNews] = useRemote<NewsFeed>(fetchAiNews);

  const lastReviewRefresh = useRef(0);
  function refreshReviews() {
    lastReviewRefresh.current = Date.now();
    return refreshReviewsRaw();
  }

  // Rescrapes Outlook, then has Claude rewrite the mail brief from the fresh mail.
  const [intelBusy, setIntelBusy] = useState(false);
  async function intelBrief() {
    setIntelBusy(true);
    try {
      await fillMailBrief();
      await runMailBrief();
    } finally {
      setIntelBusy(false);
    }
  }

  function refreshData() {
    refreshClickup();
    refreshReviews();
    refreshMeetings();
    refreshNews();
  }

  // On open the mail isn't rescraped (Outlook is still loading, and a rescrape would pop its window
  // up for sign-in); briefOnOpen waits for the startup scrape instead.
  function refreshAll() {
    refreshData();
    intelBrief();
  }

  useEffect(() => {
    refreshData();
    briefOnOpen();
    const meetingsId = setInterval(refreshMeetings, MEETINGS_REFRESH_MS);
    const newsId = setInterval(refreshNews, NEWS_REFRESH_MS);
    // Auto-refresh the review count once it's 2h stale; a manual refresh resets the clock.
    // Checked periodically (rather than one long timeout) so it still fires after sleep/suspend.
    const reviewsId = setInterval(() => {
      if (Date.now() - lastReviewRefresh.current >= REVIEW_REFRESH_MS) refreshReviews();
    }, STALE_CHECK_MS);
    return () => {
      clearInterval(meetingsId);
      clearInterval(newsId);
      clearInterval(reviewsId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = meetings.data ? todaysMeetings(meetings.data) : [];
  const nextMeeting = today.find((m) => !m.all_day && new Date(m.end).getTime() > Date.now());
  const freshNews = news.data?.items.filter(
    (i) => i.published && Date.now() - new Date(i.published).getTime() < DAY_MS,
  );


  const actions: Action[] = [
    { label: "Refresh all", run: refreshAll, primary: true },
    { label: "Sprint tasks", run: refreshClickup, busy: clickup.loading },
    { label: "Pull PRs", run: refreshReviews, busy: reviews.loading },
    { label: "Sync calendar", run: refreshMeetings, busy: meetings.loading },
    { label: "Intel brief", run: intelBrief, busy: intelBusy },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pt-2 pb-8">
      <UsageHero delay={0} />

      <div className="grid grid-cols-4 gap-4">
        <StatTile
          label="Sprint tasks"
          value={clickup.data?.length ?? null}
          state={tileState(clickup)}
          sub={clickup.error ? "ClickUp not linked" : "assigned to you"}
          icon={TasksIcon}
          iconClass="text-violet-400"
          delay={60}
          onClick={clickup.error ? openSettings : undefined}
        />
        <StatTile
          label="PRs to review"
          value={reviews.data}
          state={tileState(reviews)}
          sub={reviews.error ? "Bitbucket / GitLab not linked" : "awaiting your approval"}
          icon={PrIcon}
          iconClass="text-sky-400"
          delay={110}
          onClick={reviews.error ? openSettings : () => navigate("prs")}
        />
        <StatTile
          label="Meetings today"
          value={meetings.data ? today.length : null}
          state={tileState(meetings)}
          sub={
            meetings.error
              ? "Calendar not linked"
              : nextMeeting
                ? `next at ${formatTime(nextMeeting.start)}`
                : "nothing left today"
          }
          icon={CalendarIcon}
          iconClass="text-rose-400"
          delay={160}
          onClick={meetings.error ? openSettings : undefined}
        />
        <StatTile
          label="AI headlines · 24h"
          value={freshNews ? freshNews.length : null}
          state={tileState(news)}
          sub={
            news.data?.failed_sources.length
              ? `${news.data.failed_sources.length} feeds offline`
              : "across all sources"
          }
          icon={NewsIcon}
          iconClass="text-amber-500"
          delay={210}
          onClick={() => navigate("news")}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <NextUpCard today={today} delay={260} />
        <InboxCard delay={300} />
      </div>

      <ActionGrid actions={actions} delay={340} />

      <Card tone="glass" delay={380} className="grid grid-cols-12 gap-6">
        <section className="col-span-5">
          <SectionHeader
            title="Today"
            right={<GhostButton onClick={refreshMeetings}>Sync</GhostButton>}
          />
          <Schedule meetings={meetings.data} error={meetings.error} loading={meetings.loading} />
        </section>
        <section className="col-span-4 border-l border-white/[0.06] pl-6">
          <SectionHeader
            title={
              <>
                Tasks{" "}
                {clickup.data && <span className="text-slate-500">· {clickup.data.length}</span>}
              </>
            }
            right={
              <div className="flex gap-1.5">
                <GhostButton onClick={() => openUrl("https://app.clickup.com")}>Open</GhostButton>
                <GhostButton onClick={refreshClickup}>Sync</GhostButton>
              </div>
            }
          />
          <TaskList tasks={clickup.data} error={clickup.error} loading={clickup.loading} onChanged={refreshClickup} />
        </section>
        <section className="col-span-3 border-l border-white/[0.06] pl-6">
          <SectionHeader title="Notes & todo" />
          <TodoList />
        </section>
      </Card>

      <Card tone="glass" delay={440}>
        <SectionHeader
          title="Morning headlines"
          right={
            <div className="flex gap-1.5">
              <GhostButton onClick={() => navigate("news")}>All news ↗</GhostButton>
              <GhostButton onClick={refreshNews}>Sync</GhostButton>
            </div>
          }
        />
        <Headlines feed={news.data} error={news.error} />
      </Card>

      <AtlasCard delay={500} />
    </div>
  );
}
