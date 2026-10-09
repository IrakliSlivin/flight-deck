use serde::Serialize;
use std::time::{Duration, Instant};

// The Claude Code CLI (`claude -p`), shared by the mail brief (outlook.rs) and PR reviews
// (review.rs). It runs on the user's Claude Code login, so neither needs an API key.

const SERVICE: &str = "com.ubumtu.daily-dashboard";
const CLI_KEY: &str = "claude.cli_path";

/// The Claude Code CLI. Launched from the app menu, PATH may not include ~/.local/bin.
fn claude_cli() -> std::path::PathBuf {
    if let Some(configured) = configured_cli() {
        return configured;
    }
    let local = dirs_home().map(|h| h.join(".local/bin/claude"));
    match local {
        Some(path) if path.exists() => path,
        _ => "claude".into(),
    }
}

fn configured_cli() -> Option<std::path::PathBuf> {
    let raw = keyring::Entry::new(SERVICE, CLI_KEY)
        .ok()?
        .get_password()
        .ok()?;
    let raw = raw.trim();
    (!raw.is_empty()).then(|| expand_home(raw))
}

fn expand_home(raw: &str) -> std::path::PathBuf {
    match raw.strip_prefix("~/") {
        Some(rest) => dirs_home().map(|h| h.join(rest)).unwrap_or_else(|| raw.into()),
        None => raw.into(),
    }
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(Into::into)
}

#[derive(Serialize)]
pub struct ClaudeCliCheck {
    path: String,
    version: String,
}

#[tauri::command]
pub async fn check_claude_cli(path: Option<String>) -> Result<ClaudeCliCheck, String> {
    let cli = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => expand_home(p),
        None => claude_cli(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(&cli)
            .arg("--version")
            .current_dir(std::env::temp_dir())
            .output()
            .map_err(|e| format!("Couldn't run {}: {e}", cli.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("{} --version failed: {}", cli.display(), stderr.trim()));
        }
        Ok(ClaudeCliCheck {
            path: cli.display().to_string(),
            version: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One structured answer from `claude -p`: `input` goes in on stdin and the `structured_output`
/// matching `schema` comes back. The CLI gets no tools, MCP servers or settings, and runs from
/// the temp dir so no CLAUDE.md is picked up: the input is only text to read. Blocking.
/// `on_start` gets the process group id, so a caller can stop the run (`kill_group`).
pub fn run_structured(
    model: &str,
    system: &str,
    schema: &str,
    input: &str,
    timeout: Duration,
    on_start: impl FnOnce(u32),
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut command = Command::new(claude_cli());
    command
        .args(["-p", "--output-format", "json", "--model", model])
        .args(["--tools", "", "--strict-mcp-config", "--setting-sources", ""])
        .arg("--no-session-persistence")
        .args(["--system-prompt", system, "--json-schema", schema])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so a timeout also stops the real CLI behind a wrapper script
    // (claude.cli_path can point at one).
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(|e| format!("Couldn't start the claude CLI: {e}"))?;
    on_start(child.id());
    let written = child.stdin.take().unwrap().write_all(input.as_bytes());
    if let Err(e) = written {
        kill_tree(&mut child);
        return Err(e.to_string());
    }
    let output = wait_with_timeout(child, timeout)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(&stdout).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("claude CLI failed: {}", if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() })
    })?;
    if result["is_error"].as_bool() == Some(true) {
        return Err(format!("claude CLI error: {}", result["result"].as_str().unwrap_or("unknown")));
    }
    Ok(result["structured_output"].clone())
}

/// `wait_with_output`, but the process is killed if it runs longer than `timeout`.
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> Result<std::process::Output, String> {
    use std::io::Read;
    // Both pipes are read while waiting, so a full pipe can't stall the CLI.
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            return Err(format!("The claude CLI didn't answer within {}s and was stopped.", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    Ok(std::process::Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Kills a run's whole process group (see `run_structured`).
pub fn kill_group(pgid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pgid as libc::pid_t), libc::SIGKILL);
    }
}

/// Kills the child's whole process group and reaps it.
fn kill_tree(child: &mut std::process::Child) {
    kill_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn spawn_grouped(script: &str) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        Command::new("sh")
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn wait_with_timeout_returns_output() {
        let out = wait_with_timeout(spawn_grouped("echo hi; echo err >&2"), Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, b"hi\n");
        assert_eq!(out.stderr, b"err\n");
    }

    #[cfg(unix)]
    #[test]
    fn wait_with_timeout_kills_the_whole_group() {
        // Like a wrapper script: the shell waits on a child that does the work.
        let child = spawn_grouped("sleep 30; true");
        let pgid = child.id() as libc::pid_t;
        let started = Instant::now();
        assert!(wait_with_timeout(child, Duration::from_millis(500)).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        // Nothing is left in the group once the orphaned `sleep` (killed too) has been reaped.
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            (unsafe { libc::kill(-pgid, 0) }) == -1
        });
        assert!(gone, "process group {pgid} still has processes");
    }
}
