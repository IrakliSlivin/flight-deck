use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use keyring::Entry;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const ICS_URL_KEY: &str = "outlook.calendar_ics_url";
const REQUEST_TIMEOUT_SECS: u64 = 20;
/// Days of meetings returned, starting from local midnight today.
const WINDOW_DAYS: i64 = 2;

#[derive(Serialize)]
pub struct Meeting {
    pub(crate) title: String,
    /// RFC 3339, UTC.
    pub(crate) start: String,
    pub(crate) end: String,
    pub(crate) all_day: bool,
    pub(crate) location: Option<String>,
    pub(crate) join_url: Option<String>,
    /// Outlook's X-MICROSOFT-CDO-BUSYSTATUS: BUSY, TENTATIVE, FREE, OOF.
    pub(crate) busy_status: Option<String>,
}

// --- Minimal iCalendar (RFC 5545) reader: enough for Outlook's published feeds ---

struct Prop {
    name: String,
    params: HashMap<String, String>,
    value: String,
}

#[derive(Default)]
struct Component {
    kind: String,
    props: Vec<Prop>,
    children: Vec<Component>,
}

impl Component {
    fn get(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }
    fn get_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Prop> {
        self.props.iter().filter(move |p| p.name == name)
    }
}

fn unfold(raw: &str) -> String {
    raw.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "")
}

fn parse_prop(line: &str) -> Option<Prop> {
    // Split at the first ':' that isn't inside a quoted param value.
    let mut in_quotes = false;
    let mut split_at = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                split_at = Some(i);
                break;
            }
            _ => {}
        }
    }
    let idx = split_at?;
    let (head, value) = (&line[..idx], &line[idx + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.to_uppercase();
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((k.to_uppercase(), v.trim_matches('"').to_string()))
        })
        .collect();
    Some(Prop {
        name,
        params,
        value: value.to_string(),
    })
}

/// Returns the VCALENDAR component (the parse root wraps it).
fn parse_calendar(raw: &str) -> Component {
    let mut root = parse_tree(raw);
    match root.children.iter().position(|c| c.kind == "VCALENDAR") {
        Some(i) => root.children.swap_remove(i),
        None => root,
    }
}

fn parse_tree(raw: &str) -> Component {
    let mut stack = vec![Component::default()];
    for line in unfold(raw).lines() {
        let Some(prop) = parse_prop(line) else { continue };
        match prop.name.as_str() {
            "BEGIN" => stack.push(Component {
                kind: prop.value.to_uppercase(),
                ..Default::default()
            }),
            "END" => {
                if stack.len() > 1 {
                    let done = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.push(done);
                }
            }
            _ => stack.last_mut().unwrap().props.push(prop),
        }
    }
    while stack.len() > 1 {
        let done = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(done);
    }
    stack.pop().unwrap()
}

fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

// --- Timezones ---

/// Outlook writes Windows timezone names (e.g. "Georgian Standard Time") as
/// TZIDs. Common ones are mapped to IANA zones so DST is handled properly.
fn windows_to_iana(name: &str) -> Option<&'static str> {
    Some(match name {
        "Georgian Standard Time" => "Asia/Tbilisi",
        "Arabian Standard Time" => "Asia/Dubai",
        "Azerbaijan Standard Time" => "Asia/Baku",
        "Caucasus Standard Time" => "Asia/Yerevan",
        "Russian Standard Time" => "Europe/Moscow",
        "Turkey Standard Time" => "Europe/Istanbul",
        "FLE Standard Time" => "Europe/Kiev",
        "GTB Standard Time" => "Europe/Bucharest",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Central European Standard Time" => "Europe/Warsaw",
        "Romance Standard Time" => "Europe/Paris",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "Israel Standard Time" => "Asia/Jerusalem",
        "India Standard Time" => "Asia/Kolkata",
        "Eastern Standard Time" => "America/New_York",
        "Central Standard Time" => "America/Chicago",
        "Mountain Standard Time" => "America/Denver",
        "Pacific Standard Time" => "America/Los_Angeles",
        "UTC" | "Coordinated Universal Time" => "UTC",
        _ => return None,
    })
}

/// Parses "+0400" / "-0530" into seconds east of UTC.
fn parse_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let digits = s.trim_start_matches(['+', '-']);
    let h: i32 = digits.get(0..2)?.parse().ok()?;
    let m: i32 = digits.get(2..4).unwrap_or("00").parse().ok()?;
    Some(sign * (h * 3600 + m * 60))
}

