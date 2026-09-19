//! Locating developer tools from a GUI process.
//!
//! A bundled `.app` launched from Finder inherits launchd's minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell's. Everything a
//! developer actually uses -- Homebrew, cargo, and every version manager --
//! lives somewhere else, so plain `which` finds almost nothing.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Absolute directories to search in addition to whatever PATH we inherited.
const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",              // Homebrew, Apple Silicon
    "/opt/homebrew/sbin",
    "/usr/local/bin",                 // Homebrew, Intel
    "/usr/local/sbin",
    "/opt/local/bin",                 // MacPorts
    "/home/linuxbrew/.linuxbrew/bin", // Linuxbrew
    "/snap/bin",
];

/// Version-manager shim and install directories, relative to $HOME. These
/// matter more than Homebrew for this audience: asdf and mise are how most
/// people get terraform, go and node.
const HOME_BIN_DIRS: &[&str] = &[
    ".asdf/shims",
    ".local/share/mise/shims",
    ".local/bin",
    ".cargo/bin",
    "go/bin",
    ".volta/bin",
    ".bun/bin",
    ".pyenv/shims",
    ".rbenv/shims",
    "bin",
];

pub fn is_executable(path: &Path) -> bool {
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

pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    let mut push = |dir: PathBuf| {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    for extra in EXTRA_BIN_DIRS {
        push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME") {
        for suffix in HOME_BIN_DIRS {
            push(PathBuf::from(&home).join(suffix));
        }
    }
    dirs
}

/// Environment keys a task, language server or debug adapter must not set.
///
/// Threats: stops `.afteredit.json` / XSS `run_task` from replacing PATH or
/// injecting a linker, git helper or shell. Does NOT stop a trusted executable
/// from reading the ambient environment, and does not apply to the PTY.
const BLOCKED_ENV: &[&str] = &[
    "PATH",
    "PATHEXT",
    "IFS",
    "SHELL",
    "BASH_ENV",
    "ENV",
    "SSH_AUTH_SOCK",
    "SSH_COMMAND",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];

pub fn blocked_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    BLOCKED_ENV.iter().any(|blocked| upper == *blocked)
        || upper.starts_with("GIT_")
        || upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
}

/// Apply caller-supplied environment after PATH has been set, refusing overrides.
pub fn apply_user_env(
    cmd: &mut std::process::Command,
    env: impl IntoIterator<Item = (impl AsRef<str>, impl AsRef<OsStr>)>,
) -> Result<(), String> {
    for (key, value) in env {
        let key = key.as_ref();
        if blocked_env_key(key) {
            return Err(format!("Task env cannot override {key}"));
        }
        cmd.env(key, value);
    }
    Ok(())
}

/// First executable named `name` on the augmented search path.
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

/// Keep tool output short enough for a toast, keeping the tail -- which is
/// where the actual reason lives.
pub fn tail(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth_back(limit.saturating_sub(1)) {
        Some((start, _)) if start > 0 => format!("...{}", &trimmed[start..]),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loader_and_path_overrides_are_blocked() {
        for key in [
            "PATH",
            "path",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "GIT_SSH_COMMAND",
            "GIT_DIR",
            "SHELL",
        ] {
            assert!(blocked_env_key(key), "{key} must be blocked");
        }
        for key in ["AWS_PROFILE", "KUBECONFIG", "TF_VAR_region", "RUST_LOG"] {
            assert!(!blocked_env_key(key), "{key} is a legitimate task variable");
        }
    }

    #[test]
    fn apply_user_env_refuses_a_path_override() {
        let mut cmd = std::process::Command::new("true");
        let err = apply_user_env(&mut cmd, [("PATH", "/tmp/evil")]).unwrap_err();
        assert!(err.contains("PATH"));
        apply_user_env(&mut cmd, [("AWS_PROFILE", "dev")]).unwrap();
    }
}
