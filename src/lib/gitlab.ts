import { invoke } from "@tauri-apps/api/core";
import type { BitbucketPrs } from "./bitbucket";

/** Merge requests in the same shape as Bitbucket PRs (`id` is the MR's iid). */
export function fetchGitlabPrs(): Promise<BitbucketPrs> {
  return invoke("fetch_gitlab_prs");
}
