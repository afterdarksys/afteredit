//! Native PTY session backing the terminal panel.
//!
//! The whole session (master fd, writer, child killer) has to outlive the
//! command that creates it: dropping the master closes the pty, which SIGHUPs
//! the shell. So everything lives in managed state, not in `spawn_pty` locals.

use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Emitted for every chunk read off the pty, base64 encoded.
const EVENT_OUTPUT: &str = "pty:output";
/// Emitted once, with the shell's exit code, when the session ends.
const EVENT_EXIT: &str = "pty:exit";

const READ_BUF: usize = 8192;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
    });
    Ok(true)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(lock_err)?;
    let session = slot.as_mut().ok_or("no active pty session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
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
