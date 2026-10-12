//! Stats tab: your commits over the last 12 weeks, read from local clones with `git log`
//! (no network). Which repos to read is picked in Settings → Repositories, from candidates found
//! in Claude Code's project history and JetBrains' recent projects, plus paths you add.
//! The choice lives in `git_stats_settings.json` in the app data dir.

use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

use crate::review::generated_kind;

/// Heatmap span: this week plus the 11 before it.
const WEEKS: i64 = 12;
/// How deep "Add path" looks for repos under a folder.
const SCAN_DEPTH: usize = 3;
/// Session lines read per Claude project before giving up on finding its `cwd`.
const CWD_LINES: usize = 200;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct GitStatsSettings {
    /// Selected repo roots; the Stats tab is hidden while this is empty.
    repos: Vec<String>,
    /// Repos added by hand, kept in the list even when unticked.
    manual: Vec<String>,
    /// Extra author emails, on top of each repo's `user.email`.
    emails: Vec<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("git_stats_settings.json"))
}

fn load_settings(app: &AppHandle) -> GitStatsSettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_git_stats_settings(app: AppHandle) -> Result<GitStatsSettings, String> {
    Ok(load_settings(&app))
}

#[tauri::command]
pub async fn set_git_stats_settings(app: AppHandle, mut settings: GitStatsSettings) -> Result<(), String> {
    for list in [&mut settings.repos, &mut settings.manual, &mut settings.emails] {
        let mut seen = HashSet::new();
        list.retain(|v| !v.trim().is_empty() && seen.insert(v.clone()));
    }
    let path = settings_path(&app).ok_or("app data directory unavailable")?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// ---------- discovery ----------

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(Into::into)
}

