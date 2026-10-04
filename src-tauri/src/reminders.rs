//! Desktop notifications for upcoming meetings. Runs in Rust so reminders still fire while the
//! window is hidden (Ctrl+Shift+Space). Each timed meeting gets one heads-up `lead_minutes` before
//! it starts, with a Join button when the meeting has a link.
//! Preferences (sounds, lead time) live in `reminder_settings.json` in the app data dir, including
//! the new-mail sound used by outlook.rs.

use chrono::{DateTime, Utc};
use notify_rust::{Notification, Timeout};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::calendar::{load_meetings, Meeting};
use crate::notifications;

const DEFAULT_LEAD_MINUTES: u32 = 5;
const MAX_LEAD_MINUTES: u32 = 60;
const TICK: Duration = Duration::from_secs(20);
const REFETCH: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct ReminderSettings {
    /// Meeting reminder sound: on/off, and an id from notifications.rs ("chime", "bell", ...).
    sound: bool,
    sound_name: String,
    /// New-mail sound, set separately.
    mail_sound: bool,
    mail_sound_name: String,
    /// How long before the start the heads-up fires.
    lead_minutes: u32,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            sound: true,
            sound_name: notifications::DEFAULT_SOUND.into(),
            mail_sound: true,
            mail_sound_name: notifications::DEFAULT_MAIL_SOUND.into(),
            lead_minutes: DEFAULT_LEAD_MINUTES,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("reminder_settings.json"))
}

fn load_settings(app: &AppHandle) -> ReminderSettings {
    let mut settings: ReminderSettings = settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    settings.fix_sounds();
    settings
}

impl ReminderSettings {
    /// Swaps sounds that no longer exist (e.g. the retired fly sounds) for the defaults.
    fn fix_sounds(&mut self) {
        if !notifications::is_known_sound(&self.sound_name) {
            self.sound_name = notifications::DEFAULT_SOUND.into();
        }
        if !notifications::is_known_sound(&self.mail_sound_name) {
            self.mail_sound_name = notifications::DEFAULT_MAIL_SOUND.into();
        }
    }
}

/// The new-mail sound for outlook.rs, or None when it is off.
pub fn mail_sound_choice(app: &AppHandle) -> Option<String> {
    let s = load_settings(app);
    s.mail_sound.then_some(s.mail_sound_name)
}

#[tauri::command]
pub async fn get_reminder_settings(app: AppHandle) -> Result<ReminderSettings, String> {
    Ok(load_settings(&app))
}

#[tauri::command]
pub async fn set_reminder_settings(app: AppHandle, mut settings: ReminderSettings) -> Result<(), String> {
    settings.lead_minutes = settings.lead_minutes.clamp(1, MAX_LEAD_MINUTES);
    settings.fix_sounds();
    let path = settings_path(&app).ok_or("app data directory unavailable")?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut meetings: Vec<Meeting> = Vec::new();
        let mut fetched_at: Option<Instant> = None;
        // (start, title) of meetings already notified.
        let mut fired: HashSet<(String, String)> = HashSet::new();

        loop {
            if fetched_at.map_or(true, |t| t.elapsed() >= REFETCH) {
                match tauri::async_runtime::block_on(load_meetings()) {
                    Ok(m) => meetings = m,
                    // Keep the previous list: a flaky network shouldn't cancel reminders.
                    Err(e) => eprintln!("meeting reminders: {e}"),
                }
                fetched_at = Some(Instant::now());
                fired.retain(|(start, title)| meetings.iter().any(|m| &m.start == start && &m.title == title));
            }

            // Re-read each tick so changes in Settings apply without a restart.
            let settings = load_settings(&app);
            let now = Utc::now();
            for m in &meetings {
                if due(m, now, settings.lead_minutes) && fired.insert((m.start.clone(), m.title.clone())) {
                    notify(&app, m, &settings);
                }
            }

            std::thread::sleep(TICK);
        }
    });
}

/// True within `lead_minutes` before the start. Meetings already started are skipped (e.g. the app
/// was launched mid-meeting, or the machine woke from sleep).
fn due(m: &Meeting, now: DateTime<Utc>, lead_minutes: u32) -> bool {
    if m.all_day || m.busy_status.as_deref() == Some("FREE") {
        return false;
    }
    let Ok(start) = DateTime::parse_from_rfc3339(&m.start) else { return false };
    let secs = (start.with_timezone(&Utc) - now).num_seconds();
    secs > 0 && secs <= i64::from(lead_minutes) * 60
}

fn notify(app: &AppHandle, m: &Meeting, settings: &ReminderSettings) {
    let mins = DateTime::parse_from_rfc3339(&m.start)
        .map(|s| ((s.with_timezone(&Utc) - Utc::now()).num_seconds() + 59) / 60)
        .unwrap_or(i64::from(settings.lead_minutes));
    let when = format!("Starts in {} min", mins.max(1));
    let body = match m.location.as_deref().filter(|l| !l.starts_with("Microsoft Teams")) {
        Some(loc) => format!("{when} · {loc}"),
        None => when,
    };

    let mut n = Notification::new();
    n.timeout(Timeout::Milliseconds(30_000))
        .action("default", "Open Flight Deck");
    if settings.sound {
        notifications::set_sound(app, &mut n, &settings.sound_name);
    }
    if m.join_url.is_some() {
        n.action("join", "Join");
    }

    let handle = app.clone();
    let join_url = m.join_url.clone();
    let target = m.join_url.clone();
    notifications::notify(app, notifications::Kind::Meeting, &m.title, &body, target, n, move |action| match action {
        "join" => {
            if let Some(url) = &join_url {
                let _ = handle.opener().open_url(url, None::<&str>);
            }
        }
        "default" => {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting(start: DateTime<Utc>) -> Meeting {
        Meeting {
            title: "Standup".into(),
            start: start.to_rfc3339(),
            end: (start + chrono::Duration::minutes(15)).to_rfc3339(),
            all_day: false,
            location: None,
            join_url: None,
            busy_status: Some("BUSY".into()),
        }
    }

    #[test]
    fn due_windows() {
        let now = Utc::now();
        let at = |mins: i64| due(&meeting(now + chrono::Duration::minutes(mins)), now, 5);
        assert!(!at(10));
        assert!(due(&meeting(now + chrono::Duration::minutes(10)), now, 15));
        assert!(at(5));
        assert!(at(1));
        // No notification once the meeting has started.
        assert!(!at(0));
        assert!(!at(-1));

        let mut free = meeting(now + chrono::Duration::minutes(2));
        free.busy_status = Some("FREE".into());
        assert!(!due(&free, now, 5));
        free.busy_status = None;
        free.all_day = true;
        assert!(!due(&free, now, 5));
    }
}