/// Resolves a TZID to a timezone: known Windows name, IANA name, or a fixed
/// whole-hour offset taken from the feed's own VTIMEZONE block.
fn resolve_tz(tzid: &str, vtimezones: &HashMap<String, i32>) -> rrule::Tz {
    if let Some(iana) = windows_to_iana(tzid) {
        if let Ok(tz) = chrono_tz::Tz::from_str(iana) {
            return tz.into();
        }
    }
    if let Ok(tz) = chrono_tz::Tz::from_str(tzid) {
        return tz.into();
    }
    if let Some(secs) = vtimezones.get(tzid) {
        if secs % 3600 == 0 {
            // Etc/GMT signs are inverted: UTC+4 is "Etc/GMT-4".
            let name = match secs / 3600 {
                0 => "Etc/GMT".to_string(),
                h if h > 0 => format!("Etc/GMT-{h}"),
                h => format!("Etc/GMT+{}", -h),
            };
            if let Ok(tz) = chrono_tz::Tz::from_str(&name) {
                return tz.into();
            }
        }
    }
    rrule::Tz::LOCAL
}

/// Returns (datetime, is_all_day).
fn parse_dt(prop: &Prop, vtimezones: &HashMap<String, i32>) -> Option<(DateTime<rrule::Tz>, bool)> {
    let v = prop.value.trim();
    if prop.params.get("VALUE").map(|s| s == "DATE").unwrap_or(false) || v.len() == 8 {
        let date = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        let dt = rrule::Tz::LOCAL
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .earliest()?;
        return Some((dt, true));
    }
    if let Some(utc) = v.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        let dt = Utc.from_utc_datetime(&naive).with_timezone(&rrule::Tz::UTC);
        return Some((dt, false));
    }
    let naive = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    let tz = prop
        .params
        .get("TZID")
        .map(|id| resolve_tz(id, vtimezones))
        .unwrap_or(rrule::Tz::LOCAL);
    Some((tz.from_local_datetime(&naive).earliest()?, false))
}

/// URL prefixes of online meeting rooms, in priority order.
const JOIN_URL_PREFIXES: &[&str] = &[
    "https://teams.microsoft.com/l/meetup-join/",
    "https://teams.microsoft.com/meet/",
    "https://teams.live.com/meet/",
    "https://meet.google.com/",
    "https://zoom.us/j/",
    "https://zoom.us/my/",
    ".zoom.us/j/",
    ".webex.com/",
];

/// First online-meeting link found in the text (Teams, Meet, Zoom, Webex).
fn extract_join_url(text: &str) -> Option<String> {
    JOIN_URL_PREFIXES.iter().find_map(|prefix| {
        let hit = text.find(prefix)?;
        // Prefixes like ".zoom.us/j/" match mid-URL (company subdomain); walk back to "https://".
        let start = text[..hit + prefix.len()].rfind("https://")?;
        let rest = &text[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '>' | '"' | '<' | ')' | ']'))
            .unwrap_or(rest.len());
        Some(rest[..end].to_string())
    })
}

fn is_cancelled(ev: &Component) -> bool {
    let status_cancelled = ev
        .get("STATUS")
        .map(|p| p.value.eq_ignore_ascii_case("CANCELLED"))
        .unwrap_or(false);
    let title = ev.get("SUMMARY").map(|p| p.value.to_lowercase()).unwrap_or_default();
    status_cancelled || title.starts_with("canceled:") || title.starts_with("cancelled:")
}

fn to_meeting(
    ev: &Component,
    start: DateTime<rrule::Tz>,
    duration: Duration,
    all_day: bool,
) -> Meeting {
    let text = |name: &str| ev.get(name).map(|p| unescape_text(&p.value)).filter(|s| !s.trim().is_empty());
    let description = text("DESCRIPTION").unwrap_or_default();
    let location = text("LOCATION");
    let join_url = extract_join_url(&description)
        .or_else(|| location.as_deref().and_then(extract_join_url));
    Meeting {
        title: text("SUMMARY").unwrap_or_else(|| "(no title)".to_string()),
        start: start.with_timezone(&Utc).to_rfc3339(),
        end: (start + duration).with_timezone(&Utc).to_rfc3339(),
        all_day,
        location,
        join_url,
        busy_status: ev.get("X-MICROSOFT-CDO-BUSYSTATUS").map(|p| p.value.to_uppercase()),
    }
}

