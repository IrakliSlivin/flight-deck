use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const WINDOW_DAYS: i64 = 30;

#[derive(Serialize, Default, Clone)]
pub struct DayUsage {
    date: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    cost_usd: f64,
}

#[derive(Serialize, Default, Clone)]
pub struct ModelUsage {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    cost_usd: f64,
}

#[derive(Serialize)]
pub struct UsageSummary {
    days: Vec<DayUsage>,
    by_model: Vec<ModelUsage>,
    total_cost_usd: f64,
    total_input_tokens: u64,
    total_output_tokens: u64,
    window_days: u32,
}

struct Rates {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
}

// Approximate public per-million-token pricing by model tier. Costs shown in
// the Usage tab are estimates for personal tracking, not a billing source of truth.
fn rates_for(model: &str) -> Rates {
    let m = model.to_lowercase();
    if m.contains("opus") {
        Rates {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write_5m: 18.75,
            cache_write_1h: 30.0,
        }
    } else if m.contains("haiku") {
        Rates {
            input: 0.8,
            output: 4.0,
            cache_read: 0.08,
            cache_write_5m: 1.0,
            cache_write_1h: 1.6,
        }
    } else {
        Rates {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write_5m: 3.75,
            cache_write_1h: 6.0,
        }
    }
}

fn find_jsonl_files(root: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(sub) = fs::read_dir(&path) else {
            continue;
        };
        for f in sub.flatten() {
            let fp = f.path();
            if fp.extension().map(|e| e == "jsonl").unwrap_or(false) {
                out.push(fp);
            }
        }
    }
    out
}

#[tauri::command]
pub fn compute_claude_usage() -> Result<UsageSummary, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let root = PathBuf::from(home).join(".claude").join("projects");

    let empty_summary = || UsageSummary {
        days: vec![],
        by_model: vec![],
        total_cost_usd: 0.0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        window_days: WINDOW_DAYS as u32,
    };

    if !root.exists() {
        return Ok(empty_summary());
    }

    let cutoff = Utc::now() - chrono::Duration::days(WINDOW_DAYS);

    let mut by_day: HashMap<String, DayUsage> = HashMap::new();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();

    for file in find_jsonl_files(&root) {
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(ts_str) = v.get("timestamp").and_then(|t| t.as_str()) else {
                continue;
            };
            let Ok(ts) = DateTime::parse_from_rfc3339(ts_str) else {
                continue;
            };
            let ts_utc = ts.with_timezone(&Utc);
            if ts_utc < cutoff {
                continue;
            }

            let Some(message) = v.get("message") else {
                continue;
            };
            let Some(model) = message.get("model").and_then(|m| m.as_str()) else {
                continue;
            };
            let Some(usage) = message.get("usage") else {
                continue;
            };

            let get_u64 = |key: &str| -> u64 { usage.get(key).and_then(|x| x.as_u64()).unwrap_or(0) };

            let input_tokens = get_u64("input_tokens");
            let output_tokens = get_u64("output_tokens");
            let cache_read = get_u64("cache_read_input_tokens");
            let cache_creation_total = get_u64("cache_creation_input_tokens");

            let (cache_1h, cache_5m) = usage
                .get("cache_creation")
                .map(|cc| {
                    (
                        cc.get("ephemeral_1h_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                        cc.get("ephemeral_5m_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
                    )
                })
                .unwrap_or((0, cache_creation_total));

            let rates = rates_for(model);
            let cost = (input_tokens as f64 / 1_000_000.0) * rates.input
                + (output_tokens as f64 / 1_000_000.0) * rates.output
                + (cache_read as f64 / 1_000_000.0) * rates.cache_read
                + (cache_1h as f64 / 1_000_000.0) * rates.cache_write_1h
                + (cache_5m as f64 / 1_000_000.0) * rates.cache_write_5m;

            let date = ts_utc.format("%Y-%m-%d").to_string();

            let day = by_day.entry(date.clone()).or_insert_with(|| DayUsage {
                date: date.clone(),
                ..Default::default()
            });
            day.input_tokens += input_tokens;
            day.output_tokens += output_tokens;
            day.cache_read_tokens += cache_read;
            day.cache_creation_tokens += cache_creation_total;
            day.cost_usd += cost;

            let model_entry = by_model.entry(model.to_string()).or_insert_with(|| ModelUsage {
                model: model.to_string(),
                ..Default::default()
            });
            model_entry.input_tokens += input_tokens;
            model_entry.output_tokens += output_tokens;
            model_entry.cache_read_tokens += cache_read;
            model_entry.cache_creation_tokens += cache_creation_total;
            model_entry.cost_usd += cost;
        }
    }

    let mut days: Vec<DayUsage> = by_day.into_values().collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));

    let mut by_model_vec: Vec<ModelUsage> = by_model.into_values().collect();
    by_model_vec.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_cost_usd: f64 = days.iter().map(|d| d.cost_usd).sum();
    let total_input_tokens: u64 = days.iter().map(|d| d.input_tokens).sum();
    let total_output_tokens: u64 = days.iter().map(|d| d.output_tokens).sum();

    Ok(UsageSummary {
        days,
        by_model: by_model_vec,
        total_cost_usd,
        total_input_tokens,
        total_output_tokens,
        window_days: WINDOW_DAYS as u32,
    })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RateLimitWindow {
    used_percentage: f64,
    resets_at: i64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct RateLimits {
    five_hour: Option<RateLimitWindow>,
    seven_day: Option<RateLimitWindow>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RateLimitSnapshot {
    #[serde(default)]
    rate_limits: RateLimits,
    updated_at: i64,
}

fn claude_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}

// Minimum gap between live fetch attempts (successful or not); the endpoint rate-limits eagerly.
const LIVE_MIN_INTERVAL_SECS: i64 = 1200;
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Deserialize)]
struct OauthCredentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OauthToken,
}

