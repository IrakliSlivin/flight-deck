import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { languageFor } from "./highlight";
import type { PrProvider } from "./prs";

// Claude reviews of a PR's diff (review.rs). Runs live in module state, so one keeps going
// (and is shown) when you leave the review page and come back.

export type LineKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  old: number | null;
  new: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  old_path: string;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: { header: string; lines: DiffLine[] }[];
}

export interface PrDiff {
  title: string;
  description: string;
  author: string;
  source_branch: string;
  dest_branch: string;
  head_sha: string;
  files: DiffFile[];
}

export type DecisionKind = "approve" | "request_changes" | "comment";

export interface Decision {
  kind: DecisionKind;
  at: string;
  /** The comment posted with it; "" when there was none. */
  comment_url: string;
}

export type Severity = "blocker" | "major" | "minor" | "nit";

export interface Finding {
  file: string;
  side: "new" | "old";
  start_line: number;
  end_line: number;
  severity: Severity;
  category: string;
  title: string;
  explanation: string;
  /** Replacement for start_line..end_line on the new side; "" when there is none. */
  suggestion: string;
  /** False when the lines aren't in the diff. */
  anchored: boolean;
  /** URL of the PR comment made from it, once posted; "" before. */
  posted_url: string;
}

export interface Review {
  summary: string;
  verdict: "approve" | "comment" | "request_changes";
  risk: "low" | "medium" | "high";
  key_changes: { file: string; importance: "high" | "medium" | "low"; summary: string }[];
  findings: Finding[];
}

export interface SavedReview {
  provider: PrProvider;
  url: string;
  reviewed_at: string;
  /** The PR as reviewed; the findings' line numbers refer to this diff. */
  pr: PrDiff;
  omitted: { path: string; reason: string }[];
  review: Review;
  /** Your last approve / request changes / comment from the review page. */
  decision: Decision | null;
}

export interface ReviewSummary {
  url: string;
  head_sha: string;
  reviewed_at: string;
  verdict: Review["verdict"];
  findings: number;
  blockers: number;
}

export const SEVERITIES: Severity[] = ["blocker", "major", "minor", "nit"];

export const fetchPrDiff = (provider: PrProvider, url: string) => invoke<PrDiff>("fetch_pr_diff", { provider, url });

export const getPrReview = (url: string) => invoke<SavedReview | null>("get_pr_review", { url });

const CANCELLED = "Review cancelled.";

export interface ReviewsState {
  /** Start time (ms) of each run in progress, by PR URL. */
  running: Record<string, number>;
  errors: Record<string, string>;
  /** Reviews finished in this session, by PR URL. */
  results: Record<string, SavedReview>;
  /** Every saved review (list_pr_reviews), for the badges on the PRs tab. */
  summaries: Record<string, ReviewSummary>;
}

let state: ReviewsState = { running: {}, errors: {}, results: {}, summaries: {} };
const listeners = new Set<(s: ReviewsState) => void>();

function set(patch: (s: ReviewsState) => Partial<ReviewsState>) {
  state = { ...state, ...patch(state) };
  listeners.forEach((fn) => fn(state));
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

export async function loadReviewSummaries() {
  const list = await invoke<ReviewSummary[]>("list_pr_reviews").catch(() => []);
  set(() => ({ summaries: Object.fromEntries(list.map((s) => [s.url, s])) }));
}

/** Reviews the PR's current diff with Claude. Does nothing while a run for it is in progress. */
export async function startReview(provider: PrProvider, url: string) {
  if (state.running[url]) return;
  set((s) => ({ running: { ...s.running, [url]: Date.now() }, errors: without(s.errors, url) }));
  try {
    const saved = await invoke<SavedReview>("review_pr", { provider, url });
    const summary: ReviewSummary = {
      url,
      head_sha: saved.pr.head_sha,
      reviewed_at: saved.reviewed_at,
      verdict: saved.review.verdict,
      findings: saved.review.findings.length,
      blockers: saved.review.findings.filter((f) => f.severity === "blocker").length,
    };
    set((s) => ({ results: { ...s.results, [url]: saved }, summaries: { ...s.summaries, [url]: summary } }));
  } catch (e) {
    if (String(e) !== CANCELLED) set((s) => ({ errors: { ...s.errors, [url]: String(e) } }));
  } finally {
    set((s) => ({ running: without(s.running, url) }));
  }
}

function applySaved(saved: SavedReview) {
  set((s) => ({ results: { ...s.results, [saved.url]: saved } }));
}

/** Posts finding `index` of the saved review as a PR comment, with the (edited) text. */
export async function postFindingComment(url: string, index: number, body: string) {
  applySaved(await invoke<SavedReview>("post_review_comment", { url, finding: index, body }));
}

/** Approve / request changes / comment on the PR, with an optional comment. */
export async function submitDecision(url: string, decision: DecisionKind, body: string) {
  applySaved(await invoke<SavedReview>("submit_pr_decision", { url, decision, body }));
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * The default text of a finding's PR comment. On GitLab a fix on new lines becomes a suggestion
 * block the author can apply (the comment sits on the finding's last line, so it reaches back
 * over the rest of the range).
 */
export function findingCommentBody(f: Finding, provider: PrProvider): string {
  let text = `${f.anchored ? "" : `\`${f.file}\`\n\n`}**${capitalize(f.severity)} (${f.category}):** ${f.title}\n\n${f.explanation}`;
  if (f.suggestion.trim()) {
    const fence =
      provider === "gitlab" && f.anchored && f.side === "new"
        ? `suggestion:-${f.end_line - f.start_line}+0`
        : (languageFor(f.file) ?? "");
    text += `\n\nSuggested change:\n\`\`\`${fence}\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return text;
}

export function cancelReview(url: string) {
  return invoke("cancel_pr_review", { url });
}

export function useReviews(): ReviewsState {
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
