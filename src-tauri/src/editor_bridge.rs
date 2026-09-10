//! The `$EDITOR` bridge.
//!
//! Inside our terminal, `git commit`, `kubectl edit`, `crontab -e` and friends
//! all launch `$EDITOR` and block until it exits. This points that at a small
//! helper script which hands the file to the GUI and waits, so those commands
//! open a real editor tab instead of vi in a pane.
//!
//! Deliberately env-var based (`EDITOR`/`VISUAL`/`GIT_EDITOR`/`KUBE_EDITOR`)
//! rather than shadowing `vim` on PATH: someone who types `vim` meant `vim`.
//!
//! Protocol, chosen so the helper stays a POSIX shell script with no runtime
//! of its own:
//!   1. the helper mkfifo's its own release pipe, so nothing here needs mkfifo
//!   2. it appends "<id>\t<abs path>" to the requests fifo
//!   3. it blocks on `cat` of the release pipe
//!   4. the GUI writes an exit code there when the tab closes, which is what
//!      `git commit` reads to decide whether to proceed or abort

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::workspace::WorkspaceState;

pub const EVENT_REQUEST: &str = "editor:request";

const HELPER: &str = include_str!("../afteredit-edit.sh");

#[derive(Default)]
pub struct EditorBridge(Mutex<Option<Session>>);

pub struct Session {
    dir: PathBuf,
    helper: PathBuf,
}

#[derive(Clone, Serialize)]
struct Request {
    id: String,
    path: String,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl EditorBridge {
    /// Environment for the pty so intercepted commands reach us. Empty when
    /// the bridge could not start, which simply leaves the user with vi.
    pub fn environment(&self) -> Vec<(String, String)> {
        let guard = match self.0.lock() {
            Ok(guard) => guard,
            Err(_) => return Vec::new(),
        };
        let Some(session) = guard.as_ref() else {
            return Vec::new();
        };
        let helper = session.helper.display().to_string();
        ["EDITOR", "VISUAL", "GIT_EDITOR", "KUBE_EDITOR", "AFTEREDIT_BRIDGE"]
            .iter()
            .map(|key| ((*key).to_string(), helper.clone()))
            .collect()
    }

    fn release_path(&self, id: &str) -> Result<PathBuf, String> {
        // `id` comes from our own helper, but it still reaches us over a pipe
        // any process in the terminal can write to, so it must not be able to
        // name a path outside the release directory.
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err("invalid editor request id".into());
        }
        let guard = self.0.lock().map_err(error)?;
        let session = guard.as_ref().ok_or("the editor bridge is not running")?;
        Ok(session.dir.join("release").join(id))
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(session) = guard.take() {
                let _ = fs::remove_dir_all(&session.dir);
            }
        }
    }
}

/// Create the session directory, write the helper, and start listening.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<EditorBridge>();
    if state.0.lock().map_err(error)?.is_some() {
        return Ok(());
    }

    let dir = std::env::temp_dir().join(format!("afteredit-{}", std::process::id()));
    let release = dir.join("release");
    fs::create_dir_all(&release).map_err(error)?;
    restrict(&dir)?;

    let requests = dir.join("requests");
    let made = Command::new("mkfifo")
        .arg("-m")
        .arg("600")
        .arg(&requests)
        .status()
        .map_err(|e| format!("could not create the editor pipe: {e}"))?;
    if !made.success() {
        return Err("mkfifo failed while starting the editor bridge".into());
    }

    let helper = dir.join("afteredit-edit");
    fs::write(&helper, HELPER.replace("__SESSION_DIR__", &dir.display().to_string())).map_err(error)?;
    make_executable(&helper)?;

    let listener = app.clone();
    thread::spawn(move || listen(listener, requests));

    *state.0.lock().map_err(error)? = Some(Session { dir, helper });
    Ok(())
}

fn listen(app: AppHandle, requests: PathBuf) {
    loop {
        // Opening a fifo for reading blocks until a writer arrives, and yields
        // EOF once the last one leaves -- so reopening is the loop, not a busy
        // wait.
        let Ok(pipe) = fs::File::open(&requests) else {
            return;
        };
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let Some((id, path)) = line.split_once('\t') else {
                continue;
            };
            let request = Request { id: id.to_string(), path: path.to_string() };

            // The user asked for this file by running the command themselves,
            // in our own terminal. That is the same authority as picking it in
            // the open dialog, so grant it -- kubectl edit works on a temp file
            // outside every project root and would be refused otherwise.
            if let Ok(canonical) = Path::new(path).canonicalize() {
                if let Ok(mut access) = app.state::<WorkspaceState>().inner().0.lock() {
                    access.files.insert(canonical);
                }
            }

            if app.emit(EVENT_REQUEST, request).is_err() {
                return;
            }
        }
    }
}

