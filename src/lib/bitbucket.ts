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
