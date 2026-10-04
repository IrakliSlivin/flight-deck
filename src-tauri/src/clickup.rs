use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const STATUS_CACHE_TTL_SECS: u64 = 7 * 24 * 60 * 60;

fn get_token() -> Result<String, String> {
    let entry = Entry::new(SERVICE, "clickup.api_token").map_err(|e| e.to_string())?;
    entry
        .get_password()
        .map_err(|_| "ClickUp API token not set. Add it in Settings.".to_string())
}

fn get_optional_secret(key: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, key).ok()?;
    entry.get_password().ok()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Not a security boundary — just enough to detect "did the token change"
/// without ever writing the actual token to disk.
fn fingerprint(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    let resp = client
        .get(url)
        .header("Authorization", token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ClickUp API error ({status}): {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse ClickUp response: {e}"))
}

#[derive(Clone)]
enum ContainerFilter {
    Space(String),
    Folder(String),
    List(String),
}

impl ContainerFilter {
    fn query_param(&self) -> (&'static str, &str) {
        match self {
            ContainerFilter::Space(id) => ("space_ids[]", id.as_str()),
            ContainerFilter::Folder(id) => ("project_ids[]", id.as_str()),
            ContainerFilter::List(id) => ("list_ids[]", id.as_str()),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            ContainerFilter::Space(_) => "space",
            ContainerFilter::Folder(_) => "folder",
            ContainerFilter::List(_) => "list",
        }
    }

    fn id(&self) -> &str {
        match self {
            ContainerFilter::Space(id) | ContainerFilter::Folder(id) | ContainerFilter::List(id) => id,
        }
    }

    fn from_kind_id(kind: &str, id: String) -> Option<Self> {
        match kind {
            "space" => Some(ContainerFilter::Space(id)),
            "folder" => Some(ContainerFilter::Folder(id)),
            "list" => Some(ContainerFilter::List(id)),
            _ => None,
        }
    }
}

/// Pulls out numeric runs (len >= 6, ClickUp ids are long) from a pasted string,
/// e.g. a ClickUp URL of any shape. Order preserved, duplicates removed.
fn extract_candidate_ids(raw: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut current = String::new();
    for c in raw.chars().chain(std::iter::once('/')) {
        if c.is_ascii_digit() {
            current.push(c);
        } else {
            if current.len() >= 6 && !ids.contains(&current) {
                ids.push(current.clone());
            }
            current.clear();
        }
    }
    ids
}

/// Asks the ClickUp API directly whether an id is a Space, Folder, or List,
/// rather than guessing from URL syntax (which varies across ClickUp's view types).
async fn resolve_container_id(
    client: &reqwest::Client,
    token: &str,
    id: &str,
) -> Option<ContainerFilter> {
    let space_url = format!("https://api.clickup.com/api/v2/space/{id}");
    if get_json::<serde_json::Value>(client, &space_url, token)
        .await
        .is_ok()
    {
        return Some(ContainerFilter::Space(id.to_string()));
    }
    let folder_url = format!("https://api.clickup.com/api/v2/folder/{id}");
    if get_json::<serde_json::Value>(client, &folder_url, token)
        .await
        .is_ok()
    {
        return Some(ContainerFilter::Folder(id.to_string()));
    }
    let list_url = format!("https://api.clickup.com/api/v2/list/{id}");
    if get_json::<serde_json::Value>(client, &list_url, token)
        .await
        .is_ok()
    {
        return Some(ContainerFilter::List(id.to_string()));
    }
    None
}

#[derive(Debug, Serialize, Clone)]
pub struct ClickupTask {
    pub id: String,
    pub name: String,
    pub status: String,
    pub due_date: Option<String>,
    pub url: String,
    pub list_id: String,
    pub list_name: String,
}

#[derive(Deserialize)]
struct UserResponse {
    user: UserObj,
}
#[derive(Deserialize)]
struct UserObj {
    id: i64,
}

#[derive(Deserialize)]
struct TeamsResponse {
    teams: Vec<TeamObj>,
}
#[derive(Deserialize)]
struct TeamObj {
    id: String,
}

#[derive(Deserialize)]
struct SpacesResponse {
    spaces: Vec<SpaceObj>,
}
#[derive(Deserialize)]
struct SpaceObj {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct TasksResponse {
    tasks: Vec<RawTask>,
}
#[derive(Deserialize)]
struct RawTask {
    id: String,
    name: String,
    status: RawStatus,
    due_date: Option<String>,
    url: String,
    list: RawList,
}
#[derive(Deserialize)]
struct RawStatus {
    status: String,
}
#[derive(Deserialize)]
struct RawList {
    id: String,
    name: String,
}

// --- Account cache: user id, team ids, and the resolved Space/Folder/List
// filter never change day-to-day. Keyed by a token fingerprint + the raw
// Space field, so it auto-invalidates if either changes. Refreshed at most
// once every 24h.

#[derive(Serialize, Deserialize)]
struct ClickupCache {
    token_fp: u64,
    space_filter: String,
    user_id: i64,
    team_ids: Vec<String>,
    container_kind: Option<String>,
    container_id: Option<String>,
    fetched_at_secs: u64,
}

fn cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("clickup_account_cache.json"))
}

fn load_cache(app: &tauri::AppHandle) -> Option<ClickupCache> {
    let path = cache_path(app)?;
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_cache(app: &tauri::AppHandle, cache: &ClickupCache) {
    if let Some(path) = cache_path(app) {
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Returns (user_id, team_ids, resolved container filter), from cache when
/// fresh (<24h) and the token/space-filter haven't changed, otherwise
/// re-resolves via the ClickUp API and updates the cache.
async fn get_account_info(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    token: &str,
    raw_filter: &Option<String>,
    candidate_ids: &[String],
) -> Result<(i64, Vec<String>, Option<ContainerFilter>), String> {
    let now = now_secs();
    let token_fp = fingerprint(token);
    let space_filter = raw_filter.clone().unwrap_or_default();

    if let Some(cache) = load_cache(app) {
        if cache.token_fp == token_fp
            && cache.space_filter == space_filter
            && now.saturating_sub(cache.fetched_at_secs) < CACHE_TTL_SECS
        {
            let container = cache
                .container_kind
                .as_deref()
                .zip(cache.container_id.clone())
                .and_then(|(kind, id)| ContainerFilter::from_kind_id(kind, id));
            return Ok((cache.user_id, cache.team_ids, container));
        }
    }

    let user: UserResponse =
        get_json(client, "https://api.clickup.com/api/v2/user", token).await?;
    let teams: TeamsResponse =
        get_json(client, "https://api.clickup.com/api/v2/team", token).await?;
    let team_ids: Vec<String> = teams.teams.into_iter().map(|t| t.id).collect();

    let mut container_filter = None;
    for candidate in candidate_ids {
        if let Some(cf) = resolve_container_id(client, token, candidate).await {
            container_filter = Some(cf);
            break;
        }
    }

    if raw_filter.is_some() && !candidate_ids.is_empty() && container_filter.is_none() {
        return Err(format!(
            "Couldn't find a ClickUp Space, Folder, or List matching '{}'. Make sure the API token has access to it.",
            raw_filter.as_ref().unwrap()
        ));
    }

    save_cache(
        app,
        &ClickupCache {
            token_fp,
            space_filter,
            user_id: user.user.id,
            team_ids: team_ids.clone(),
            container_kind: container_filter.as_ref().map(|cf| cf.kind().to_string()),
            container_id: container_filter.as_ref().map(|cf| cf.id().to_string()),
            fetched_at_secs: now,
        },
    );

    Ok((user.user.id, team_ids, container_filter))
}

#[tauri::command]
pub async fn fetch_clickup_tasks(app: tauri::AppHandle) -> Result<Vec<ClickupTask>, String> {
    let token = get_token()?;
    let raw_filter = get_optional_secret("clickup.space_name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let client = reqwest::Client::new();

    let candidate_ids = raw_filter
        .as_deref()
        .map(extract_candidate_ids)
        .unwrap_or_default();

    let (user_id, team_ids, container_filter) =
        get_account_info(&app, &client, &token, &raw_filter, &candidate_ids).await?;

    let use_name_fallback = container_filter.is_none() && candidate_ids.is_empty();

    let mut matched_any_space_by_name = false;
    let mut all = Vec::new();

    for team_id in &team_ids {
        let mut url = format!(
            "https://api.clickup.com/api/v2/team/{team_id}/task?assignees[]={user_id}&include_closed=false&order_by=due_date"
        );

        if let Some(cf) = &container_filter {
            let (param, id) = cf.query_param();
            url.push_str(&format!("&{param}={id}"));
        } else if use_name_fallback {
            if let Some(name) = &raw_filter {
                let spaces_url = format!(
                    "https://api.clickup.com/api/v2/team/{team_id}/space?archived=false"
                );
                let spaces: SpacesResponse = match get_json(&client, &spaces_url, &token).await {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let matching_ids: Vec<String> = spaces
                    .spaces
                    .into_iter()
                    .filter(|s| s.name.eq_ignore_ascii_case(name))
                    .map(|s| s.id)
                    .collect();
                if matching_ids.is_empty() {
                    continue;
                }
                matched_any_space_by_name = true;
                for id in &matching_ids {
                    url.push_str(&format!("&space_ids[]={id}"));
                }
            }
        }

        let parsed: TasksResponse = match get_json(&client, &url, &token).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        for t in parsed.tasks {
            all.push(ClickupTask {
                id: t.id,
                name: t.name,
                status: t.status.status,
                due_date: t.due_date,
                url: t.url,
                list_id: t.list.id,
                list_name: t.list.name,
            });
        }
    }

    if use_name_fallback {
        if let Some(name) = raw_filter {
            if !matched_any_space_by_name {
                return Err(format!(
                    "ClickUp space '{name}' not found in your workspace(s)."
                ));
            }
        }
    }

    Ok(all)
}

// --- Status changes. Every List has its own statuses; they're cached per List
// for a week (keyed by token fingerprint) and dropped early if an update fails.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClickupStatus {
    pub status: String,
    pub color: String,
    /// "open", "custom", "done" or "closed".
    #[serde(rename = "type")]
    pub kind: String,
    pub orderindex: i64,
}

#[derive(Deserialize)]
struct ListResponse {
    statuses: Vec<ClickupStatus>,
}

#[derive(Serialize, Deserialize, Default)]
struct StatusCache {
    token_fp: u64,
    lists: std::collections::HashMap<String, CachedStatuses>,
}

#[derive(Serialize, Deserialize)]
struct CachedStatuses {
    statuses: Vec<ClickupStatus>,
    fetched_at_secs: u64,
}

fn status_cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("clickup_status_cache.json"))
}

fn load_status_cache(app: &tauri::AppHandle, token_fp: u64) -> StatusCache {
    status_cache_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<StatusCache>(&s).ok())
        .filter(|c| c.token_fp == token_fp)
        .unwrap_or(StatusCache { token_fp, ..Default::default() })
}

fn save_status_cache(app: &tauri::AppHandle, cache: &StatusCache) {
    if let Some(path) = status_cache_path(app) {
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(path, json);
        }
    }
}

#[tauri::command]
pub async fn fetch_clickup_list_statuses(
    app: tauri::AppHandle,
    list_id: String,
) -> Result<Vec<ClickupStatus>, String> {
    let token = get_token()?;
    let mut cache = load_status_cache(&app, fingerprint(&token));
    let now = now_secs();
    if let Some(entry) = cache.lists.get(&list_id) {
        if now.saturating_sub(entry.fetched_at_secs) < STATUS_CACHE_TTL_SECS {
            return Ok(entry.statuses.clone());
        }
    }

    let client = reqwest::Client::new();
    let url = format!("https://api.clickup.com/api/v2/list/{list_id}");
    let mut list: ListResponse = get_json(&client, &url, &token).await?;
    list.statuses.sort_by_key(|s| s.orderindex);

    cache.lists.insert(
        list_id,
        CachedStatuses { statuses: list.statuses.clone(), fetched_at_secs: now },
    );
    save_status_cache(&app, &cache);
    Ok(list.statuses)
}

#[tauri::command]
pub async fn update_clickup_task_status(
    app: tauri::AppHandle,
    task_id: String,
    list_id: String,
    status: String,
) -> Result<(), String> {
    let token = get_token()?;
    let resp = reqwest::Client::new()
        .put(format!("https://api.clickup.com/api/v2/task/{task_id}"))
        .header("Authorization", &token)
        .json(&serde_json::json!({ "status": status }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let code = resp.status();
    if code.is_success() {
        return Ok(());
    }

    // The cached statuses may be out of date; refetch them next time.
    let mut cache = load_status_cache(&app, fingerprint(&token));
    if cache.lists.remove(&list_id).is_some() {
        save_status_cache(&app, &cache);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(format!("ClickUp API error ({code}): {body}"))
}
