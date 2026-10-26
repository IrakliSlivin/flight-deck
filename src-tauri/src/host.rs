//! Programs run on the user's machine (`git`, the claude CLI). In the Flatpak build neither is in
//! the runtime, and the CLI needs the user's own login and setup anyway, so inside the sandbox they
//! run on the host through `flatpak-spawn --host` (needs `--talk-name=org.freedesktop.Flatpak`).

use std::ffi::OsStr;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// True inside the Flatpak sandbox.
pub fn in_flatpak() -> bool {
    static IN: OnceLock<bool> = OnceLock::new();
    *IN.get_or_init(|| std::path::Path::new("/.flatpak-info").exists())
}

/// `Command::new(program)`, run on the host when sandboxed. Its working directory is the one set
/// with `current_dir`, which must exist on the host too (home folders and /tmp do).
pub fn command(program: impl AsRef<OsStr>) -> Command {
    if !in_flatpak() {
        return Command::new(program);
    }
    let mut command = Command::new("flatpak-spawn");
    // --watch-bus: the host command is stopped if flatpak-spawn dies.
    command.args(["--host", "--watch-bus"]).arg(program);
    command
}

/// `command`, for a run that may be killed from here (`claude_cli::kill_group`). Outside the sandbox
/// killing the caller's process group is enough. Inside, killing flatpak-spawn only makes the host
/// send SIGINT to the command's own process group, so the host's `timeout` turns that into SIGKILL
/// after a few seconds, and stops the run at `limit` by itself.
pub fn stoppable_command(program: impl AsRef<OsStr>, limit: Duration) -> Command {
    if !in_flatpak() {
        return Command::new(program);
    }
    let mut command = command("timeout");
    command
        .args(["-k", "5", &format!("{}s", limit.as_secs() + 5)])
        .arg(program);
    command
}
