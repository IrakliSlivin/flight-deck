use futures::stream::{self, StreamExt};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const DEFAULT_BASE_URL: &str = "https://gitlab.com";
const REQUEST_TIMEOUT_SECS: u64 = 15;
const MAX_CONCURRENT_REQUESTS: usize = 16;
const USER_CACHE_TTL_SECS: u64 = 24 * 60 * 60;

fn new_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

fn get_token() -> Result<String, String> {
    Entry::new(SERVICE, "gitlab.api_token")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "GitLab access token not set. Add it in Settings.".to_string())
}

/// `https://gitlab.com` unless a self-hosted URL is configured. Accepts a
/// pasted `/api/v4` suffix or trailing slash.
fn api_base() -> String {
    let base = Entry::new(SERVICE, "gitlab.base_url")
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let base = base.trim_end_matches('/');
    let base = base.strip_suffix("/api/v4").unwrap_or(base);
    format!("{base}/api/v4")
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitLab API error ({status}) calling {url}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse GitLab response: {e}"))
}

/// Same shape as `BitbucketPr`, so the PRs tab can merge both sources.
#[derive(Debug, Serialize, Clone)]
pub struct GitlabMr {
    pub id: i64,
    pub title: String,
    pub author: String,
    pub source_repo: String,
    pub url: String,
    pub updated_on: String,
    pub draft: bool,
    pub approved_count: i64,
    pub reviewers_total: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitlabMrs {
    pub authored: Vec<GitlabMr>,
    pub reviewing: Vec<GitlabMr>,
}

#[derive(Deserialize)]
struct GlUser {
    id: i64,
}

// --- User-id cache (refreshed at most once every 24h). Keyed by the API base
// and a fingerprint of the token, so switching instance or token refetches.
// Only a hash of the token is written, never the token itself.

#[derive(Serialize, Deserialize)]
struct UserCache {
    base: String,
    token_hash: u64,
    user_id: i64,
    fetched_at_secs: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn token_hash(token: &str) -> u64 {
    let mut h = DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn user_cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("gitlab_user_cache.json"))
}

/// Your user id, from cache if fresh and still matching base + token,
/// otherwise from `GET /user`.
async fn my_user_id(app: &tauri::AppHandle, client: &reqwest::Client, base: &str, token: &str) -> Result<i64, String> {
    let path = user_cache_path(app);
    let hash = token_hash(token);
    let now = now_secs();
    let cached: Option<UserCache> = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    if let Some(c) = cached {
        if c.base == base && c.token_hash == hash && now.saturating_sub(c.fetched_at_secs) < USER_CACHE_TTL_SECS {
            return Ok(c.user_id);
        }
    }

    let me: GlUser = get_json(client, &format!("{base}/user"), token).await?;
    if let Some(p) = path {
        let entry = UserCache { base: base.to_string(), token_hash: hash, user_id: me.id, fetched_at_secs: now };
        if let Ok(json) = serde_json::to_string(&entry) {
            let _ = std::fs::write(p, json);
        }
    }
    Ok(me.id)
}

#[derive(Deserialize)]
struct RawMr {
    iid: i64,
    project_id: i64,
    title: String,
    author: RawAuthor,
    web_url: String,
    updated_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    references: Option<RawRefs>,
    #[serde(default)]
    reviewers: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct RawAuthor {
    id: i64,
    name: String,
}
#[derive(Deserialize)]
struct RawRefs {
    full: String,
}

#[derive(Deserialize, Default)]
struct RawApprovals {
    #[serde(default)]
    approved_by: Vec<RawApprover>,
}
#[derive(Deserialize)]
struct RawApprover {
    user: GlUser,
}

/// `group/sub/project` from `group/sub/project!12`, falling back to the web URL.
fn project_path(mr: &RawMr) -> String {
    if let Some(r) = &mr.references {
        if let Some((path, _)) = r.full.rsplit_once('!') {
            return path.to_string();
        }
    }
    mr.web_url
        .split("/-/merge_requests")
        .next()
        .and_then(|u| u.splitn(4, '/').nth(3))
        .unwrap_or_default()
        .to_string()
}

/// The MR list doesn't include approvals, so each MR needs one extra request.
/// A failure (e.g. approvals unavailable on this instance) counts as none.
async fn approver_ids(client: &reqwest::Client, base: &str, token: &str, mr: &RawMr) -> Vec<i64> {
    let url = format!(
        "{base}/projects/{}/merge_requests/{}/approvals",
        mr.project_id, mr.iid
    );
    get_json::<RawApprovals>(client, &url, token)
        .await
        .unwrap_or_default()
        .approved_by
        .into_iter()
        .map(|a| a.user.id)
        .collect()
}

async fn list_mrs(client: &reqwest::Client, base: &str, token: &str, filter: &str) -> Result<Vec<RawMr>, String> {
    let url = format!("{base}/merge_requests?state=opened&per_page=100&{filter}");
    get_json(client, &url, token).await
}

/// Fetches approvals for every MR concurrently, keeping MRs for which `keep`
/// (given the approver ids) is true.
async fn with_approvals(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    mrs: Vec<RawMr>,
    keep: impl Fn(&RawMr, &[i64]) -> bool,
) -> Vec<GitlabMr> {
    let fetched: Vec<(RawMr, Vec<i64>)> = stream::iter(mrs)
        .map(|mr| async move {
            let ids = approver_ids(client, base, token, &mr).await;
            (mr, ids)
        })
        .buffered(MAX_CONCURRENT_REQUESTS)
        .collect()
        .await;
    fetched
        .into_iter()
        .filter(|(mr, ids)| keep(mr, ids))
        .map(|(mr, ids)| GitlabMr {
            id: mr.iid,
            source_repo: project_path(&mr),
            title: mr.title,
            author: mr.author.name,
            url: mr.web_url,
            updated_on: mr.updated_at,
            draft: mr.draft,
            approved_count: ids.len() as i64,
            reviewers_total: mr.reviewers.len() as i64,
        })
        .collect()
}

#[tauri::command]
pub async fn fetch_gitlab_prs(app: tauri::AppHandle) -> Result<GitlabMrs, String> {
    let token = get_token()?;
    let base = api_base();
    let client = new_client();

    let my_id = my_user_id(&app, &client, &base, &token).await?;

    let reviewer_filter = format!("scope=all&reviewer_id={my_id}");
    let assignee_filter = format!("scope=all&assignee_id={my_id}");
    let (authored, as_reviewer, as_assignee) = futures::try_join!(
        list_mrs(&client, &base, &token, "scope=created_by_me"),
        list_mrs(&client, &base, &token, &reviewer_filter),
        list_mrs(&client, &base, &token, &assignee_filter),
    )?;

    // "Awaiting your review": you're a listed reviewer or the assignee, it
    // isn't yours, and you haven't approved it yet. Drafts are kept; the PRs
    // tab shows them in their own quiet group.
    let mut seen = std::collections::HashSet::new();
    let reviewing: Vec<RawMr> = as_reviewer
        .into_iter()
        .chain(as_assignee)
        .filter(|mr| mr.author.id != my_id)
        .filter(|mr| seen.insert((mr.project_id, mr.iid)))
        .collect();

    let (authored, reviewing) = futures::join!(
        with_approvals(&client, &base, &token, authored, |_, _| true),
        with_approvals(&client, &base, &token, reviewing, |_, ids| !ids.contains(&my_id)),
    );

    Ok(GitlabMrs { authored, reviewing })
}

#[derive(Deserialize)]
struct GlNamedUser {
    username: String,
}

/// Settings' "Save & connect": confirms the token works and says who it belongs to.
#[tauri::command]
pub async fn check_gitlab() -> Result<String, String> {
    let token = get_token()?;
    let base = api_base();
    let me: GlNamedUser = get_json(&new_client(), &format!("{base}/user"), &token).await?;
    let host = base
        .trim_end_matches("/api/v4")
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    Ok(format!("@{} on {host}", me.username))
}