fn meetings_in_window(
    cal: &Component,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<Meeting> {
    let vtimezones: HashMap<String, i32> = cal
        .children
        .iter()
        .filter(|c| c.kind == "VTIMEZONE")
        .filter_map(|tz| {
            let id = tz.get("TZID")?.value.clone();
            let std = tz.children.iter().find(|c| c.kind == "STANDARD")?;
            Some((id, parse_offset(&std.get("TZOFFSETTO")?.value)?))
        })
        .collect();

    let events: Vec<&Component> = cal.children.iter().filter(|c| c.kind == "VEVENT").collect();

    // Occurrences overridden by a RECURRENCE-ID event are dropped from the master series.
    let mut overridden: HashMap<String, HashSet<i64>> = HashMap::new();
    for ev in &events {
        if let (Some(uid), Some(rid)) = (ev.get("UID"), ev.get("RECURRENCE-ID")) {
            if let Some((dt, _)) = parse_dt(rid, &vtimezones) {
                overridden.entry(uid.value.clone()).or_default().insert(dt.timestamp());
            }
        }
    }

    let overlaps = |start: DateTime<rrule::Tz>, duration: Duration| {
        let s = start.with_timezone(&Utc);
        s < window_end && s + duration > window_start
    };

    let mut out = Vec::new();
    for ev in events {
        if is_cancelled(ev) {
            continue;
        }
        let Some((start, all_day)) = ev.get("DTSTART").and_then(|p| parse_dt(p, &vtimezones)) else {
            continue;
        };
        let duration = ev
            .get("DTEND")
            .and_then(|p| parse_dt(p, &vtimezones))
            .map(|(end, _)| end.with_timezone(&Utc) - start.with_timezone(&Utc))
            .unwrap_or_else(|| if all_day { Duration::days(1) } else { Duration::zero() });

        let rrule_prop = ev.get("RRULE");
        if ev.get("RECURRENCE-ID").is_some() || rrule_prop.is_none() {
            if overlaps(start, duration) {
                out.push(to_meeting(ev, start, duration, all_day));
            }
            continue;
        }

        let Ok(rule) = rrule::RRule::<rrule::Unvalidated>::from_str(&rrule_prop.unwrap().value) else {
            continue;
        };
        let Ok(mut set) = rule.build(start) else { continue };
        for ex in ev.get_all("EXDATE") {
            // EXDATE may hold a comma-separated list.
            for value in ex.value.split(',') {
                let single = Prop {
                    name: ex.name.clone(),
                    params: ex.params.clone(),
                    value: value.to_string(),
                };
                if let Some((dt, _)) = parse_dt(&single, &vtimezones) {
                    set = set.exdate(dt);
                }
            }
        }
        let skip = ev
            .get("UID")
            .and_then(|uid| overridden.get(&uid.value))
            .cloned()
            .unwrap_or_default();

        let after = (window_start - duration - Duration::seconds(1)).with_timezone(&start.timezone());
        let before = window_end.with_timezone(&start.timezone());
        for occurrence in set.after(after).before(before).all(500).dates {
            if skip.contains(&occurrence.timestamp()) || !overlaps(occurrence, duration) {
                continue;
            }
            out.push(to_meeting(ev, occurrence, duration, all_day));
        }
    }

    out.sort_by(|a, b| a.start.cmp(&b.start));
    out
}

#[tauri::command]
pub async fn fetch_meetings() -> Result<Vec<Meeting>, String> {
    load_meetings().await
}

/// Meetings from local midnight today through the end of the window. Also used by `reminders`.
pub(crate) async fn load_meetings() -> Result<Vec<Meeting>, String> {
    let url = Entry::new(SERVICE, ICS_URL_KEY)
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Outlook calendar link not set. Add it in Settings.".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url.trim()).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Calendar feed returned HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let cal = parse_calendar(&body);

    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    let window_start = Local
        .from_local_datetime(&today)
        .earliest()
        .ok_or("could not resolve local midnight")?
        .with_timezone(&Utc);
    let window_end = window_start + Duration::days(WINDOW_DAYS);

    Ok(meetings_in_window(&cal, window_start, window_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses a local .ics dump (set CALENDAR_ICS) and prints this week's meetings.
    /// Run with: CALENDAR_ICS=/path/cal.ics cargo test calendar -- --nocapture
    #[test]
    fn calendar_from_file() {
        let Ok(path) = std::env::var("CALENDAR_ICS") else { return };
        let raw = std::fs::read_to_string(path).unwrap();
        let cal = parse_calendar(&raw);
        let start = Local
            .from_local_datetime(&Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .unwrap()
            .with_timezone(&Utc);
        for m in meetings_in_window(&cal, start, start + Duration::days(7)) {
            let local = DateTime::parse_from_rfc3339(&m.start).unwrap().with_timezone(&Local);
            println!(
                "{}  {:<45} {:?} join={}",
                local.format("%a %d %H:%M"),
                m.title.chars().take(45).collect::<String>(),
                m.busy_status,
                m.join_url.is_some()
            );
        }
    }
}

