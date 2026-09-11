use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Emitter;
#[derive(Default)]
pub struct TaskState(pub Arc<Mutex<Option<u32>>>);
#[derive(Deserialize)]
pub struct Task {
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    #[serde(rename = "timeoutSeconds")]
    timeout_seconds: Option<u64>,
}
#[derive(Serialize)]
pub struct TaskResult {
    code: i32,
    output: String,
}
#[derive(Clone, Serialize)]
struct Output {
    text: String,
}
fn reader(
    mut input: impl Read + Send + 'static,
    app: tauri::AppHandle,
    capture: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Lossy conversion is only for task logs; source files remain strict UTF-8.
        while let Ok(n) = input.read(&mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(mut text) = capture.lock() {
                text.push_str(&String::from_utf8_lossy(&buf[..n]));
                if text.len() > 200000 {
                    let mut cut = text.len() - 200000;
                    while !text.is_char_boundary(cut) {
                        cut += 1;
                    }
                    text.drain(..cut);
                }
            }
            let _ = app.emit(
                "task:output",
                Output {
                    text: String::from_utf8_lossy(&buf[..n]).into_owned(),
                },
            );
        }
    })
}
#[tauri::command]
pub async fn run_task(
    app: tauri::AppHandle,
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
    state: tauri::State<'_, TaskState>,
    root: String,
    cwd: String,
    task: Task,
    confirmation: Option<String>,
) -> Result<TaskResult, String> {
    // Before anything is spawned: a command that changes production has to be
    // confirmed by typing the context name. Costs nothing for ordinary tasks,
    // because only a destructive shape triggers the context probe.
    if let Some(challenge) = crate::guard::challenge_for_task(
        Some(std::path::Path::new(&root)),
        &task.command,
        &task.args,
    ) {
        if !crate::guard::answered(&challenge, confirmation.as_deref()) {
            return Err(format!(
                "`{}` targets {} and was not confirmed. Type the context name to run it.",
                challenge.action, challenge.expected
            ));
        }
    }

    let timeout = task.timeout_seconds.unwrap_or(900);
    if !(1..=3600).contains(&timeout) {
        return Err("Timeout must be 1–3600 seconds".into());
    }
    let directory = crate::workspace::task_directory(workspace, root, cwd)?;
    let running = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = running.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("A task is already running".into());
        }
        let mut cmd = Command::new(&task.command);
        // Finder launches with a minimal PATH; include common toolchain locations
        // without sourcing shell startup files or executing repository scripts.
        let mut paths: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(std::path::PathBuf::from(&home).join(".cargo/bin"));
            paths.push(std::path::PathBuf::from(home).join(".local/bin"));
        }
        #[cfg(unix)]
        for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            paths.push(path.into());
        }
        if let Ok(path) = std::env::join_paths(paths) {
            cmd.env("PATH", path);
        }

        cmd.args(&task.args)
            .current_dir(directory)
            .envs(task.env.unwrap_or_default())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Cannot start {}: {e}. Install the toolchain or configure its full path.",
                task.command
            )
        })?;
        *guard = Some(child.id());
        drop(guard);
        let capture = Arc::new(Mutex::new(String::new()));
        let _out = reader(child.stdout.take().unwrap(), app.clone(), capture.clone());
        let _err = reader(child.stderr.take().unwrap(), app, capture.clone());
        let start = Instant::now();
        let result = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.code().unwrap_or(-1)),
                Err(e) => break Err(e.to_string()),
                _ => {}
            }
            if start.elapsed() > Duration::from_secs(timeout) {
                kill(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("Task stopped after {timeout} seconds"));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        // Stop descendant servers left behind by a completed task.
        kill(child.id());
        let _ = _out.join();
        let _ = _err.join();
        *running.lock().map_err(|e| e.to_string())? = None;
        result.map(|code| TaskResult {
            code,
            output: capture.lock().map(|text| text.clone()).unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}
impl TaskState {
    pub fn shutdown(&self) {
        if let Ok(guard) = self.0.lock() {
            if let Some(pid) = *guard {
                kill(pid);
            }
        }
    }
}
#[tauri::command]
pub fn cancel_task(state: tauri::State<'_, TaskState>) {
    state.shutdown();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    #[test]
    fn cancellation_stops_running_task() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let state = TaskState::default();
        *state.0.lock().unwrap() = Some(child.id());
        state.shutdown();
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            if start.elapsed() > Duration::from_secs(3) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Task cancellation timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
