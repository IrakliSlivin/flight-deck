use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod credentials;
use credentials::{delete_credential, get_credential, has_credential, save_credential};

mod clickup;
use clickup::{check_clickup, fetch_clickup_list_statuses, fetch_clickup_tasks, update_clickup_task_status};

mod bitbucket;
use bitbucket::{check_bitbucket, fetch_bitbucket_prs, list_bitbucket_repos};

mod gitlab;
use gitlab::{check_gitlab, fetch_gitlab_prs};

mod claude;
use claude::send_claude_message;

mod calendar;
mod news;
mod usage;
use calendar::fetch_meetings;
use news::fetch_ai_news;
use usage::{compute_claude_usage, read_claude_rate_limits};

mod notifications;
use notifications::{clear_notifications, dismiss_notification, get_notification_feed, preview_notification_sound};
mod reminders;
use reminders::{get_reminder_settings, set_reminder_settings};

mod claude_cli;
use claude_cli::check_claude_cli;

mod outlook;
use outlook::{
    brief_outlook_inbox, get_outlook_inbox, open_outlook, refresh_outlook, report_outlook_inbox, OutlookState,
};

mod diff;
mod review;
use review::{
    cancel_pr_review, fetch_pr_diff, get_pr_review, list_pr_reviews, post_review_comment, review_pr, submit_pr_decision,
    ReviewState,
};

const DB_URL: &str = "sqlite:dashboard.db";

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_todos_and_quick_links",
        sql: "
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS quick_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL,
                url TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
        ",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Ctrl+Q / the command palette. Closing the main window quits too.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("open-palette", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    let builder = tauri::Builder::default();
    // Launching again from the app menu shows the running window instead of starting a second
    // copy. Release only: dev shares the identifier, so it would just exit while the installed
    // build runs.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_window(app);
    }));

    builder
        .manage(OutlookState::default())
        .manage(ReviewState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DB_URL, migrations())
                .build(),
        )
        .plugin({
            let toggle_shortcut = toggle_shortcut.clone();
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build()
        })
        .setup(move |app| {
            // Non-fatal: another instance (e.g. `tauri dev` alongside the
            // installed build) may already own the shortcut.
            if let Err(e) = app.global_shortcut().register(toggle_shortcut.clone()) {
                eprintln!("global shortcut unavailable: {e}");
            }

            // Closing the main window quits the app. An explicit exit, because the hidden Outlook
            // window would otherwise keep the process running in the background.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        app_handle.exit(0);
                    }
                });
            }

            outlook::start_background(app.handle());
            reminders::start(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_credential,
            has_credential,
            get_credential,
            delete_credential,
            fetch_clickup_tasks,
            fetch_clickup_list_statuses,
            update_clickup_task_status,
            check_clickup,
            fetch_bitbucket_prs,
            check_bitbucket,
            list_bitbucket_repos,
            fetch_gitlab_prs,
            check_gitlab,
            send_claude_message,
            compute_claude_usage,
            read_claude_rate_limits,
            fetch_ai_news,
            fetch_meetings,
            report_outlook_inbox,
            get_outlook_inbox,
            open_outlook,
            refresh_outlook,
            brief_outlook_inbox,
            check_claude_cli,
            fetch_pr_diff,
            review_pr,
            get_pr_review,
            list_pr_reviews,
            cancel_pr_review,
            post_review_comment,
            submit_pr_decision,
            quit_app,
            get_reminder_settings,
            set_reminder_settings,
            clear_notifications,
            dismiss_notification,
            get_notification_feed,
            preview_notification_sound
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
