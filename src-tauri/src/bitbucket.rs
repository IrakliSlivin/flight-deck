use futures::future::join_all;
use futures::stream::{self, StreamExt};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const REPO_CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 15;
const MAX_CONCURRENT_REQUESTS: usize = 16;
/// Repos with no push in this many days are skipped when scanning for
/// "awaiting your review" — a dormant repo essentially never has an open PR,
/// and this is the dominant cost once the per-PR detail fetch was removed.
/// Disclosed tradeoff: a PR that's been open >180 days with zero repo
/// activity since would be missed.
const ACTIVE_REPO_WINDOW_DAYS: i64 = 180;

fn is_recently_active(updated_on: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(updated_on) {
        Ok(dt) => {
            let cutoff = chrono::Utc::now() - chrono::Duration::days(ACTIVE_REPO_WINDOW_DAYS);
            dt.with_timezone(&chrono::Utc) > cutoff
        }
        // If we can't parse the timestamp, don't silently drop the repo.
        Err(_) => true,
    }
}

/// Bitbucket's list endpoints omit `draft`/`participants` by default, but
/// its partial-response `fields` param can pull them in directly — this
/// avoids a separate detail request per PR entirely (confirmed empirically;
/// requesting `values.participants` returns the full nested objects).
const PR_FIELDS: &str = "values.id,values.title,values.draft,values.participants,values.author,values.updated_on,values.links.html,values.source.repository.full_name";

fn new_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

fn get_creds() -> Result<(String, String), String> {
    let email = Entry::new(SERVICE, "bitbucket.email")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Bitbucket email not set. Add it in Settings.".to_string())?;
    let token = Entry::new(SERVICE, "bitbucket.api_token")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Bitbucket API token not set. Add it in Settings.".to_string())?;
    Ok((email, token))
}

fn get_optional_secret(key: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, key).ok()?;
    entry.get_password().ok()
}

