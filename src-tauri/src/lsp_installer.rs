//! Language-server discovery and (consented) installation.
//!
//! Two things to keep in mind here:
//!
//! 1. Installing software is a privileged, user-visible act. This module never
//!    installs anything without an explicit OS confirmation dialog, and the
//!    package name is only ever read from `SUPPORTED` below -- never from the
//!    webview. The frontend can pick a language key, nothing more.
//! 2. A bundled `.app` launched from Finder inherits launchd's minimal PATH
//!    (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell's, so plain
//!    `which brew` fails on most Macs. We search an augmented path instead.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const EVENT_PROGRESS: &str = "lsp:progress";

/// (language key, binary to look for, Homebrew formula). The formula is a
/// compile-time constant so nothing user-controlled reaches the command line.
const SUPPORTED: &[(&str, &str, &str)] = &[
    ("rust", "rust-analyzer", "rust-analyzer"),
    ("python", "pylsp", "python-lsp-server"),
    ("typescript", "typescript-language-server", "typescript-language-server"),
    ("javascript", "typescript-language-server", "typescript-language-server"),
];

/// Directories a GUI process won't have on PATH but where these tools live.
const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",                    // Homebrew, Apple Silicon
    "/usr/local/bin",                       // Homebrew, Intel
    "/opt/local/bin",                       // MacPorts
    "/home/linuxbrew/.linuxbrew/bin",       // Linuxbrew
];

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

pub(crate) fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    for extra in EXTRA_BIN_DIRS {
        let dir = PathBuf::from(extra);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        for suffix in [".cargo/bin", ".local/bin"] {
            let dir = PathBuf::from(&home).join(suffix);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

fn resolve_binary(name: &str) -> Option<PathBuf> {
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

/// Keep failure output short enough to fit in a toast without truncating the
/// part that actually says what went wrong (which is at the end).
fn tail(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth_back(limit.saturating_sub(1)) {
        Some((start, _)) if start > 0 => format!("...{}", &trimmed[start..]),
        _ => trimmed.to_string(),
    }
}

fn confirm_install(app: &AppHandle, binary: &str, brew: &Path, formula: &str) -> bool {
    app.dialog()
        .message(format!(
            "{binary} is not installed.\n\n\
             AfterEdit can install it by running:\n\n    {} install {formula}\n\n\
             This downloads and installs software on your machine.",
            brew.display()
        ))
        .title("Install language server?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".to_string(),
            "Not now".to_string(),
        ))
        .blocking_show()
}

fn no_package_manager(binary: &str, formula: &str) -> String {
    // MacPorts needs root, and escalating privileges out of a sandboxed GUI app
    // is a design decision of its own. Rather than run `port install` without
    // sudo (which always fails), hand the user the command that works.
    if let Some(port) = resolve_binary("port") {
        format!(
            "{binary} is not installed and Homebrew was not found.\n\
             MacPorts is available, but its installs need root. Run:\n\n    sudo {} install {formula}",
            port.display()
        )
    } else {
        format!(
            "{binary} is not installed and Homebrew was not found.\n\
             Install Homebrew from https://brew.sh, or install '{formula}' yourself."
        )
    }
}

/// Blocking. Must not be called on the main thread -- `blocking_show` deadlocks
/// there, and `brew install` takes minutes.
fn ensure_installed(app: &AppHandle, binary: &str, formula: &str) -> Result<String, String> {
    if let Some(path) = resolve_binary(binary) {
        return Ok(format!("{binary} is ready ({})", path.display()));
    }

    let brew = resolve_binary("brew").ok_or_else(|| no_package_manager(binary, formula))?;

    if !confirm_install(app, binary, &brew, formula) {
        return Err(format!("Installation of {binary} was declined."));
    }

    let _ = app.emit(EVENT_PROGRESS, format!("Installing {formula} with Homebrew..."));

    let output = Command::new(&brew)
        .arg("install")
        .arg(formula)
        .output()
        .map_err(|e| format!("could not run {}: {e}", brew.display()))?;

    if !output.status.success() {
        // A bundled app has no visible stdout, so inherited output is lost.
        // Capture it and surface the reason instead of a generic failure.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(format!(
            "`brew install {formula}` failed ({}):\n{}",
            output.status,
            tail(&detail, 600)
        ));
    }

    let path = resolve_binary(binary).ok_or_else(|| {
        format!("brew reported success but {binary} is still not on any known path")
    })?;

    let _ = app.emit(EVENT_PROGRESS, format!("{binary} installed."));
    Ok(format!("{binary} is ready ({})", path.display()))
}

#[tauri::command]
pub async fn check_and_install_lsp(app: AppHandle, language: String) -> Result<String, String> {
    let (binary, formula) = SUPPORTED
        .iter()
        .find(|(key, _, _)| *key == language)
        .map(|(_, binary, formula)| (*binary, *formula))
        .ok_or_else(|| format!("no language server configured for '{language}'"))?;

    // Off the main thread: the confirmation dialog blocks, and so does brew.
    tauri::async_runtime::spawn_blocking(move || ensure_installed(&app, binary, formula))
        .await
        .map_err(|e| format!("language server install task failed: {e}"))?
}