#[derive(Deserialize)]
struct OauthToken {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at_ms: i64,
}

#[derive(Deserialize)]
struct LiveWindow {
    utilization: f64,
    resets_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct LiveUsage {
    five_hour: Option<LiveWindow>,
    seven_day: Option<LiveWindow>,
}

fn to_window(live: Option<LiveWindow>, length_secs: i64, now: i64) -> Option<RateLimitWindow> {
    // resets_at is null when nothing has been used in the window yet.
    live.map(|w| RateLimitWindow {
        used_percentage: w.utilization,
        resets_at: w.resets_at.map_or(now + length_secs, |t| t.timestamp()),
    })
}

// Plan usage straight from Anthropic (the endpoint behind Claude Code's /usage), so it counts
// the desktop app and claude.ai too. Borrows Claude Code's OAuth login and never refreshes it:
// refreshing would rotate the refresh token and log the CLI out. Returns None when the token has
// expired, which only the CLI renews.
async fn fetch_live_rate_limits(dir: &PathBuf) -> Result<Option<RateLimitSnapshot>, String> {
    let Ok(content) = fs::read_to_string(dir.join(".credentials.json")) else { return Ok(None) };
    let creds: OauthCredentials =
        serde_json::from_str(&content).map_err(|e| format!("bad .credentials.json: {e}"))?;
    let now = Utc::now().timestamp();
    if creds.claude_ai_oauth.expires_at_ms / 1000 <= now + 60 {
        return Ok(None);
    }

    let resp = reqwest::Client::new()
        .get(USAGE_URL)
        .bearer_auth(&creds.claude_ai_oauth.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("usage request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("usage request returned {}", resp.status()));
    }
    let live: LiveUsage = resp.json().await.map_err(|e| format!("bad usage response: {e}"))?;

    Ok(Some(RateLimitSnapshot {
        rate_limits: RateLimits {
            five_hour: to_window(live.five_hour, 5 * 3600, now),
            seven_day: to_window(live.seven_day, 7 * 86400, now),
        },
        updated_at: now,
    }))
}

// Time of the last live fetch attempt and the last successful result.
static LIVE: Mutex<(i64, Option<RateLimitSnapshot>)> = Mutex::new((0, None));

// Two readings of the same window have reset times within this of each other.
const SAME_WINDOW_SECS: i64 = 300;

// Within one window usage only goes up, so the higher reading is the newer one; a later reset
// time means a newer window.
fn newer_window(a: Option<RateLimitWindow>, b: Option<RateLimitWindow>) -> Option<RateLimitWindow> {
    match (a, b) {
        (Some(a), Some(b)) => {
            if (a.resets_at - b.resets_at).abs() > SAME_WINDOW_SECS {
                Some(if a.resets_at > b.resets_at { a } else { b })
            } else {
                Some(if a.used_percentage >= b.used_percentage { a } else { b })
            }
        }
        (a, b) => a.or(b),
    }
}

// Prefers the live endpoint (fetched at most every LIVE_MIN_INTERVAL_SECS), merged with
// ~/.claude/rate-limits.json, which ~/.claude/statusline-dashboard.sh writes from the
// `rate_limits` Claude Code passes to its status line. That file can't be trusted on its own:
// each session reports the numbers from its own last API response, and the status line's
// refreshInterval rewrites updated_at every 15s even when nothing changed, so an idle session
// keeps an old reading looking fresh. It only wins where it is provably newer (see newer_window).
#[tauri::command]
pub async fn read_claude_rate_limits() -> Result<Option<RateLimitSnapshot>, String> {
    let dir = claude_dir()?;
    let now = Utc::now().timestamp();

    let file: Option<RateLimitSnapshot> = match fs::read_to_string(dir.join("rate-limits.json")) {
        Ok(content) => Some(serde_json::from_str(&content).map_err(|e| format!("bad rate-limits.json: {e}"))?),
        Err(_) => None,
    };

    let due = {
        let mut live = LIVE.lock().unwrap();
        let due = now - live.0 >= LIVE_MIN_INTERVAL_SECS;
        if due {
            live.0 = now;
        }
        due
    };
    if due {
        match fetch_live_rate_limits(&dir).await {
            Ok(Some(snapshot)) => LIVE.lock().unwrap().1 = Some(snapshot),
            Ok(None) => {}
            Err(e) => eprintln!("live Claude usage unavailable, using last snapshot: {e}"),
        }
    }
    let live = LIVE.lock().unwrap().1.clone();

    let mut snapshot = match (live, file) {
        (Some(live), Some(file)) => RateLimitSnapshot {
            rate_limits: RateLimits {
                five_hour: newer_window(live.rate_limits.five_hour, file.rate_limits.five_hour),
                seven_day: newer_window(live.rate_limits.seven_day, file.rate_limits.seven_day),
            },
            updated_at: live.updated_at,
        },
        (Some(s), None) | (None, Some(s)) => s,
        (None, None) => return Ok(None),
    };
    // A window whose reset time has passed has rolled over; the stale percentage no longer applies.
    for window in [&mut snapshot.rate_limits.five_hour, &mut snapshot.rate_limits.seven_day] {
        if let Some(w) = window {
            if w.resets_at <= now {
                w.used_percentage = 0.0;
            }
        }
    }
    Ok(Some(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(used: f64, resets_at: i64) -> Option<RateLimitWindow> {
        Some(RateLimitWindow { used_percentage: used, resets_at })
    }

    #[test]
    fn same_window_takes_the_higher_reading() {
        // Live reports 15:59:59.94 where the status line rounds to 16:00:00.
        let merged = newer_window(w(56.0, 1_791_820_799), w(36.0, 1_791_820_800)).unwrap();
        assert_eq!(merged.used_percentage, 56.0);
        let merged = newer_window(w(30.0, 1_791_820_799), w(36.0, 1_791_820_800)).unwrap();
        assert_eq!(merged.used_percentage, 36.0);
    }

    #[test]
    fn later_window_wins_even_when_lower() {
        let merged = newer_window(w(90.0, 1_000_000), w(4.0, 1_018_000)).unwrap();
        assert_eq!(merged.used_percentage, 4.0);
    }

    #[test]
    fn missing_side_falls_back_to_the_other() {
        assert_eq!(newer_window(None, w(12.0, 1)).unwrap().used_percentage, 12.0);
        assert!(newer_window(None, None).is_none());
    }
}
