//! Monthly PR KPIs from Bitbucket, a port of the team's two Ruby services:
//! - review time (`ReadyForReviewPrsService`): business hours from a PR becoming ready for
//!   review to its second approval, for PRs that became ready in the month;
//! - rework (`MergedPrsService`): merged PRs updated in the month that got "changes requested".
//! Computed only on demand; the frontend stores each month in SQLite (`src/lib/prKpi.ts`).

use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Utc, Weekday};
use chrono_tz::Asia::Tbilisi;
use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Emitter;

use crate::bitbucket;

/// Working hours in Tbilisi time, as in the Ruby service.
const WORK_START: u32 = 9;
const WORK_END: u32 = 18;
const REQUIRED_APPROVALS: usize = 2;
/// Kept below the PRs tab's 16: a month means a few hundred requests in one go.
const MAX_CONCURRENT_REQUESTS: usize = 8;
/// Repos with no push this long before the month starts can't have a PR in it.
const REPO_IDLE_DAYS: i64 = 90;
const MAX_PAGES: usize = 20;
/// Only what the KPIs read; `next` has to be asked for once `fields` is set.
const LIST_FIELDS: &str =
    "next,values.id,values.title,values.created_on,values.author,values.participants,values.links.html";

#[derive(Deserialize)]
struct Page<T> {
    values: Vec<T>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct RawPr {
    id: i64,
    title: String,
    created_on: String,
    #[serde(default)]
    author: RawUser,
    #[serde(default)]
    participants: Vec<RawParticipant>,
    links: RawLinks,
}
#[derive(Deserialize, Default)]
struct RawUser {
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    uuid: Option<String>,
}
#[derive(Deserialize)]
struct RawParticipant {
    #[serde(default)]
    approved: bool,
    #[serde(default)]
    participated_on: Option<String>,
}
#[derive(Deserialize)]
struct RawLinks {
    html: RawHref,
}
#[derive(Deserialize)]
struct RawHref {
    href: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ReadyPr {
    /// workspace/slug
    pub repo: String,
    pub id: i64,
    pub title: String,
    pub author: String,
    pub author_uuid: String,
    pub url: String,
    pub ready_on: String,
    /// The second approval; None when it hasn't come, and the review time runs until now.
    pub approved_on: Option<String>,
    /// Business seconds (Mon–Fri 9–18 Tbilisi, Georgian holidays off).
    pub review_seconds: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct MergedPr {
    pub repo: String,
    pub id: i64,
    pub title: String,
    pub author: String,
    pub author_uuid: String,
    pub url: String,
    /// Someone requested changes on it.
    pub rework: bool,
}

#[derive(Debug, Serialize)]
pub struct PrKpi {
    /// YYYY-MM
    pub month: String,
    /// Your Bitbucket uuid, to pick out your own numbers.
    pub me: String,
    pub repos: usize,
    pub ready: Vec<ReadyPr>,
    pub merged: Vec<MergedPr>,
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    month: &'a str,
    step: &'a str,
    done: usize,
    total: usize,
}

/// The month's start and the next month's start, at midnight Tbilisi time.
fn month_bounds(month: &str) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let first = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").ok()?;
    let next = first.checked_add_months(chrono::Months::new(1))?;
    let midnight = |d: NaiveDate| {
        Tbilisi
            .from_local_datetime(&d.and_hms_opt(0, 0, 0)?)
            .single()
            .map(|t| t.with_timezone(&Utc))
    };
    Some((midnight(first)?, midnight(next)?))
}

/// Orthodox Easter Sunday (Meeus' Julian algorithm, shifted 13 days to the Gregorian calendar,
/// right for 1900–2099).
fn orthodox_easter(year: i32) -> NaiveDate {
    let (a, b, c) = (year % 4, year % 7, year % 19);
    let d = (19 * c + 15) % 30;
    let e = (2 * a + 4 * b - d + 34) % 7;
    let month = (d + e + 114) / 31;
    let day = (d + e + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32).expect("valid Julian Easter") + Duration::days(13)
}

/// Georgian public holidays: the fixed ones plus Good Friday to Easter Monday.
fn is_holiday(date: NaiveDate) -> bool {
    const FIXED: [(u32, u32); 13] = [
        (1, 1),
        (1, 2),
        (1, 7),
        (1, 19),
        (3, 3),
        (3, 8),
        (4, 9),
        (5, 9),
        (5, 12),
        (5, 26),
        (8, 28),
        (10, 14),
        (11, 23),
    ];
    if FIXED.contains(&(date.month(), date.day())) {
        return true;
    }
    let easter = orthodox_easter(date.year());
    (-2..=1).any(|offset| easter + Duration::days(offset) == date)
}

/// Seconds between two instants that fall in working hours on working days, Tbilisi time.
fn business_seconds(from: DateTime<Utc>, to: DateTime<Utc>) -> i64 {
    if to <= from {
        return 0;
    }
    let (from, to) = (from.with_timezone(&Tbilisi), to.with_timezone(&Tbilisi));
    let at = |date: NaiveDate, hour: u32| Tbilisi.from_local_datetime(&date.and_hms_opt(hour, 0, 0)?).single();
    let mut total = 0;
    let mut date = from.date_naive();
    while date <= to.date_naive() {
        let weekend = matches!(date.weekday(), Weekday::Sat | Weekday::Sun);
        if !weekend && !is_holiday(date) {
            if let (Some(day_start), Some(day_end)) = (at(date, WORK_START), at(date, WORK_END)) {
                let (start, end) = (from.max(day_start), to.min(day_end));
                if end > start {
                    total += (end - start).num_seconds();
                }
            }
        }
        date = date.succ_opt().expect("date in range");
    }
    total
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// When the PR left draft: a PR whose first activity is a draft update became ready at its
/// first later non-draft OPEN update; any other PR was ready when it was created.
/// `activity` is newest first, as Bitbucket returns it.
fn ready_for_review_on(activity: &[Value], created_on: &str) -> Option<DateTime<Utc>> {
    let created_as_draft = activity.last().map(|a| a["update"]["draft"] == true).unwrap_or(false);
    if !created_as_draft {
        return parse_time(created_on);
    }
    activity
        .iter()
        .rev()
        .map(|a| &a["update"])
        .find(|u| u["state"] == "OPEN" && u["draft"] == false)
        .and_then(|u| parse_time(u["date"].as_str()?))
}

/// The last approval once there are at least two, by the approvers' `participated_on`.
fn approved_on(participants: &[RawParticipant]) -> Option<DateTime<Utc>> {
    let mut approvals: Vec<DateTime<Utc>> = participants
        .iter()
        .filter(|p| p.approved)
        .filter_map(|p| parse_time(p.participated_on.as_deref()?))
        .collect();
    approvals.sort();
    (approvals.len() >= REQUIRED_APPROVALS).then(|| *approvals.last().unwrap())
}

/// Bitbucket's get_json, retried with backoff on rate limits, 5xx and network errors.
async fn get_retry<T: DeserializeOwned>(client: &reqwest::Client, url: &str, email: &str, token: &str) -> Result<T, String> {
    let mut wait = 2;
    loop {
        match bitbucket::get_json(client, url, email, token).await {
            Err(e) if wait <= 16 && (e.contains("(429") || !(e.contains("(4") || e.starts_with("Failed to parse"))) => {
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                wait *= 2;
            }
            result => return result,
        }
    }
}

async fn get_all<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: String,
    email: &str,
    token: &str,
) -> Result<Vec<T>, String> {
    let mut items = Vec::new();
    let mut next = Some(url);
    let mut pages = 0;
    while let Some(url) = next {
        pages += 1;
        if pages > MAX_PAGES {
            break;
        }
        let page: Page<T> = get_retry(client, &url, email, token).await?;
        items.extend(page.values);
        next = page.next;
    }
    Ok(items)
}

fn pr_list_url(repo: &str, states: &[&str], q: &str) -> String {
    let mut url = reqwest::Url::parse(&format!("https://api.bitbucket.org/2.0/repositories/{repo}/pullrequests"))
        .expect("valid URL");
    {
        let mut query = url.query_pairs_mut();
        for state in states {
            query.append_pair("state", state);
        }
        query
            .append_pair("q", q)
            .append_pair("pagelen", "50")
            .append_pair("fields", LIST_FIELDS);
    }
    url.to_string()
}

#[tauri::command]
pub async fn compute_pr_kpi(app: tauri::AppHandle, month: String) -> Result<PrKpi, String> {
    let (from, to) = month_bounds(&month).ok_or_else(|| format!("Not a month: {month} (expected YYYY-MM)"))?;
    let (email, token) = bitbucket::get_creds()?;
    let client = bitbucket::new_client();
    let progress = |step: &str, done: usize, total: usize| {
        let _ = app.emit("pr-kpi-progress", Progress { month: &month, step, done, total });
    };

    progress("Listing repositories", 0, 0);
    let (me, workspaces) = bitbucket::account_workspaces(&app, &client, &email, &token).await?;
    if workspaces.is_empty() {
        return Err("No Bitbucket workspace found. Pick one in Settings.".into());
    }
    let mut repos = Vec::new();
    for workspace in &workspaces {
        let slugs =
            bitbucket::repos_updated_since(&client, &email, &token, workspace, from - Duration::days(REPO_IDLE_DAYS))
                .await?;
        repos.extend(slugs.into_iter().map(|slug| format!("{workspace}/{slug}")));
    }

    // The two services' queries, with the month's end exclusive.
    let (f, t) = (iso(from), iso(to));
    let ready_q = format!(r#"updated_on >= "{f}" AND created_on < "{t}" AND draft = false AND state != "DECLINED""#);
    let merged_q = format!(r#"updated_on >= "{f}" AND updated_on < "{t}" AND draft = false AND state = "MERGED""#);

    let done = AtomicUsize::new(0);
    progress("Reading pull requests", 0, repos.len());
    let lists: Vec<Result<(String, Vec<RawPr>, Vec<RawPr>), String>> = stream::iter(repos.clone())
        .map(|repo| {
            let (client, email, token, ready_q, merged_q, done) = (&client, &email, &token, &ready_q, &merged_q, &done);
            let progress = &progress;
            let total = repos.len();
            async move {
                let ready = get_all(client, pr_list_url(&repo, &["OPEN", "MERGED"], ready_q), email, token).await?;
                let merged = get_all(client, pr_list_url(&repo, &["MERGED"], merged_q), email, token).await?;
                progress("Reading pull requests", done.fetch_add(1, Ordering::Relaxed) + 1, total);
                Ok((repo, ready, merged))
            }
        })
        .buffer_unordered(MAX_CONCURRENT_REQUESTS)
        .collect()
        .await;
    let lists = lists.into_iter().collect::<Result<Vec<_>, _>>()?;

    // Each PR's activity once, even when it's in both lists.
    let mut wanted: Vec<(String, i64)> = lists
        .iter()
        .flat_map(|(repo, ready, merged)| ready.iter().chain(merged).map(move |pr| (repo.clone(), pr.id)))
        .collect();
    wanted.sort();
    wanted.dedup();
    done.store(0, Ordering::Relaxed);
    progress("Reading PR activity", 0, wanted.len());
    let activities: Vec<Result<((String, i64), Vec<Value>), String>> = stream::iter(wanted.iter().cloned())
        .map(|(repo, id)| {
            let (client, email, token, done) = (&client, &email, &token, &done);
            let progress = &progress;
            let total = wanted.len();
            async move {
                let url = format!("https://api.bitbucket.org/2.0/repositories/{repo}/pullrequests/{id}/activity?pagelen=50");
                let activity = get_all(client, url, email, token).await?;
                progress("Reading PR activity", done.fetch_add(1, Ordering::Relaxed) + 1, total);
                Ok(((repo, id), activity))
            }
        })
        .buffer_unordered(MAX_CONCURRENT_REQUESTS)
        .collect()
        .await;
    let activities: HashMap<(String, i64), Vec<Value>> = activities.into_iter().collect::<Result<_, _>>()?;

    let now = Utc::now();
    let mut ready_prs = Vec::new();
    let mut merged_prs = Vec::new();
    for (repo, ready, merged) in lists {
        for pr in ready {
            let activity = activities.get(&(repo.clone(), pr.id)).map(Vec::as_slice).unwrap_or_default();
            let Some(ready_on) = ready_for_review_on(activity, &pr.created_on) else {
                continue;
            };
            if ready_on < from || ready_on >= to {
                continue;
            }
            let approved = approved_on(&pr.participants);
            ready_prs.push(ReadyPr {
                repo: repo.clone(),
                id: pr.id,
                title: pr.title,
                author: pr.author.display_name,
                author_uuid: pr.author.uuid.unwrap_or_default(),
                url: pr.links.html.href,
                ready_on: iso(ready_on),
                approved_on: approved.map(iso),
                review_seconds: business_seconds(ready_on, approved.unwrap_or(now)),
            });
        }
        for pr in merged {
            let activity = activities.get(&(repo.clone(), pr.id)).map(Vec::as_slice).unwrap_or_default();
            merged_prs.push(MergedPr {
                repo: repo.clone(),
                id: pr.id,
                title: pr.title,
                author: pr.author.display_name,
                author_uuid: pr.author.uuid.unwrap_or_default(),
                url: pr.links.html.href,
                rework: activity.iter().any(|a| a.get("changes_requested").is_some()),
            });
        }
    }
    ready_prs.sort_by(|a, b| a.ready_on.cmp(&b.ready_on));
    merged_prs.sort_by(|a, b| (&a.repo, a.id).cmp(&(&b.repo, b.id)));

    Ok(PrKpi { month, me, repos: repos.len(), ready: ready_prs, merged: merged_prs })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn utc(s: &str) -> DateTime<Utc> {
        parse_time(s).unwrap()
    }

    #[test]
    fn orthodox_easter_dates() {
        assert_eq!(orthodox_easter(2025), NaiveDate::from_ymd_opt(2025, 4, 20).unwrap());
        assert_eq!(orthodox_easter(2026), NaiveDate::from_ymd_opt(2026, 4, 12).unwrap());
        assert_eq!(orthodox_easter(2027), NaiveDate::from_ymd_opt(2027, 5, 2).unwrap());
    }

    #[test]
    fn holidays_match_the_2026_list() {
        let list = [
            (1, 1), (1, 2), (1, 7), (1, 19), (3, 3), (3, 8), (4, 9), (4, 10), (4, 11), (4, 12), (4, 13),
            (5, 9), (5, 12), (5, 26), (8, 28), (10, 14), (11, 23),
        ];
        let mut found = Vec::new();
        let mut d = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        while d.year() == 2026 {
            if is_holiday(d) {
                found.push((d.month(), d.day()));
            }
            d = d.succ_opt().unwrap();
        }
        assert_eq!(found, list);
    }

    #[test]
    fn month_bounds_are_tbilisi_midnights() {
        let (from, to) = month_bounds("2026-09").unwrap();
        assert_eq!(iso(from), "2026-08-31T20:00:00Z");
        assert_eq!(iso(to), "2026-09-30T20:00:00Z");
        assert!(month_bounds("2026-13").is_none());
    }

    #[test]
    fn business_seconds_skip_nights_weekends_and_holidays() {
        // Fri 2026-10-09 17:00 Tbilisi → Mon 2026-10-12 10:00 Tbilisi: 1h + 1h.
        assert_eq!(business_seconds(utc("2026-10-09T13:00:00Z"), utc("2026-10-12T06:00:00Z")), 2 * 3600);
        // Tue 2026-10-13 08:00 → Wed 10-14 (Svetitskhovloba) → Thu 10-15 09:30: 9h + 0 + 0.5h.
        assert_eq!(business_seconds(utc("2026-10-13T04:00:00Z"), utc("2026-10-15T05:30:00Z")), 9 * 3600 + 1800);
        // Same day, evening only.
        assert_eq!(business_seconds(utc("2026-10-12T15:00:00Z"), utc("2026-10-12T17:00:00Z")), 0);
        assert_eq!(business_seconds(utc("2026-10-12T10:00:00Z"), utc("2026-10-12T09:00:00Z")), 0);
    }

    #[test]
    fn ready_for_review_from_activity() {
        // Not created as a draft: ready when created.
        let activity = vec![json!({ "approval": {} }), json!({ "update": { "draft": false, "state": "OPEN", "date": "2026-09-02T08:00:00Z" } })];
        assert_eq!(ready_for_review_on(&activity, "2026-09-01T08:00:00Z"), Some(utc("2026-09-01T08:00:00Z")));

        // Created as a draft (newest first): ready at the first non-draft OPEN update.
        let activity = vec![
            json!({ "update": { "draft": false, "state": "OPEN", "date": "2026-09-05T08:00:00Z" } }),
            json!({ "comment": {} }),
            json!({ "update": { "draft": false, "state": "OPEN", "date": "2026-09-03T08:00:00Z" } }),
            json!({ "update": { "draft": true, "state": "OPEN", "date": "2026-09-01T08:00:00Z" } }),
        ];
        assert_eq!(ready_for_review_on(&activity, "2026-09-01T08:00:00Z"), Some(utc("2026-09-03T08:00:00Z")));

        // Still a draft.
        let activity = vec![json!({ "update": { "draft": true, "state": "OPEN", "date": "2026-09-01T08:00:00Z" } })];
        assert_eq!(ready_for_review_on(&activity, "2026-09-01T08:00:00Z"), None);
    }

    #[test]
    fn second_approval_counts() {
        let p = |approved, on: &str| RawParticipant { approved, participated_on: Some(on.into()) };
        assert_eq!(approved_on(&[p(true, "2026-09-02T08:00:00Z"), p(false, "2026-09-04T08:00:00Z")]), None);
        assert_eq!(
            approved_on(&[p(true, "2026-09-03T08:00:00Z"), p(true, "2026-09-02T08:00:00Z")]),
            Some(utc("2026-09-03T08:00:00Z"))
        );
    }
}
