fn main() {
    // Declaring the app's commands makes each one need an explicit permission, so the Outlook
    // window (remote content) can be granted report_outlook_inbox without the rest.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "save_credential",
            "has_credential",
            "get_credential",
            "delete_credential",
            "fetch_clickup_tasks",
            "fetch_clickup_list_statuses",
            "update_clickup_task_status",
            "fetch_bitbucket_prs",
            "fetch_gitlab_prs",
            "send_claude_message",
            "compute_claude_usage",
            "read_claude_rate_limits",
            "fetch_ai_news",
            "fetch_meetings",
            "get_outlook_inbox",
            "open_outlook",
            "refresh_outlook",
            "brief_outlook_inbox",
            "report_outlook_inbox",
            "quit_app",
            "get_reminder_settings",
            "set_reminder_settings",
            "clear_notifications",
            "dismiss_notification",
            "get_notification_feed",
            "preview_notification_sound",
        ]),
    ))
    .expect("failed to run tauri-build");
}
