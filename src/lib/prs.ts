import { fetchBitbucketPrs, type BitbucketPr, type BitbucketPrs } from "./bitbucket";
import { fetchGitlabPrs } from "./gitlab";
import { hasCredential } from "./credentials";

export type PrProvider = "bitbucket" | "gitlab";

export interface PullRequest extends BitbucketPr {
  provider: PrProvider;
}

export interface PullRequests {
  authored: PullRequest[];
  reviewing: PullRequest[];
  /** Linked providers that were fetched successfully. */
  providers: PrProvider[];
  /** Linked providers whose fetch failed, with the error. */
  errors: { provider: PrProvider; error: string }[];
}

export const PROVIDER_NAME: Record<PrProvider, string> = {
  bitbucket: "Bitbucket",
  gitlab: "GitLab",
};

const SOURCES: { provider: PrProvider; key: string; fetch: () => Promise<BitbucketPrs> }[] = [
  { provider: "bitbucket", key: "bitbucket.api_token", fetch: fetchBitbucketPrs },
  { provider: "gitlab", key: "gitlab.api_token", fetch: fetchGitlabPrs },
];

/** A shared result younger than this is reused instead of refetching. */
const SHARED_FRESH_MS = 5 * 60 * 1000;

let shared: { data: PullRequests; fetchedAt: Date } | null = null;
let inflight: Promise<{ data: PullRequests; fetchedAt: Date }> | null = null;

/**
 * PRs shared by the Overview tile and the PRs tab (tabs remount on every
 * switch). Joins a fetch already in progress, and reuses a result younger
 * than 5 min unless `force` (the explicit refresh buttons). Failures aren't
 * cached.
 */
export function loadPrs(force = false): Promise<{ data: PullRequests; fetchedAt: Date }> {
  if (inflight) return inflight;
  if (!force && shared && Date.now() - shared.fetchedAt.getTime() < SHARED_FRESH_MS) {
    return Promise.resolve(shared);
  }
  inflight = fetchAllPrs()
    .then((data) => (shared = { data, fetchedAt: new Date() }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Refetches in the background after you change a PR (approve, request changes), so the list
 * drops it. A fetch already in flight may predate the change, so this one runs after it.
 */
export function refreshPrs() {
  const run = () => loadPrs(true).catch(() => undefined);
  void (inflight ? inflight.then(run, run) : run());
}

/**
 * Fetches every linked PR source in parallel. Unlinked sources are skipped;
 * one failing source doesn't hide the others. Throws only when nothing is
 * linked or every linked source failed.
 */
export async function fetchAllPrs(): Promise<PullRequests> {
  const linked = await Promise.all(SOURCES.map((s) => hasCredential(s.key).catch(() => false)));
  const active = SOURCES.filter((_, i) => linked[i]);
  if (active.length === 0) throw new Error("No PR source linked. Add Bitbucket or GitLab in Settings.");

  const results = await Promise.allSettled(active.map((s) => s.fetch()));
  const out: PullRequests = { authored: [], reviewing: [], providers: [], errors: [] };
  results.forEach((r, i) => {
    const provider = active[i].provider;
    if (r.status === "rejected") {
      out.errors.push({ provider, error: String(r.reason) });
      return;
    }
    out.providers.push(provider);
    out.authored.push(...r.value.authored.map((pr) => ({ ...pr, provider })));
    out.reviewing.push(...r.value.reviewing.map((pr) => ({ ...pr, provider })));
  });
  if (out.providers.length === 0) {
    throw new Error(out.errors.map((e) => `${PROVIDER_NAME[e.provider]}: ${e.error}`).join("\n"));
  }
  return out;
}
