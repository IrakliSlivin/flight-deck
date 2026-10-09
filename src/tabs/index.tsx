import type { ReactElement } from "react";
import { Today } from "./Today";
import { PRs } from "./PRs";
import { News } from "./News";
import type { PullRequest } from "../lib/prs";

export type TabId = "today" | "prs" | "news";

/** App-level actions a tab can trigger. */
export interface TabContext {
  navigate: (id: TabId) => void;
  openSettings: () => void;
  openPalette: () => void;
  /** Opens the Claude review page for a PR. */
  openReview: (pr: PullRequest) => void;
}

export interface TabDef {
  id: TabId;
  label: string;
  render: (ctx: TabContext) => ReactElement;
}

export const TABS: TabDef[] = [
  {
    id: "today",
    label: "Overview",
    render: (ctx) => <Today {...ctx} />,
  },
  {
    id: "prs",
    label: "Pull Requests",
    render: (ctx) => <PRs onReview={ctx.openReview} />,
  },
  {
    id: "news",
    label: "AI News",
    render: () => <News />,
  },
];
