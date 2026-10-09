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

// --- One MR's details and diff, for a Claude review (review.rs).

#[derive(Deserialize)]
struct MrDetail {
    title: String,
    #[serde(default)]
    description: Option<String>,
    author: RawAuthor,
    source_branch: String,
    target_branch: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    diff_refs: Option<DiffRefs>,
}

/// The diff version an MR is at; a line comment's position must name it.
#[derive(Deserialize)]
struct DiffRefs {
    base_sha: String,
    start_sha: String,
    head_sha: String,
}

#[derive(Deserialize)]
struct MrFileDiff {
    old_path: String,
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    renamed_file: bool,
    #[serde(default)]
    deleted_file: bool,
    #[serde(default)]
    diff: String,
}

#[derive(Deserialize)]
struct MrChanges {
    changes: Vec<MrFileDiff>,
}

/// The URL-encoded project path and the iid from <host>/<group>/<project>/-/merge_requests/<iid>.
fn parse_mr_url(url: &str) -> Option<(String, i64)> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let (_host, path) = rest.split_once('/')?;
    let (project, tail) = path.split_once("/-/merge_requests/")?;
    let iid = tail.split(['/', '?', '#']).next()?.parse().ok()?;
    Some((project.replace('/', "%2F"), iid))
}

const DIFF_TIMEOUT_SECS: u64 = 60;
const DIFF_PAGE_SIZE: usize = 50;
const MAX_DIFF_PAGES: usize = 40;

/// Every file diff of the MR. `/diffs` (GitLab 15.7+) is paginated; older instances only have
/// `/changes`.
async fn mr_file_diffs(client: &reqwest::Client, mr: &str, token: &str) -> Result<Vec<MrFileDiff>, String> {
    let mut files = Vec::new();
    for page in 1..=MAX_DIFF_PAGES {
        let url = format!("{mr}/diffs?page={page}&per_page={DIFF_PAGE_SIZE}");
        let batch: Vec<MrFileDiff> = match get_json(client, &url, token).await {
            Ok(batch) => batch,
            Err(e) if page == 1 && e.contains("(404") => {
                return Ok(get_json::<MrChanges>(client, &format!("{mr}/changes"), token).await?.changes);
            }
            Err(e) => return Err(e),
        };
        let last = batch.len() < DIFF_PAGE_SIZE;
        files.extend(batch);
        if last {
            break;
        }
    }
    Ok(files)
}

pub(crate) async fn fetch_pr_diff(url: &str) -> Result<crate::review::PrDiff, String> {
    use crate::diff::{parse_hunks, DiffFile, FileStatus};
    let (project, iid) = parse_mr_url(url).ok_or_else(|| format!("Not a GitLab merge request URL: {url}"))?;
    let token = get_token()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DIFF_TIMEOUT_SECS))
        .build()
        .unwrap_or_default();
    let mr = format!("{}/projects/{project}/merge_requests/{iid}", api_base());
    let (detail, files) = futures::join!(get_json::<MrDetail>(&client, &mr, &token), mr_file_diffs(&client, &mr, &token));
    let detail = detail?;
    let files = files?
        .into_iter()
        .map(|f| {
            let status = if f.new_file {
                FileStatus::Added
            } else if f.deleted_file {
                FileStatus::Deleted
            } else if f.renamed_file {
                FileStatus::Renamed
            } else {
                FileStatus::Modified
            };
            // An empty diff is a binary file, or one too large for the API to return.
            let hunks = parse_hunks(&f.diff);
            let binary = hunks.is_empty() && status != FileStatus::Renamed;
            DiffFile::new(&f.old_path, &f.new_path, status, hunks, binary)
        })
        .collect();
    Ok(crate::review::PrDiff {
        title: detail.title,
        description: detail.description.unwrap_or_default(),
        author: detail.author.name,
        source_branch: detail.source_branch,
        dest_branch: detail.target_branch,
        head_sha: detail.sha.unwrap_or_default(),
        base_sha: detail.diff_refs.as_ref().map(|r| r.base_sha.clone()).unwrap_or_default(),
        start_sha: detail.diff_refs.as_ref().map(|r| r.start_sha.clone()).unwrap_or_default(),
        files,
    })
}

#[derive(Deserialize)]
struct NoteId {
    id: i64,
}
#[derive(Deserialize)]
struct Discussion {
    notes: Vec<NoteId>,
}