fn parse_csv_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
    email: &str,
    token: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .basic_auth(email, Some(token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Bitbucket API error ({status}) calling {url}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse Bitbucket response: {e}"))
}

#[derive(Debug, Serialize, Clone)]
pub struct BitbucketPr {
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
pub struct BitbucketPrs {
    pub authored: Vec<BitbucketPr>,
    pub reviewing: Vec<BitbucketPr>,
}

#[derive(Deserialize)]
struct BbUserResponse {
    uuid: String,
}

#[derive(Deserialize)]
struct WorkspacesResponse {
    values: Vec<WorkspaceObj>,
}
#[derive(Deserialize)]
struct WorkspaceObj {
    slug: String,
}

#[derive(Deserialize)]
struct RepositoriesResponse {
    values: Vec<RepoSlugObj>,
    next: Option<String>,
}
#[derive(Deserialize)]
struct RepoSlugObj {
    slug: String,
    #[serde(default)]
    updated_on: Option<String>,
}

#[derive(Deserialize)]
struct PrListResponse {
    values: Vec<RawPr>,
}

/// Fetched via the `fields=` partial-response param (see `PR_FIELDS`), which
/// pulls `participants`/`draft` directly into the list response.
#[derive(Deserialize, Clone)]
struct RawPr {
    id: i64,
    title: String,
    author: RawAuthor,
    source: RawSource,
    links: RawLinks,
    updated_on: String,
    #[serde(default)]
    participants: Vec<RawParticipant>,
    #[serde(default)]
    draft: bool,
}
#[derive(Deserialize, Clone)]
struct RawAuthor {
    display_name: String,
    #[serde(default)]
    uuid: Option<String>,
}
#[derive(Deserialize, Clone)]
struct RawParticipant {
    #[serde(default)]
    approved: bool,
    #[serde(default)]
    role: String,
    user: RawParticipantUser,
}
#[derive(Deserialize, Clone)]
struct RawParticipantUser {
    #[serde(default)]
    uuid: Option<String>,
}
#[derive(Deserialize, Clone)]
struct RawSource {
    repository: RawRepo,
}
#[derive(Deserialize, Clone)]
struct RawRepo {
    full_name: String,
}
#[derive(Deserialize, Clone)]
struct RawLinks {
    html: RawHref,
}
#[derive(Deserialize, Clone)]
struct RawHref {
    href: String,
}

fn to_bitbucket_pr(p: &RawPr) -> BitbucketPr {
    let approved_count = p.participants.iter().filter(|part| part.approved).count() as i64;
    let reviewers_total = p.participants.len() as i64;
    BitbucketPr {
        id: p.id,
        title: p.title.clone(),
        author: p.author.display_name.clone(),
        source_repo: p.source.repository.full_name.clone(),
        url: p.links.html.href.clone(),
        updated_on: p.updated_on.clone(),
        draft: p.draft,
        approved_count,
        reviewers_total,
    }
}

fn i_approved(p: &RawPr, my_uuid: &str) -> bool {
    p.participants
        .iter()
        .any(|part| part.approved && part.user.uuid.as_deref() == Some(my_uuid))
}

/// True if this PR needs your review: not authored by you, not draft, not
/// already approved by you, and you're explicitly listed as a reviewer
/// (`role == "REVIEWER"` in participants). Unlike an earlier version of this
/// function, an unassigned PR is NOT treated as "open to anyone" — that
/// surfaced PRs with zero participants that had nothing to do with you.
fn awaiting_my_review(p: &RawPr, my_uuid: &str) -> bool {
    if p.author.uuid.as_deref() == Some(my_uuid) {
        return false;
    }
    if p.draft || i_approved(p, my_uuid) {
        return false;
    }

    p.participants
        .iter()
        .any(|part| part.role == "REVIEWER" && part.user.uuid.as_deref() == Some(my_uuid))
}

/// Lists every recently-active repo slug in a workspace (see
/// `ACTIVE_REPO_WINDOW_DAYS`), following pagination (Bitbucket caps each page
/// at 100). Requires the `read:repository:bitbucket` scope.
async fn list_all_repo_slugs(
    client: &reqwest::Client,
    email: &str,
    token: &str,
    workspace: &str,
) -> Result<Vec<String>, String> {
    let mut slugs = Vec::new();
    let mut next = Some(format!(
        "https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=100&fields=values.slug,values.updated_on,next"
    ));
    let mut pages = 0;
    while let Some(url) = next {
        pages += 1;
        if pages > 20 {
            break;
        }
        let parsed: RepositoriesResponse = get_json(client, &url, email, token).await?;
        slugs.extend(
            parsed
                .values
                .into_iter()
                .filter(|r| {
                    r.updated_on
                        .as_deref()
                        .map(is_recently_active)
                        .unwrap_or(true)
                })
                .map(|r| r.slug),
        );
        next = parsed.next;
    }
    Ok(slugs)
}

// --- Repo-list cache (refreshed at most once every 24h) ---

#[derive(Serialize, Deserialize, Default)]
struct RepoCacheFile {
    entries: Vec<RepoCacheEntry>,
}
#[derive(Serialize, Deserialize, Clone)]
struct RepoCacheEntry {
    workspace: String,
    slugs: Vec<String>,
    fetched_at_secs: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn repo_cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("bitbucket_repo_cache.json"))
}

fn load_repo_cache(app: &tauri::AppHandle) -> RepoCacheFile {
    let Some(path) = repo_cache_path(app) else {
        return RepoCacheFile::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_repo_cache(app: &tauri::AppHandle, cache: &RepoCacheFile) {
    if let Some(path) = repo_cache_path(app) {
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(path, json);
        }
    }
}

// --- Account cache (uuid + auto-discovered workspaces; refreshed at most
// once every 24h, and invalidated automatically if the configured email
// changes). Your uuid never changes and workspace membership rarely does,
// so there's no reason to hit /2.0/user or /2.0/workspaces every refresh.

#[derive(Serialize, Deserialize)]
struct AccountCache {
    email: String,
    uuid: String,
    workspaces: Option<Vec<String>>,
    fetched_at_secs: u64,
}

fn account_cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("bitbucket_account_cache.json"))
}

