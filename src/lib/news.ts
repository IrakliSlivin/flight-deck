import { invoke } from "@tauri-apps/api/core";

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  published: string | null;
  summary: string | null;
}

export interface NewsFeed {
  items: NewsItem[];
  failed_sources: string[];
}

export function fetchAiNews(): Promise<NewsFeed> {
  return invoke("fetch_ai_news");
}
