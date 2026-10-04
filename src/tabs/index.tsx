import type { ReactElement } from "react";
import { Today } from "./Today";
import { PRs } from "./PRs";
import { News } from "./News";

export type TabId = "today" | "prs" | "news";

/** App-level actions a tab can trigger. */
export interface TabContext {
  navigate: (id: TabId) => void;
  openSettings: () => void;
  openPalette: () => void;
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
    render: () => <PRs />,
  },
  {
    id: "news",
    label: "AI News",
    render: () => <News />,
  },
];
