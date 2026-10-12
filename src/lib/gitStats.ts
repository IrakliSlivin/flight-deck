import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export interface GitStatsSettings {
  /** Selected repo roots; the Stats tab is hidden while this is empty. */
  repos: string[];
  /** Repos added by hand, kept in the list even when unticked. */
  manual: string[];
  /** Extra author emails, on top of each repo's user.email. */
  emails: string[];
}

export interface RepoCandidate {
  path: string;
  name: string;
  /** Short host/owner/repo of origin. */
  remote: string | null;
  /** The user.email commits there are matched on. */
  email: string | null;
  /** "claude", "jetbrains", "added" or "missing". */
  sources: string[];
  /** Unix seconds it was last opened in Claude Code or the IDE (0 = unknown). */
  last_used: number;
}

export interface DayStat {
  date: string;
  commits: number;
  added: number;
  removed: number;
}

export interface RepoStat {
  path: string;
  name: string;
  commits: number;
  added: number;
  removed: number;
  /** Lines changed (added + removed) per side. */
  backend: number;
  frontend: number;
  other: number;
  last_commit: number | null;
}

export type Side = "backend" | "frontend" | "other";

export interface SideStat {
  side: Side;
  /** Commits touching at least one file on this side. */
  commits: number;
  added: number;
  removed: number;
  /** Most lines changed first. */
  languages: { name: string; added: number; removed: number }[];
}

/** Lines changed (added + removed) per side in one week. */
export interface WeekStat {
  /** Monday, YYYY-MM-DD. */
  start: string;
  backend: number;
  frontend: number;
  other: number;
}

export interface GitStats {
  /** Monday the 12-week window starts on, and today (YYYY-MM-DD). */
  start: string;
  end: string;
  /** Days with at least one commit, oldest first. */
  days: DayStat[];
  /** Commits by hour of day (0–23), in each commit's own time zone. */
  hours: number[];
  /** Backend, frontend, other. */
  sides: SideStat[];
  /** One per week of the window, oldest first. */
  weeks: WeekStat[];
  repos: RepoStat[];
  emails: string[];
  errors: { path: string; error: string }[];
}

export function getGitStatsSettings(): Promise<GitStatsSettings> {
  return invoke("get_git_stats_settings");
}

export async function setGitStatsSettings(settings: GitStatsSettings): Promise<void> {
  await invoke("set_git_stats_settings", { settings });
  cached = null;
  setEnabled(settings.repos.length > 0);
}

export function discoverGitRepos(): Promise<RepoCandidate[]> {
  return invoke("discover_git_repos");
}

/** The repo containing `path`, or every repo up to 3 levels below it. */
export function scanGitPath(path: string): Promise<string[]> {
  return invoke("scan_git_path", { path });
}

// ---------- whether the Stats tab shows ----------

let enabled = false;
const listeners = new Set<() => void>();

function setEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  listeners.forEach((fn) => fn());
}

getGitStatsSettings()
  .then((s) => setEnabled(s.repos.length > 0))
  .catch(() => {});

/** True once at least one repository is selected in Settings. */
export function useStatsEnabled(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => enabled,
  );
}

// ---------- stats, shared across tab switches ----------

const FRESH_MS = 5 * 60_000;
let cached: { data: GitStats; at: Date } | null = null;
let inFlight: Promise<{ data: GitStats; at: Date }> | null = null;

/** Reuses a result under 5 minutes old unless `force`; joins a fetch already running. */
export function loadGitStats(force: boolean): Promise<{ data: GitStats; at: Date }> {
  if (!force && cached && Date.now() - cached.at.getTime() < FRESH_MS) return Promise.resolve(cached);
  inFlight ??= invoke<GitStats>("compute_git_stats")
    .then((data) => (cached = { data, at: new Date() }))
    .finally(() => (inFlight = null));
  return inFlight;
}