/// Unblock the waiting command. `code` is its exit status: 0 lets `git commit`
/// proceed, anything else aborts it.
#[tauri::command]
pub fn editor_release(
    state: tauri::State<'_, EditorBridge>,
    id: String,
    code: i32,
) -> Result<(), String> {
    let path = state.release_path(&id)?;
    // Opening the release fifo for writing blocks until the helper is reading;
    // if it already gave up, the file is gone and there is nothing to release.
    if !path.exists() {
        return Err("that editor request is no longer waiting".into());
    }
    let mut pipe = fs::OpenOptions::new().write(true).open(&path).map_err(error)?;
    writeln!(pipe, "{code}").map_err(error)
}

fn restrict(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_cannot_escape_the_release_directory() {
        let bridge = EditorBridge(Mutex::new(Some(Session {
            dir: PathBuf::from("/tmp/afteredit-test"),
            helper: PathBuf::from("/tmp/afteredit-test/afteredit-edit"),
        })));
        for bad in ["../../etc/passwd", "a/b", "", "..", "id with space", "id;rm"] {
            assert!(bridge.release_path(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(
            bridge.release_path("1234-1700000000").unwrap(),
            PathBuf::from("/tmp/afteredit-test/release/1234-1700000000"),
        );
    }

    #[test]
    fn environment_is_empty_until_started() {
        let bridge = EditorBridge::default();
        assert!(bridge.environment().is_empty());
    }

    #[test]
    fn environment_points_every_editor_variable_at_the_helper() {
        let bridge = EditorBridge(Mutex::new(Some(Session {
            dir: PathBuf::from("/tmp/afteredit-test"),
            helper: PathBuf::from("/tmp/afteredit-test/afteredit-edit"),
        })));
        let environment = bridge.environment();
        let keys: Vec<&str> = environment.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"GIT_EDITOR") && keys.contains(&"KUBE_EDITOR") && keys.contains(&"EDITOR"));
        assert!(environment.iter().all(|(_, v)| v.ends_with("afteredit-edit")));
    }

    /// The whole point of the bridge: the calling command must stay blocked
    /// until the GUI releases it, and must receive the exit code we choose --
    /// that is what `git commit` reads to decide between applying and
    /// aborting. Exercises the real script over real fifos.
    #[cfg(unix)]
    fn helper_round_trip(label: &str, release_code: &str) -> Option<i32> {
        use std::io::BufRead;
        use std::process::Stdio;

        let dir = std::env::temp_dir().join(format!("afteredit-bridge-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("release")).unwrap();

        let requests = dir.join("requests");
        assert!(Command::new("mkfifo").arg(&requests).status().unwrap().success());

        let helper = dir.join("afteredit-edit");
        fs::write(&helper, HELPER.replace("__SESSION_DIR__", &dir.display().to_string())).unwrap();
        make_executable(&helper).unwrap();

        let target = dir.join("COMMIT_EDITMSG");
        fs::write(&target, "original\n").unwrap();

        let mut child = Command::new(&helper)
            .arg(&target)
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let pipe = fs::File::open(&requests).unwrap();
        let line = BufReader::new(pipe).lines().next().unwrap().unwrap();
        let (id, path) = line.split_once('\t').unwrap();
        assert_eq!(Path::new(path), target, "helper must report an absolute path");

        assert!(
            child.try_wait().unwrap().is_none(),
            "the command must still be blocked before we release it",
        );

        let mut release = fs::OpenOptions::new()
            .write(true)
            .open(dir.join("release").join(id))
            .unwrap();
        writeln!(release, "{release_code}").unwrap();
        drop(release);

        let status = child.wait().unwrap();
        let leftover = fs::read_dir(dir.join("release")).unwrap().count();
        assert_eq!(leftover, 0, "the helper must clean up its release pipe");
        let _ = fs::remove_dir_all(&dir);
        status.code()
    }

    #[cfg(unix)]
    #[test]
    fn releasing_with_zero_lets_the_command_proceed() {
        assert_eq!(helper_round_trip("ok", "0"), Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn releasing_with_nonzero_aborts_the_command() {
        assert_eq!(helper_round_trip("abort", "1"), Some(1));
    }

    #[test]
    fn the_helper_script_substitutes_its_session_directory() {
        assert!(HELPER.contains("__SESSION_DIR__"), "helper must carry the placeholder");
        let rendered = HELPER.replace("__SESSION_DIR__", "/tmp/x");
        assert!(!rendered.contains("__SESSION_DIR__"));
        assert!(rendered.starts_with("#!/bin/sh"));
    }
}