fn load_account_cache(app: &tauri::AppHandle) -> Option<AccountCache> {
    let path = account_cache_path(app)?;
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_account_cache(app: &tauri::AppHandle, cache: &AccountCache) {
    if let Some(path) = account_cache_path(app) {
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Returns (uuid, auto-discovered workspaces) from cache if fresh (<24h) and
/// still matching the configured email, otherwise fetches `/2.0/user` and,
/// if workspaces aren't explicitly configured, `/2.0/workspaces` too.
async fn get_account_info(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    email: &str,
    token: &str,
) -> Result<(String, Option<Vec<String>>), String> {
    let now = now_secs();
    if let Some(cache) = load_account_cache(app) {
        if cache.email == email && now.saturating_sub(cache.fetched_at_secs) < REPO_CACHE_TTL_SECS
        {
            return Ok((cache.uuid, cache.workspaces));
        }
    }

    let user: BbUserResponse = get_json(client, "https://api.bitbucket.org/2.0/user", email, token).await?;

    let workspaces = if get_optional_secret("bitbucket.workspace")
        .filter(|s| !s.trim().is_empty())
        .is_none()
    {
        let resp: WorkspacesResponse = get_json(
            client,
            "https://api.bitbucket.org/2.0/workspaces?pagelen=100",
            email,
            token,
        )
        .await?;
        Some(resp.values.into_iter().map(|w| w.slug).collect())
    } else {
        None
    };

    save_account_cache(
        app,
        &AccountCache {
            email: email.to_string(),
            uuid: user.uuid.clone(),
            workspaces: workspaces.clone(),
            fetched_at_secs: now,
        },
    );

    Ok((user.uuid, workspaces))
}

/// Returns cached repo slugs for a workspace if fetched within the last 24h,
/// otherwise re-fetches from the API and updates the cache.
async fn cached_repo_slugs(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    email: &str,
    token: &str,
    workspace: &str,
) -> Result<Vec<String>, String> {
    let mut cache = load_repo_cache(app);
    let now = now_secs();

    if let Some(entry) = cache.entries.iter().find(|e| e.workspace == workspace) {
        if now.saturating_sub(entry.fetched_at_secs) < REPO_CACHE_TTL_SECS {
            return Ok(entry.slugs.clone());
        }
    }

    let slugs = list_all_repo_slugs(client, email, token, workspace).await?;
    cache.entries.retain(|e| e.workspace != workspace);
    cache.entries.push(RepoCacheEntry {
        workspace: workspace.to_string(),
        slugs: slugs.clone(),
        fetched_at_secs: now,
    });
    save_repo_cache(app, &cache);
    Ok(slugs)
}

/// The current Bitbucket API only exposes "pull requests authored by user"
/// at the workspace level — there is no `role` filter anymore (it's silently
/// ignored), so this always returns authored PRs regardless of what's passed.
async fn fetch_authored(
    client: &reqwest::Client,
    email: &str,
    token: &str,
    workspace: &str,
    encoded_uuid: &str,
) -> Result<Vec<BitbucketPr>, String> {
    let url = format!(
        "https://api.bitbucket.org/2.0/workspaces/{workspace}/pullrequests/{encoded_uuid}?state=OPEN&pagelen=50&fields={PR_FIELDS}"
    );
    let parsed: PrListResponse = match get_json(client, &url, email, token).await {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parsed.values.iter().map(to_bitbucket_pr).collect())
}

/// There's no cross-repo "PRs I need to review" endpoint, and this team
/// doesn't use Bitbucket's formal reviewer assignment (it's always empty in
/// practice — people just approve ad hoc). So "awaiting your review" here
/// means: open, non-draft, not authored by you, and you haven't approved it.
async fn fetch_reviewing_in_repo(
    client: &reqwest::Client,
    email: &str,
    token: &str,
    workspace: &str,
    repo_slug: &str,
    my_uuid: &str,
) -> Vec<BitbucketPr> {
    let url = format!(
        "https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/pullrequests?state=OPEN&pagelen=50&fields={PR_FIELDS}"
    );
    let parsed: PrListResponse = match get_json(client, &url, email, token).await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    parsed
        .values
        .iter()
        .filter(|d| awaiting_my_review(d, my_uuid))
        .map(to_bitbucket_pr)
        .collect()
}

#[tauri::command]
pub async fn fetch_bitbucket_prs(app: tauri::AppHandle) -> Result<BitbucketPrs, String> {
    let (email, token) = get_creds()?;
    let client = new_client();

    let (uuid, cached_workspaces) = get_account_info(&app, &client, &email, &token).await?;
    let encoded_uuid = uuid.replace('{', "%7B").replace('}', "%7D");

    let workspace_slugs: Vec<String> = if let Some(configured) =
        get_optional_secret("bitbucket.workspace").filter(|s| !s.trim().is_empty())
    {
        parse_csv_list(&configured)
    } else {
        cached_workspaces.unwrap_or_default()
    };

    let authored_lists = join_all(
        workspace_slugs
            .iter()
            .map(|workspace| fetch_authored(&client, &email, &token, workspace, &encoded_uuid)),
    )
    .await;
    let authored: Vec<BitbucketPr> = authored_lists
        .into_iter()
        .filter_map(Result::ok)
        .flatten()
        .collect();

    // (workspace, repo_slug) pairs to scan for "awaiting your review". If
    // repos are explicitly configured, pair them with every configured
    // workspace; otherwise auto-discover every repo per workspace (cached
    // for 24h, since repo lists rarely change).
    let repo_pairs: Vec<(String, String)> = match get_optional_secret("bitbucket.repos")
        .filter(|s| !s.trim().is_empty())
    {
        Some(repos) => {
            let repo_list = parse_csv_list(&repos);
            workspace_slugs
                .iter()
                .flat_map(|w| repo_list.iter().map(move |r| (w.clone(), r.clone())))
                .collect()
        }
        None => {
            let mut pairs = Vec::new();
            for workspace in &workspace_slugs {
                let slugs = cached_repo_slugs(&app, &client, &email, &token, workspace).await?;
                for slug in slugs {
                    pairs.push((workspace.clone(), slug));
                }
            }
            pairs
        }
    };

    let reviewing: Vec<BitbucketPr> = stream::iter(repo_pairs)
        .map(|(workspace, repo)| {
            let client = client.clone();
            let email = email.clone();
            let token = token.clone();
            let my_uuid = uuid.clone();
            async move { fetch_reviewing_in_repo(&client, &email, &token, &workspace, &repo, &my_uuid).await }
        })
        .buffer_unordered(MAX_CONCURRENT_REQUESTS)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();

    Ok(BitbucketPrs {
        authored,
        reviewing,
    })
}
