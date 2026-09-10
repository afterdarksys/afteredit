//! Locating developer tools from a GUI process.
//!
//! A bundled `.app` launched from Finder inherits launchd's minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell's. Everything a
//! developer actually uses -- Homebrew, cargo, and every version manager --
//! lives somewhere else, so plain `which` finds almost nothing.

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
