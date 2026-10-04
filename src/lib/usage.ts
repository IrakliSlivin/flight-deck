import { invoke } from "@tauri-apps/api/core";

export interface DayUsage {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface UsageSummary {
  days: DayUsage[];
  by_model: ModelUsage[];
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  window_days: number;
}

export function computeClaudeUsage(): Promise<UsageSummary> {
  return invoke("compute_claude_usage");
}

export interface RateLimitWindow {
  used_percentage: number;
  resets_at: number;
}

export interface RateLimitSnapshot {
  rate_limits: {
    five_hour: RateLimitWindow | null;
    seven_day: RateLimitWindow | null;
  };
  updated_at: number;
}

export function readClaudeRateLimits(): Promise<RateLimitSnapshot | null> {
  return invoke("read_claude_rate_limits");
}