fn expand_home(raw: &str) -> PathBuf {
    match (raw.strip_prefix("~/"), home()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ if raw == "~" => home().unwrap_or_else(|| raw.into()),
        _ => raw.into(),
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repo root containing `path` (walking up to the nearest `.git`), if any.
fn repo_root(path: &Path) -> Option<PathBuf> {
    let home = home();
    let mut dir = path;
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        // A dotfiles repo in $HOME would claim every project below it.
        if Some(dir) == home.as_deref() {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// `git@bitbucket.org:acme/billing.git` → `bitbucket.org/acme/billing`.
fn short_remote(url: &str) -> String {
    let url = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    // scp-style `host:owner/repo`; a `host:port/` stays as it is.
    match rest.split_once(':') {
        Some((host, path)) if !path.starts_with(|c: char| c.is_ascii_digit()) => format!("{host}/{path}"),
        _ => rest.to_string(),
    }
}

/// Working directories of Claude Code sessions, with when each project was last used.
fn claude_project_dirs() -> Vec<(PathBuf, i64)> {
    let Some(root) = home().map(|h| h.join(".claude").join("projects")) else {
        return Vec::new();
    };
    let Ok(projects) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for project in projects.flatten() {
        // The newest session is enough: every session of a project shares its cwd.
        let newest = std::fs::read_dir(project.path())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .max();
        let Some((modified, file)) = newest else { continue };
        let Ok(f) = std::fs::File::open(&file) else { continue };
        let cwd = BufReader::new(f).lines().take(CWD_LINES).map_while(Result::ok).find_map(|line| {
            let v: serde_json::Value = serde_json::from_str(&line).ok()?;
            v.get("cwd")?.as_str().map(PathBuf::from)
        });
        let secs = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if let Some(cwd) = cwd {
            out.push((cwd, secs));
        }
    }
    out
}

/// Projects in any JetBrains IDE's recent list (RubyMine, IntelliJ, WebStorm, ...).
fn jetbrains_project_dirs() -> Vec<(PathBuf, i64)> {
    let Some(home) = home() else { return Vec::new() };
    let roots = [
        home.join(".config/JetBrains"),
        home.join("Library/Application Support/JetBrains"),
    ];
    let mut out = Vec::new();
    for ide in roots.iter().filter_map(|r| std::fs::read_dir(r).ok()).flatten().flatten() {
        let file = ide.path().join("options/recentProjects.xml");
        let Ok(xml) = std::fs::read_to_string(file) else { continue };
        // `<entry key="$USER_HOME$/Work/app">` ... `<option name="activationTimestamp" value="…"/>`
        for chunk in xml.split("<entry key=\"").skip(1) {
            let Some((key, body)) = chunk.split_once('"') else { continue };
            let path = key.replace("$USER_HOME$", &home.to_string_lossy());
            if !path.starts_with('/') {
                continue;
            }
            let opened = body
                .split_once("name=\"activationTimestamp\" value=\"")
                .and_then(|(_, rest)| rest.split('"').next()?.parse::<i64>().ok())
                .map_or(0, |ms| ms / 1000);
            out.push((PathBuf::from(path), opened));
        }
    }
    out
}

#[derive(Serialize)]
pub struct RepoCandidate {
    path: String,
    name: String,
    /// Short `host/owner/repo` of `origin`.
    remote: Option<String>,
    /// The `user.email` your commits there are matched on.
    email: Option<String>,
    /// Where it was found: "claude", "jetbrains", "added".
    sources: Vec<String>,
    /// Unix seconds it was last opened in Claude Code or the IDE.
    last_used: i64,
}

fn describe(path: &Path, sources: Vec<String>, last_used: i64) -> RepoCandidate {
    let remote = git(path, &["config", "--get", "remote.origin.url"]).ok().map(|u| short_remote(&u));
    let email = git(path, &["config", "user.email"])
        .ok()
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    RepoCandidate {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned()),
        remote,
        email,
        sources,
        last_used,
    }
}

/// Repos to offer in Settings: found automatically, added by hand, or already selected.
#[tauri::command]
pub async fn discover_git_repos(app: AppHandle) -> Result<Vec<RepoCandidate>, String> {
    let settings = load_settings(&app);
    tauri::async_runtime::spawn_blocking(move || {
        // root → (sources, last used)
        let mut found: BTreeMap<PathBuf, (Vec<String>, i64)> = BTreeMap::new();
        let mut add = |dir: &Path, source: &str, used: i64| {
            let Some(root) = repo_root(dir) else { return };
            let entry = found.entry(root).or_default();
            if !entry.0.iter().any(|s| s == source) {
                entry.0.push(source.to_string());
            }
            entry.1 = entry.1.max(used);
        };
        for (dir, used) in claude_project_dirs() {
            add(&dir, "claude", used);
        }
        for (dir, used) in jetbrains_project_dirs() {
            add(&dir, "jetbrains", used);
        }
        for dir in settings.manual.iter().chain(&settings.repos) {
            add(Path::new(dir), "added", 0);
        }
        // Selected repos that went missing stay listed, so they can be unticked.
        let mut out: Vec<RepoCandidate> =
            found.into_iter().map(|(path, (sources, used))| describe(&path, sources, used)).collect();
        for dir in &settings.repos {
            if !out.iter().any(|c| &c.path == dir) {
                out.push(RepoCandidate {
                    path: dir.clone(),
                    name: Path::new(dir).file_name().map_or(dir.clone(), |n| n.to_string_lossy().into_owned()),
                    remote: None,
                    email: None,
                    sources: vec!["missing".into()],
                    last_used: 0,
                });
            }
        }
        out.sort_by(|a, b| b.last_used.cmp(&a.last_used).then_with(|| a.name.cmp(&b.name)));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join(".git").exists() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" || name == "vendor" || name == "target" {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            scan(&entry.path(), depth - 1, out);
        }
    }
}

/// "Add path": the repo containing `path`, or every repo up to 3 levels below it.
#[tauri::command]
pub async fn scan_git_path(path: String) -> Result<Vec<String>, String> {
    let dir = expand_home(path.trim());
    if !dir.is_dir() {
        return Err(format!("No folder at {}", dir.display()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        match repo_root(&dir) {
            Some(root) => out.push(root),
            None => scan(&dir, SCAN_DEPTH, &mut out),
        }
        if out.is_empty() {
            return Err(format!("No git repos in {}", dir.display()));
        }
        out.sort();
        Ok(out.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- stats ----------

#[derive(Serialize, Default, Clone)]
pub struct DayStat {
    date: String,
    commits: u32,
    added: u64,
    removed: u64,
}

#[derive(Serialize)]
pub struct RepoStat {
    path: String,
    name: String,
    commits: u32,
    added: u64,
    removed: u64,
    /// Lines changed (added + removed) per side.
    backend: u64,
    frontend: u64,
    other: u64,
    /// Unix seconds of your latest commit in the window.
    last_commit: Option<i64>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Backend,
    Frontend,
    Other,
}

const SIDES: [Side; 3] = [Side::Backend, Side::Frontend, Side::Other];

#[derive(Serialize)]
pub struct LangStat {
    name: &'static str,
    added: u64,
    removed: u64,
}

#[derive(Serialize)]
pub struct SideStat {
    side: Side,
    /// Commits touching at least one file on this side.
    commits: u32,
    added: u64,
    removed: u64,
    /// Most lines changed first.
    languages: Vec<LangStat>,
}

/// Lines changed (added + removed) per side in one week.
#[derive(Serialize, Clone, Default)]
pub struct WeekStat {
    /// Monday (YYYY-MM-DD).
    start: String,
    backend: u64,
    frontend: u64,
    other: u64,
}

impl WeekStat {
    fn add(&mut self, side: Side, lines: u64) {
        match side {
            Side::Backend => self.backend += lines,
            Side::Frontend => self.frontend += lines,
            Side::Other => self.other += lines,
        }
    }
}

/// What a file's extension says about it. `.js`/`.ts` could be either side, so the repo decides.
enum Kind {
    Side(Side),
    Script,
}

fn language(path: &str) -> (&'static str, Kind) {
    use Side::*;
    let name = path.rsplit('/').next().unwrap_or(path).trim_end_matches('}');
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
    let (lang, kind) = match ext.as_str() {
        "rb" | "rake" | "ru" | "gemspec" => ("Ruby", Kind::Side(Backend)),
        "py" => ("Python", Kind::Side(Backend)),
        "go" => ("Go", Kind::Side(Backend)),
        "rs" => ("Rust", Kind::Side(Backend)),
        "java" => ("Java", Kind::Side(Backend)),
        "kt" | "kts" => ("Kotlin", Kind::Side(Backend)),
        "scala" => ("Scala", Kind::Side(Backend)),
        "cs" => ("C#", Kind::Side(Backend)),
        "php" => ("PHP", Kind::Side(Backend)),
        "ex" | "exs" => ("Elixir", Kind::Side(Backend)),
        "c" | "h" | "cc" | "cpp" | "hpp" => ("C/C++", Kind::Side(Backend)),
        "sql" => ("SQL", Kind::Side(Backend)),
        // JSX is UI wherever it lives.
        "tsx" => ("TypeScript", Kind::Side(Frontend)),
        "jsx" => ("JavaScript", Kind::Side(Frontend)),
        "ts" | "mts" | "cts" => ("TypeScript", Kind::Script),
        "js" | "mjs" | "cjs" | "coffee" => ("JavaScript", Kind::Script),
        "vue" => ("Vue", Kind::Side(Frontend)),
        "svelte" => ("Svelte", Kind::Side(Frontend)),
        "css" => ("CSS", Kind::Side(Frontend)),
        "scss" | "sass" => ("Sass", Kind::Side(Frontend)),
        "less" => ("Less", Kind::Side(Frontend)),
        "html" | "htm" => ("HTML", Kind::Side(Frontend)),
        // Server-rendered views.
        "erb" | "haml" | "slim" | "jbuilder" => ("Views", Kind::Side(Frontend)),
        "md" | "mdx" | "txt" => ("Docs", Kind::Side(Other)),
        "yml" | "yaml" | "json" | "toml" | "xml" | "ini" | "env" => ("Config", Kind::Side(Other)),
        "sh" | "bash" | "zsh" => ("Shell", Kind::Side(Other)),
        _ => ("Other", Kind::Side(Other)),
    };
    (lang, kind)
}

/// Where a repo's `.js`/`.ts` belongs: frontend if its `package.json` pulls in a UI framework (or
/// there is none, as with the asset JS of a Rails app), backend for a Node service.
fn script_side(repo: &Path) -> Side {
    const UI_PACKAGES: [&str; 12] = [
        "react", "vue", "@angular/core", "svelte", "preact", "solid-js", "lit", "next", "nuxt", "jquery",
        "ember-source", "@sveltejs/kit",
    ];
    let Some(pkg) = std::fs::read_to_string(repo.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    else {
        return Side::Frontend;
    };
    let ui = ["dependencies", "devDependencies", "peerDependencies"].iter().any(|key| {
        pkg.get(key).and_then(|d| d.as_object()).is_some_and(|deps| UI_PACKAGES.iter().any(|p| deps.contains_key(*p)))
    });
    if ui {
        Side::Frontend
    } else {
        Side::Backend
    }
}

fn classify(path: &str, scripts: Side) -> (&'static str, Side) {
    match language(path) {
        (lang, Kind::Side(side)) => (lang, side),
        (lang, Kind::Script) => (lang, scripts),
    }
}

#[derive(Serialize)]
pub struct RepoError {
    path: String,
    error: String,
}

#[derive(Serialize)]
pub struct GitStats {
    /// Monday the heatmap starts on, and today (YYYY-MM-DD).
    start: String,
    end: String,
    /// Days with at least one commit, oldest first.
    days: Vec<DayStat>,
    /// Commits by hour of day, in each commit's own time zone.
    hours: [u32; 24],
    /// Backend, frontend, other.
    sides: Vec<SideStat>,
    /// One per week of the window, oldest first.
    weeks: Vec<WeekStat>,
    repos: Vec<RepoStat>,
    /// Author emails matched, across all repos.
    emails: Vec<String>,
    errors: Vec<RepoError>,
}

struct Commit {
    hash: String,
    at: i64,
    date: NaiveDate,
    hour: usize,
    added: u64,
    removed: u64,
    /// (path, added, removed), without binary and generated files.
    files: Vec<(String, u64, u64)>,
}

/// Parses `git log --numstat` output written with the RS/US separated format below.
fn parse_log(text: &str) -> Vec<Commit> {
    let mut out = Vec::new();
    for record in text.split('\x1e').skip(1) {
        let mut lines = record.lines();
        let Some(header) = lines.next() else { continue };
        let mut fields = header.split('\x1f');
        let (Some(hash), Some(at), Some(stamp)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        // stamp = "2026-10-12 14"
        let Some((day, hour)) = stamp.split_once(' ') else { continue };
        let (Ok(date), Ok(hour), Ok(at)) =
            (NaiveDate::parse_from_str(day, "%Y-%m-%d"), hour.parse::<usize>(), at.parse::<i64>())
        else {
            continue;
        };
        let mut commit =
            Commit { hash: hash.to_string(), at, date, hour: hour.min(23), added: 0, removed: 0, files: Vec::new() };
        for line in lines {
            let mut cols = line.splitn(3, '\t');
            let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else { continue };
            // Binary files show "-"; lock and generated files aren't your work.
            let (Ok(a), Ok(r)) = (a.parse::<u64>(), r.parse::<u64>()) else { continue };
            if generated_kind(path).is_some() {
                continue;
            }
            commit.added += a;
            commit.removed += r;
            commit.files.push((path.to_string(), a, r));
        }
        out.push(commit);
    }
    out
}

fn repo_log(repo: &Path, emails: &[String], since: NaiveDate) -> Result<Vec<Commit>, String> {
    if !repo.join(".git").exists() {
        return Err("not a git repo (moved or deleted?)".into());
    }
    let mut args: Vec<String> = vec![
        "log".into(),
        // Every branch, local and fetched, but not stashes.
        "--exclude=refs/stash".into(),
        "--all".into(),
        "--no-merges".into(),
        "--fixed-strings".into(),
        format!("--since={since} 00:00"),
        "--numstat".into(),
        "--date=format:%Y-%m-%d %H".into(),
        "--format=%x1e%H%x1f%at%x1f%ad".into(),
    ];
    args.extend(emails.iter().map(|e| format!("--author={e}")));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(parse_log(&git(repo, &args)?))
}

#[tauri::command]
pub async fn compute_git_stats(app: AppHandle) -> Result<GitStats, String> {
    let settings = load_settings(&app);
    if settings.repos.is_empty() {
        return Err("No repositories selected — pick some in Settings → Repositories.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let today = Local::now().date_naive();
        let start = today - Duration::days(today.weekday().num_days_from_monday() as i64 + (WEEKS - 1) * 7);

        // One `git log` per repo, in parallel.
        type RepoLog = (String, Vec<String>, Side, Result<Vec<Commit>, String>);
        let results: Vec<RepoLog> = std::thread::scope(|s| {
            let handles: Vec<_> = settings
                .repos
                .iter()
                .map(|repo| {
                    let extra = &settings.emails;
                    s.spawn(move || {
                        let path = Path::new(repo);
                        let mut emails: Vec<String> = git(path, &["config", "user.email"])
                            .ok()
                            .map(|e| e.trim().to_string())
                            .filter(|e| !e.is_empty())
                            .into_iter()
                            .collect();
                        emails.extend(extra.iter().cloned());
                        let log = if emails.is_empty() {
                            Err("no user.email set for this repo — add your email in Settings".into())
                        } else {
                            repo_log(path, &emails, start)
                        };
                        (repo.clone(), emails, script_side(path), log)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().expect("git log thread panicked")).collect()
        });

        let mut seen = HashSet::new();
        let mut days: HashMap<NaiveDate, DayStat> = HashMap::new();
        let mut hours = [0u32; 24];
        let mut weeks: Vec<WeekStat> = (0..WEEKS)
            .map(|w| WeekStat { start: (start + Duration::days(w * 7)).to_string(), ..Default::default() })
            .collect();
        // side → (commits, added, removed); (side, language) → (added, removed)
        let mut sides: HashMap<Side, (u32, u64, u64)> = HashMap::new();
        let mut langs: HashMap<(Side, &'static str), (u64, u64)> = HashMap::new();
        let mut repos = Vec::new();
        let mut errors = Vec::new();
        let mut all_emails: Vec<String> = Vec::new();
        for (path, emails, scripts, log) in results {
            for e in emails {
                if !all_emails.contains(&e) {
                    all_emails.push(e);
                }
            }
            let commits = match log {
                Ok(c) => c,
                Err(error) => {
                    errors.push(RepoError { path, error });
                    continue;
                }
            };
            let name = Path::new(&path).file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned());
            let mut stat = RepoStat {
                path,
                name,
                commits: 0,
                added: 0,
                removed: 0,
                backend: 0,
                frontend: 0,
                other: 0,
                last_commit: None,
            };
            for c in commits {
                // `--since` filters on the commit date; a rebase can bring in older work.
                // The same repo cloned twice counts once.
                if c.date < start || c.date > today || !seen.insert(c.hash.clone()) {
                    continue;
                }
                stat.commits += 1;
                stat.added += c.added;
                stat.removed += c.removed;
                stat.last_commit = Some(stat.last_commit.map_or(c.at, |t| t.max(c.at)));
                hours[c.hour] += 1;
                let day = days.entry(c.date).or_insert_with(|| DayStat { date: c.date.to_string(), ..Default::default() });
                day.commits += 1;
                day.added += c.added;
                day.removed += c.removed;

                let week = &mut weeks[((c.date - start).num_days() / 7).clamp(0, WEEKS - 1) as usize];
                let mut touched = HashSet::new();
                for (file, a, r) in &c.files {
                    let (lang, side) = classify(file, scripts);
                    touched.insert(side);
                    week.add(side, a + r);
                    match side {
                        Side::Backend => stat.backend += a + r,
                        Side::Frontend => stat.frontend += a + r,
                        Side::Other => stat.other += a + r,
                    }
                    let entry = sides.entry(side).or_default();
                    entry.1 += a;
                    entry.2 += r;
                    let l = langs.entry((side, lang)).or_default();
                    l.0 += a;
                    l.1 += r;
                }
                for side in touched {
                    sides.entry(side).or_default().0 += 1;
                }
            }
            repos.push(stat);
        }

        let mut days: Vec<DayStat> = days.into_values().collect();
        days.sort_by(|a, b| a.date.cmp(&b.date));
        repos.sort_by(|a, b| (b.added + b.removed).cmp(&(a.added + a.removed)).then(b.commits.cmp(&a.commits)));
        let sides = SIDES
            .iter()
            .map(|&side| {
                let (commits, added, removed) = sides.get(&side).copied().unwrap_or_default();
                let mut languages: Vec<LangStat> = langs
                    .iter()
                    .filter(|((s, _), _)| *s == side)
                    .map(|((_, name), (added, removed))| LangStat { name, added: *added, removed: *removed })
                    .collect();
                languages.sort_by(|a, b| (b.added + b.removed).cmp(&(a.added + a.removed)).then(a.name.cmp(b.name)));
                SideStat { side, commits, added, removed, languages }
            })
            .collect();
        Ok(GitStats {
            start: start.to_string(),
            end: today.to_string(),
            days,
            hours,
            sides,
            weeks,
            repos,
            emails: all_emails,
            errors,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_remotes() {
        assert_eq!(short_remote("git@bitbucket.org:acme/billing.git"), "bitbucket.org/acme/billing");
        assert_eq!(short_remote("https://user@gitlab.com/acme/api.git\n"), "gitlab.com/acme/api");
        assert_eq!(short_remote("ssh://git@git.example.com:2222/acme/api.git"), "git.example.com:2222/acme/api");
    }

    #[test]
    fn parses_log_and_skips_generated_files() {
        let text = "\x1eabc\x1f1760270400\x1f2026-10-12 14\n\n10\t2\tsrc/app.ts\n500\t0\tpackage-lock.json\n9000\t0\tapp/ui/dist/bundle.js\n-\t-\tlogo.png\n\
                    \x1edef\x1f1760184000\x1f2026-10-11 09\n";
        let commits = parse_log(text);
        assert_eq!(commits.len(), 2);
        assert_eq!((commits[0].added, commits[0].removed, commits[0].hour), (10, 2, 14));
        assert_eq!(commits[1].date, NaiveDate::from_ymd_opt(2026, 10, 11).unwrap());
        assert_eq!(commits[1].added, 0);
        assert_eq!(commits[0].files, vec![("src/app.ts".to_string(), 10, 2)]);
    }

    #[test]
    fn sorts_files_into_sides() {
        assert_eq!(classify("app/models/user.rb", Side::Frontend), ("Ruby", Side::Backend));
        assert_eq!(classify("src/App.tsx", Side::Backend), ("TypeScript", Side::Frontend));
        assert_eq!(classify("src/server.ts", Side::Backend), ("TypeScript", Side::Backend));
        assert_eq!(classify("app/views/a/show.html.erb", Side::Backend), ("Views", Side::Frontend));
        assert_eq!(classify("docs/README.md", Side::Backend), ("Docs", Side::Other));
        assert_eq!(classify("src/{old => new}/a.rs}", Side::Frontend), ("Rust", Side::Backend));
        assert_eq!(classify("Makefile", Side::Backend), ("Other", Side::Other));
    }
}

