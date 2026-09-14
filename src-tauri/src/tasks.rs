use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
#[derive(Default, Clone)]
pub struct TaskState(Arc<Mutex<Option<ActiveTask>>>);
struct ActiveTask {
    pid: u32,
    id: u64,
    cancelled: bool,
}
#[derive(Deserialize)]
pub struct Task {
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    #[serde(rename = "timeoutSeconds")]
    timeout_seconds: Option<u64>,
    #[serde(rename = "testReporter")]
    test_reporter: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    code: i32,
    output: String,
    status: String,
    run_id: u64,
    duration_ms: u64,
    error: Option<String>,
    sequence: u64,
    output_truncated: bool,
    stdout: String,
    stdout_truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunEvent {
    run_id: u64,
    request_id: String,
    sequence: u64,
    elapsed_ms: u64,
    kind: String,
    text: String,
    result: Option<TaskResult>,
}
pub(crate) type Emit = Arc<dyn Fn(RunEvent) + Send + Sync>;
struct Journal {
    id: u64,
    request: String,
    sequence: u64,
    start: Instant,
    output: String,
    truncated: bool,
    stdout: String,
    stdout_truncated: bool,
    emit: Emit,
}
impl Journal {
    fn event(&mut self, kind: &str, text: String, result: Option<TaskResult>) {
        self.sequence += 1;
        (self.emit)(RunEvent {
            run_id: self.id,
            request_id: self.request.clone(),
            sequence: self.sequence,
            elapsed_ms: self.start.elapsed().as_millis() as u64,
            kind: kind.into(),
            text,
            result,
        });
    }
    fn output(&mut self, stream: &str, text: String) {
        if stream == "stdout" {
            self.stdout.push_str(&text);
            if self.stdout.len() > 200000 {
                self.stdout_truncated = true;
                let mut cut = self.stdout.len() - 200000;
                while !self.stdout.is_char_boundary(cut) {
                    cut += 1;
                }
                self.stdout.drain(..cut);
            }
        }
        self.output.push_str(&text);
        if self.output.len() > 200000 {
            self.truncated = true;
            let mut cut = self.output.len() - 200000;
            while !self.output.is_char_boundary(cut) {
                cut += 1;
            }
            self.output.drain(..cut);
        }
        self.event(stream, text, None);
    }
}
// Keep incomplete UTF-8 code points between pipe reads.
fn decode(bytes: &mut Vec<u8>, eof: bool) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(s) => {
                text.push_str(s);
                bytes.clear();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(std::str::from_utf8(&bytes[..valid]).unwrap());
                bytes.drain(..valid);
                if let Some(n) = e.error_len() {
                    text.push('\u{fffd}');
                    bytes.drain(..n);
                } else {
                    if eof {
                        text.push_str(&String::from_utf8_lossy(bytes));
                        bytes.clear();
                    }
                    break;
                }
            }
        }
    }
    text
}
fn reader(
    mut input: impl Read + Send + 'static,
    stream: &'static str,
    journal: Arc<Mutex<Journal>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            let n = match input.read(&mut buf) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => 0,
            };
            pending.extend_from_slice(&buf[..n]);
            let text = decode(&mut pending, n == 0);
            if !text.is_empty() {
                if let Ok(mut j) = journal.lock() {
                    j.output(stream, text);
                }
            }
            if n == 0 {
                break;
            }
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
    request_id: Option<String>,
) -> Result<TaskResult, String> {
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
    let directory = crate::workspace::task_directory(workspace, root, cwd)?;
    let state = state.inner().clone();
    let emit: Emit = Arc::new(move |event| {
        // Legacy listeners are retained while all new monitoring uses correlated events.
        if event.kind == "stdout" || event.kind == "stderr" {
            let _ = app.emit(
                "task:output",
                serde_json::json!({"text":event.text,"runId":event.run_id}),
            );
        }
        let _ = app.emit("task:event", event);
    });
    tauri::async_runtime::spawn_blocking(move || {
        execute(
            task,
            directory.into(),
            state,
            request_id.unwrap_or_default(),
            emit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn execute(
    mut task: Task,
    directory: std::path::PathBuf,
    state: TaskState,
    request: String,
    emit: Emit,
) -> Result<TaskResult, String> {
    let timeout = task.timeout_seconds.unwrap_or(900);
    if !(1..=3600).contains(&timeout) {
        return Err("Timeout must be 1–3600 seconds".into());
    }
    let id = NEXT_RUN.fetch_add(1, Ordering::SeqCst);
    let journal = Arc::new(Mutex::new(Journal {
        id,
        request,
        sequence: 0,
        start: Instant::now(),
        output: String::new(),
        truncated: false,
        stdout: String::new(),
        stdout_truncated: false,
        emit,
    }));
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("A task is already running".into());
    }
    if let Some(reporter) = task.test_reporter.as_deref() {
        if reporter == "node" {
            if !task.args.iter().any(|a| a == "--test")
                || task.args.iter().any(|a| a.starts_with("--test-reporter"))
            {
                return Err(
                    "Node reporter requires a direct node --test command without other reporters"
                        .into(),
                );
            }
            let source = include_str!("../../scripts/node-test-reporter.mjs");
            let encoded: String = source
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect();
            task.args.insert(
                0,
                format!("--test-reporter=data:text/javascript,{}", encoded),
            );
        } else if reporter != "go" {
            return Err("Unknown test reporter".into());
        }
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

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let mut j = journal.lock().unwrap();
            let result = TaskResult {
                code: -1,
                output: String::new(),
                status: "spawnError".into(),
                run_id: id,
                duration_ms: j.start.elapsed().as_millis() as u64,
                error: Some(format!("Cannot start {}: {e}", task.command)),
                sequence: j.sequence + 1,
                output_truncated: false,
                stdout: String::new(),
                stdout_truncated: false,
            };
            j.event("finished", String::new(), Some(result.clone()));
            return Ok(result);
        }
    };
    *guard = Some(ActiveTask {
        pid: child.id(),
        id,
        cancelled: false,
    });
    drop(guard);
    journal
        .lock()
        .unwrap()
        .event("started", String::new(), None);
    let out = reader(child.stdout.take().unwrap(), "stdout", journal.clone());
    let err = reader(child.stderr.take().unwrap(), "stderr", journal.clone());
    let start = Instant::now();
    let (code, mut status, error) = loop {
        let cancelled = state
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .is_some_and(|a| a.id == id && a.cancelled);
        if cancelled {
            kill(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break (-1, "cancelled", None);
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                break (
                    s.code().unwrap_or(-1),
                    if s.success() { "succeeded" } else { "failed" },
                    None,
                )
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break (-1, "error", Some(e.to_string()));
            }
            _ => {}
        }
        if start.elapsed() >= Duration::from_secs(timeout) {
            kill(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break (
                -1,
                "timedOut",
                Some(format!("Task stopped after {timeout} seconds")),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    kill(child.id());
    let _ = out.join();
    let _ = err.join();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().is_some_and(|a| a.id == id && a.cancelled) {
        status = "cancelled";
    }
    let mut j = journal.lock().unwrap();
    let result = TaskResult {
        code: if status == "cancelled" { -1 } else { code },
        output: j.output.clone(),
        status: status.into(),
        run_id: id,
        duration_ms: j.start.elapsed().as_millis() as u64,
        error,
        sequence: j.sequence + 1,
        output_truncated: j.truncated,
        stdout: j.stdout.clone(),
        stdout_truncated: j.stdout_truncated,
    };
    j.event("finished", String::new(), Some(result.clone()));
    *guard = None;
    Ok(result)
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
    pub(crate) fn cancel(&self, id: Option<u64>) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(active) = guard.as_mut() {
                if id.is_none_or(|id| id == active.id) {
                    active.cancelled = true;
                    kill(active.pid);
                }
            }
        }
    }
    pub fn shutdown(&self) {
        self.cancel(None);
    }
}
#[tauri::command]
pub fn cancel_task(state: tauri::State<'_, TaskState>, run_id: Option<u64>) {
    state.cancel(run_id);
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn task(script: &str) -> Task {
        Task {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: None,
            timeout_seconds: Some(1),
            test_reporter: None,
        }
    }
    #[test]
    fn utf8_decoder_preserves_split_codepoints() {
        let mut bytes = vec![0xf0, 0x9f];
        assert_eq!(decode(&mut bytes, false), "");
        bytes.extend([0x98, 0x80]);
        assert_eq!(decode(&mut bytes, false), "😀");
    }
    #[test]
    fn timeout_keeps_output_and_finishes_after_readers() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e = events.clone();
        let r = execute(
            task("printf before; sleep 5"),
            std::env::temp_dir(),
            TaskState::default(),
            "test".into(),
            Arc::new(move |v| e.lock().unwrap().push(v)),
        )
        .unwrap();
        assert_eq!(r.status, "timedOut");
        assert_eq!(r.output, "before");
        let events = events.lock().unwrap();
        assert_eq!(events.last().unwrap().kind, "finished");
        for pair in events.windows(2) {
            assert!(pair[1].sequence > pair[0].sequence);
        }
    }
    #[test]
    fn cancellation_targets_only_the_selected_run() {
        let state = TaskState::default();
        let cancel = state.clone();
        let r = execute(
            task("printf ready; sleep 5"),
            std::env::temp_dir(),
            state,
            "test".into(),
            Arc::new(move |v| {
                if v.kind == "started" {
                    cancel.cancel(Some(v.run_id + 1));
                    assert!(!cancel.0.lock().unwrap().as_ref().unwrap().cancelled);
                    cancel.cancel(Some(v.run_id));
                }
            }),
        )
        .unwrap();
        assert_eq!(r.status, "cancelled");
    }
    #[test]
    fn normal_and_spawn_error_outcomes() {
        let r = execute(
            task("printf out; printf err >&2; exit 3"),
            std::env::temp_dir(),
            TaskState::default(),
            "".into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        assert_eq!(r.code, 3);
        assert_eq!(r.status, "failed");
        assert!(r.output.contains("out") && r.output.contains("err"));
        let mut t = task("");
        t.command = "/nonexistent/afteredit-tool".into();
        let r = execute(
            t,
            std::env::temp_dir(),
            TaskState::default(),
            "".into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        assert_eq!(r.status, "spawnError");
    }
    #[test]
    fn native_node_reporter_emits_cases_and_retains_final_output() {
        let root =
            std::env::temp_dir().join(format!("afteredit-native-reporter-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("test.mjs");
        std::fs::write(&file,"import {test} from 'node:test';import assert from 'node:assert/strict';test('broken',()=>assert.equal(2,1));").unwrap();
        let mut t = task("");
        t.command = "node".into();
        t.args = vec!["--test".into(), file.to_string_lossy().into()];
        t.test_reporter = Some("node".into());
        t.timeout_seconds = Some(15);
        let events = Arc::new(Mutex::new(Vec::new()));
        let e = events.clone();
        let r = execute(
            t,
            root.clone(),
            TaskState::default(),
            "node-test".into(),
            Arc::new(move |v| e.lock().unwrap().push(v)),
        )
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(r.code, 1, "{:?}", r);
        assert!(r.output.contains("\"status\":\"failed\""));
        assert!(r.output.contains("\"kind\":\"complete\""));
        let events = events.lock().unwrap();
        assert_eq!(events.first().unwrap().kind, "started");
        assert_eq!(events.last().unwrap().kind, "finished");
    }
    #[test]
    fn output_is_bounded_and_overlapping_launch_is_rejected() {
        let r = execute(
            task("head -c 210000 /dev/zero | tr '\\0' x"),
            std::env::temp_dir(),
            TaskState::default(),
            "".into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        assert_eq!(r.output.len(), 200000);
        let state = TaskState::default();
        *state.0.lock().unwrap() = Some(ActiveTask {
            pid: 0,
            id: 1,
            cancelled: false,
        });
        assert!(execute(
            task("exit 0"),
            std::env::temp_dir(),
            state,
            "".into(),
            Arc::new(|_| {})
        )
        .unwrap_err()
        .contains("already running"));
    }
}
