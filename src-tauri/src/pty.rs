//! Native PTY session backing the terminal panel.
//!
//! The whole session (master fd, writer, child killer) has to outlive the
//! command that creates it: dropping the master closes the pty, which SIGHUPs
//! the shell. So everything lives in managed state, not in `spawn_pty` locals.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::guard::{answered, Challenge};
use crate::pty_gate::{challenge_for_line, LineTracker, Step};

/// Emitted for every chunk read off the pty, base64 encoded.
const EVENT_OUTPUT: &str = "pty:output";
/// Emitted once, with the shell's exit code, when the session ends.
const EVENT_EXIT: &str = "pty:exit";
/// Enter was withheld; the UI must answer with `pty_confirm`.
const EVENT_CHALLENGE: &str = "pty:challenge";

const READ_BUF: usize = 8192;

struct HeldEnter {
    newline: Vec<u8>,
    rest: Vec<u8>,
    generation: u64,
    challenge: Option<Challenge>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    tracker: LineTracker,
    held: Option<HeldEnter>,
    generation: u64,
}

#[derive(Default)]
pub struct PtyState(Mutex<Option<PtySession>>);

impl PtyState {
    /// Kill the shell on app exit so we don't orphan it.
    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(mut session) = slot.take() {
                let _ = session.killer.kill();
            }
        }
    }
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        // A zero-sized pty makes the shell think the window has no room and
        // some programs divide by it, so floor at 1x1.
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn lock_err(_: impl std::fmt::Debug) -> String {
    "pty state lock poisoned".to_string()
}

#[tauri::command]
/// Returns `true` if a shell was started, `false` if one was already running.
/// The caller uses that to tell "fresh session" from "reattached", since a
/// reattached xterm starts blank until the shell next writes.
pub fn spawn_pty(app: AppHandle, state: State<'_, PtyState>, rows: u16, cols: u16) -> Result<bool, String> {
    let mut slot = state.0.lock().map_err(lock_err)?;
    // Idempotent: React StrictMode remounts and webview reloads both re-invoke
    // this, and neither should fork a second shell.
    if slot.is_some() {
        return Ok(false);
    }

    let pair = native_pty_system()
        .openpty(pty_size(rows, cols))
        .map_err(|e| format!("could not open pty: {e}"))?;

    // Resolves $SHELL, falling back to the passwd entry, and inherits the
    // parent environment.
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // $EDITOR and friends, so `git commit` and `kubectl edit` open a tab here
    // instead of vi inside this pane.
    for (key, value) in app.state::<crate::editor_bridge::EditorBridge>().environment() {
        cmd.env(key, value);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not spawn shell: {e}"))?;
    let killer = child.clone_killer();

    // The slave fd has to go, or the reader below never sees EOF when the
    // shell exits and the session hangs open forever.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let output_app = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                // Base64 because a read can land mid-UTF-8-sequence. xterm
                // reassembles the byte stream itself when fed a Uint8Array.
                Ok(n) => {
                    if output_app.emit(EVENT_OUTPUT, B64.encode(&buf[..n])).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = app.emit(EVENT_EXIT, code);
    });

    *slot = Some(PtySession {
        master: pair.master,
        writer,
        killer,
        tracker: LineTracker::default(),
        held: None,
        generation: 0,
    });
    Ok(true)
}

