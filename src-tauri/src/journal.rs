//! Operator journal: an append-only local log of confirmed mutations.
//!
//! Threats: this records *that* a production confirm, Terraform apply, git
//! commit or agent edit happened, so an operator can reconstruct what they
//! did. It does NOT record file contents, environment values, API keys, or
//! the typed confirmation string beyond the already-visible context name.
//! It is not a tamper-proof audit log: it lives in the app data directory
//! (0700) on the same machine, and a determined user can edit the file.
//! It does NOT replace git history or a real SIEM.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_ENTRIES: usize = 500;
const MAX_FIELD: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub millis: u64,
    pub kind: String,
    pub action: String,
    pub context: String,
    pub path: String,
    pub root: String,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clip(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\0' && *c != '\n' && *c != '\r')
        .take(MAX_FIELD)
        .collect()
}

fn restrict_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(error)?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn restrict_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(error)?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn journal_path(dir: &Path) -> PathBuf {
    dir.join("journal.jsonl")
}

fn read_entries(path: &Path) -> Vec<Entry> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .filter_map(|line| {
            let line = line.ok()?;
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str(line).ok()
        })
        .collect()
}

fn write_entries(path: &Path, entries: &[Entry]) -> Result<(), String> {
    let temporary = path.with_extension("jsonl.tmp");
    {
        let mut file = fs::File::create(&temporary).map_err(error)?;
        for entry in entries {
            let line = serde_json::to_string(entry).map_err(error)?;
            writeln!(file, "{line}").map_err(error)?;
        }
    }
    fs::rename(&temporary, path).map_err(error)?;
    restrict_file(path)
}

/// Append one event. `kind` is taken from the caller, not the UI: the
/// frontend cannot invent kinds except through `journal_agent_edit`.
pub fn record(dir: &Path, kind: &str, action: &str, context: &str, path: &str, root: &str) -> Result<Entry, String> {
    record_capped(dir, kind, action, context, path, root, MAX_ENTRIES)
}

fn record_capped(
    dir: &Path,
    kind: &str,
    action: &str,
    context: &str,
    path: &str,
    root: &str,
    cap: usize,
) -> Result<Entry, String> {
    fs::create_dir_all(dir).map_err(error)?;
    restrict_dir(dir)?;
    let file = journal_path(dir);
    let entry = Entry {
        millis: now_millis(),
        kind: clip(kind),
        action: clip(action),
        context: clip(context),
        path: clip(path),
        root: clip(root),
    };
    let mut entries = read_entries(&file);
    entries.push(entry.clone());
    if entries.len() > cap {
        let skip = entries.len() - cap;
        entries.drain(..skip);
    }
    write_entries(&file, &entries)?;
    Ok(entry)
}

/// Newest first.
pub fn list(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = read_entries(&journal_path(dir));
    entries.reverse();
    Ok(entries)
}

fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(error)?.join("journal");
    fs::create_dir_all(&dir).map_err(error)?;
    restrict_dir(&dir)?;
    Ok(dir)
}

/// Best effort: failing to journal must not undo a mutation that already
/// passed its gates. The file is a reconstruction aid, not a precondition.
pub fn record_app(app: &AppHandle, kind: &str, action: &str, context: &str, path: &str, root: &str) {
    if let Ok(dir) = store_root(app) {
        let _ = record(&dir, kind, action, context, path, root);
    }
}

#[tauri::command]
pub fn journal_list(app: AppHandle) -> Result<Vec<Entry>, String> {
    list(&store_root(&app)?)
}

/// Record that the agent edited a project file. Path only — never contents.
#[tauri::command]
pub fn journal_agent_edit(
    app: AppHandle,
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: String,
    path: String,
) -> Result<(), String> {
    let root = crate::workspace::allowed(&state, Path::new(&root))?;
    if path.is_empty()
        || Path::new(&path).is_absolute()
        || path.contains('\0')
        || path.split(['/', '\\']).any(|part| part == ".." || part.is_empty())
    {
        return Err("Agent journal path must be a relative file inside the project".into());
    }
    let _ = crate::workspace::allowed(&state, &root.join(&path))?;
    record(
        &store_root(&app)?,
        "agent-edit",
        "agent edit",
        "",
        &path,
        &root.display().to_string(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "afteredit-journal-{}-{}-{}",
            name,
            std::process::id(),
            now_millis()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn entries_are_appended_and_listed_newest_first() {
        let dir = store("order");
        record(&dir, "confirm", "kubectl delete", "acme-prod", "", "/w").unwrap();
        record(&dir, "commit", "git commit", "", "abc123", "/w").unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].kind, "commit");
        assert_eq!(listed[1].kind, "confirm");
        assert_eq!(listed[1].context, "acme-prod");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_journal_drops_the_oldest_entries() {
        let dir = store("cap");
        for index in 0..5 {
            record_capped(&dir, "confirm", &format!("action-{index}"), "", "", "/w", 3).unwrap();
        }
        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].action, "action-4");
        assert_eq!(listed[2].action, "action-2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newlines_and_nuls_cannot_break_jsonl() {
        let dir = store("sanitize");
        record(&dir, "confirm", "terraform apply\nAKIAFAKE", "prod\0x", "a\nb", "/w").unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed[0].action, "terraform applyAKIAFAKE");
        assert!(!listed[0].action.contains('\n'));
        assert!(!listed[0].context.contains('\0'));
        let raw = fs::read_to_string(journal_path(&dir)).unwrap();
        assert_eq!(raw.lines().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let dir = store("malformed");
        fs::write(journal_path(&dir), "not json\n{\"millis\":1,\"kind\":\"commit\",\"action\":\"git commit\",\"context\":\"\",\"path\":\"\",\"root\":\"/w\"}\n").unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "commit");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_paths_must_stay_relative() {
        // The command's path check is independent of Tauri state.
        for bad in ["", "/etc/passwd", "../escape", "a/../b", "a\0b"] {
            let rejected = Path::new(bad).is_absolute()
                || bad.is_empty()
                || bad.contains('\0')
                || bad.split(['/', '\\']).any(|part| part == ".." || part.is_empty());
            assert!(rejected, "{bad:?} must be rejected");
        }
    }
}