/// Posts a comment on the MR: a discussion on a line of the reviewed diff when `target` is
/// given, otherwise a note on the MR itself. Returns the comment's URL. Needs the `api` scope.
pub(crate) async fn post_comment(
    url: &str,
    pr: &crate::review::PrDiff,
    body: &str,
    target: Option<&crate::review::CommentTarget>,
) -> Result<String, String> {
    let (project, iid) = parse_mr_url(url).ok_or_else(|| format!("Not a GitLab merge request URL: {url}"))?;
    let token = get_token()?;
    let client = new_client();
    let mr = format!("{}/projects/{project}/merge_requests/{iid}", api_base());
    let (endpoint, payload) = match target {
        None => (format!("{mr}/notes"), serde_json::json!({ "body": body })),
        Some(t) => {
            let (base_sha, start_sha) = if pr.base_sha.is_empty() {
                // Saved before diff refs were kept: usable only while the MR is still at that commit.
                let detail: MrDetail = get_json(&client, &mr, &token).await?;
                match detail.diff_refs {
                    Some(r) if r.head_sha == pr.head_sha => (r.base_sha, r.start_sha),
                    _ => return Err("The MR has new commits since this review. Re-review to comment on lines.".into()),
                }
            } else {
                (pr.base_sha.clone(), pr.start_sha.clone())
            };
            // An unchanged line needs both line numbers; an added or removed one only its own.
            let mut position = serde_json::json!({
                "position_type": "text",
                "base_sha": base_sha,
                "start_sha": start_sha,
                "head_sha": pr.head_sha,
                "old_path": t.old_path,
                "new_path": t.path,
            });
            if let Some(line) = t.old_line {
                position["old_line"] = line.into();
            }
            if let Some(line) = t.new_line {
                position["new_line"] = line.into();
            }
            (format!("{mr}/discussions"), serde_json::json!({ "body": body, "position": position }))
        }
    };
    let resp = client
        .post(&endpoint)
        .header("PRIVATE-TOKEN", &token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.contains("insufficient_scope") {
        return Err(format!("GitLab refused the comment ({status}). {NEEDS_API_SCOPE}"));
    }
    if !status.is_success() {
        return Err(format!("GitLab API error ({status}) posting the comment: {text}"));
    }
    let note = if target.is_some() {
        serde_json::from_str::<Discussion>(&text).ok().and_then(|d| d.notes.first().map(|n| n.id))
    } else {
        serde_json::from_str::<NoteId>(&text).ok().map(|n| n.id)
    };
    Ok(match note {
        Some(id) => format!("{url}#note_{id}"),
        None => url.to_string(),
    })
}

const NEEDS_API_SCOPE: &str = "Your GitLab token is read-only (read_api). Create one with the \"api\" scope \
     and save it under GitLab in Settings.";

/// Approves the MR (at its current head, like Bitbucket), or (request changes) withdraws your
/// approval; GitLab's API has no request-changes state, so the comment carries it. Needs the `api` scope.
pub(crate) async fn set_decision(url: &str, decision: &str) -> Result<(), String> {
    let (project, iid) = parse_mr_url(url).ok_or_else(|| format!("Not a GitLab merge request URL: {url}"))?;
    let token = get_token()?;
    let mr = format!("{}/projects/{project}/merge_requests/{iid}", api_base());
    let (endpoint, payload) = match decision {
        "approve" => (format!("{mr}/approve"), serde_json::json!({})),
        "request_changes" => (format!("{mr}/unapprove"), serde_json::json!({})),
        _ => return Ok(()),
    };
    let resp = new_client()
        .post(&endpoint)
        .header("PRIVATE-TOKEN", &token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() || decision == "request_changes" && status == reqwest::StatusCode::NOT_FOUND {
        return Ok(()); // 404 on unapprove: you hadn't approved
    }
    let text = resp.text().await.unwrap_or_default();
    Err(match status.as_u16() {
        401 | 403 if text.contains("insufficient_scope") => format!("GitLab refused ({status}). {NEEDS_API_SCOPE}"),
        401 | 403 => format!(
            "GitLab refused ({status}): you may have approved already or may not be allowed to approve this MR. {text}"
        ),
        _ => format!("GitLab refused ({status}): {text}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mr_urls() {
        assert_eq!(
            parse_mr_url("https://gitlab.example.com/git/sub/billing/-/merge_requests/7"),
            Some(("git%2Fsub%2Fbilling".into(), 7))
        );
        assert_eq!(
            parse_mr_url("https://gitlab.com/acme/api/-/merge_requests/12/diffs"),
            Some(("acme%2Fapi".into(), 12))
        );
        assert_eq!(parse_mr_url("https://gitlab.com/acme/api/-/issues/3"), None);
    }
}