fn write_raw(session: &mut PtySession, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    session
        .writer
        .write_all(bytes)
        .and_then(|()| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

fn ingest(session: &mut PtySession, data: &str) -> Result<Option<(String, u64)>, String> {
    if data.is_empty() {
        return Ok(None);
    }
    if let Some(held) = session.held.as_mut() {
        if data.as_bytes().contains(&0x03) {
            session.held = None;
            session.tracker.reset();
            write_raw(session, &[0x03])?;
            return Ok(None);
        }
        held.rest.extend_from_slice(data.as_bytes());
        return Ok(None);
    }
    match session.tracker.feed(data) {
        Step::Pass(bytes) => {
            write_raw(session, &bytes)?;
            Ok(None)
        }
        Step::Hold {
            passed,
            line,
            newline,
            rest,
        } => {
            write_raw(session, &passed)?;
            session.generation += 1;
            let generation = session.generation;
            session.held = Some(HeldEnter {
                newline,
                rest,
                generation,
                challenge: None,
            });
            Ok(Some((line, generation)))
        }
    }
}

fn resolve_root(
    workspace: &tauri::State<'_, crate::workspace::WorkspaceState>,
    root: Option<String>,
) -> Option<PathBuf> {
    root.and_then(|path| crate::workspace::allowed(workspace, std::path::Path::new(&path)).ok())
}

async fn gate_pending(
    app: &AppHandle,
    state: &State<'_, PtyState>,
    mut line: String,
    mut generation: u64,
    root: Option<PathBuf>,
) -> Result<(), String> {
    loop {
        let probe_root = root.clone();
        let probe_line = line.clone();
        let challenge = tauri::async_runtime::spawn_blocking(move || {
            challenge_for_line(probe_root.as_deref(), &probe_line)
        })
        .await
        .map_err(|e| e.to_string())?;

        let next = {
            let mut slot = state.0.lock().map_err(lock_err)?;
            let session = slot.as_mut().ok_or("no active pty session")?;
            let Some(held) = session.held.as_mut() else {
                return Ok(());
            };
            if held.generation != generation {
                return Ok(());
            }
            if let Some(challenge) = challenge {
                held.challenge = Some(challenge.clone());
                let _ = app.emit(EVENT_CHALLENGE, challenge);
                return Ok(());
            }
            let held = session.held.take().expect("held checked above");
            write_raw(session, &held.newline)?;
            if held.rest.is_empty() {
                return Ok(());
            }
            let rest = String::from_utf8_lossy(&held.rest).into_owned();
            ingest(session, &rest)?
        };
        match next {
            None => return Ok(()),
            Some((next_line, next_gen)) => {
                line = next_line;
                generation = next_gen;
            }
        }
    }
}

#[tauri::command]
pub async fn pty_write(
    app: AppHandle,
    state: State<'_, PtyState>,
    workspace: State<'_, crate::workspace::WorkspaceState>,
    data: String,
    root: Option<String>,
) -> Result<(), String> {
    let root = resolve_root(&workspace, root);
    let pending = {
        let mut slot = state.0.lock().map_err(lock_err)?;
        let session = slot.as_mut().ok_or("no active pty session")?;
        ingest(session, &data)?
    };
    if let Some((line, generation)) = pending {
        gate_pending(&app, &state, line, generation, root).await?;
    }
    Ok(())
}

/// Answer a withheld Enter. `None` cancels and sends Ctrl+C so the shell
/// drops the line that is still sitting in readline.
#[tauri::command]
pub async fn pty_confirm(
    app: AppHandle,
    state: State<'_, PtyState>,
    workspace: State<'_, crate::workspace::WorkspaceState>,
    typed: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let root = resolve_root(&workspace, root);
    let (pending, accepted) = {
        let mut slot = state.0.lock().map_err(lock_err)?;
        let session = slot.as_mut().ok_or("no active pty session")?;
        let Some(held) = session.held.take() else {
            return Ok(());
        };
        let Some(challenge) = held.challenge else {
            // Probe still in flight; never submit an unreviewed line.
            session.tracker.reset();
            write_raw(session, &[0x03])?;
            return Ok(());
        };
        if typed.is_none() || !answered(&challenge, typed.as_deref()) {
            session.tracker.reset();
            write_raw(session, &[0x03])?;
            return Ok(());
        }
        write_raw(session, &held.newline)?;
        let rest = if held.rest.is_empty() {
            None
        } else {
            let rest = String::from_utf8_lossy(&held.rest).into_owned();
            ingest(session, &rest)?
        };
        (rest, challenge)
    };
    let apply = crate::guard::is_infra_apply(
        accepted.action.split_whitespace().next().unwrap_or(""),
        &accepted
            .action
            .split_whitespace()
            .skip(1)
            .map(String::from)
            .collect::<Vec<_>>(),
    );
    crate::journal::record_app(
        &app,
        if apply { "apply" } else { "confirm" },
        &accepted.action,
        &accepted.expected,
        "",
        &root.as_ref().map(|path| path.display().to_string()).unwrap_or_default(),
    );
    if let Some((line, generation)) = pending {
        gate_pending(&app, &state, line, generation, root).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, rows: u16, cols: u16) -> Result<(), String> {
    let slot = state.0.lock().map_err(lock_err)?;
    let session = slot.as_ref().ok_or("no active pty session")?;
    session
        .master
        .resize(pty_size(rows, cols))
        .map_err(|e| format!("pty resize failed: {e}"))
}
