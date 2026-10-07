import { invoke } from "@tauri-apps/api/core";

export interface BitbucketPr {
  id: number;
  title: string;
  author: string;
  source_repo: string;
  url: string;
  updated_on: string;
  draft: boolean;
  approved_count: number;
  reviewers_total: number;
}

export interface BitbucketPrs {
  authored: BitbucketPr[];
  reviewing: BitbucketPr[];
}

export function fetchBitbucketPrs(): Promise<BitbucketPrs> {
  return invoke("fetch_bitbucket_prs");
}

export interface BitbucketSetup {
  user: string;
  /** null when the token lacks the read:workspace:bitbucket scope. */
  workspaces: string[] | null;
}

/** Checks the saved email + token and lists your workspaces. */
export function checkBitbucket(): Promise<BitbucketSetup> {
  return invoke("check_bitbucket");
}

export function listBitbucketRepos(workspace: string): Promise<string[]> {
  return invoke("list_bitbucket_repos", { workspace });
}
