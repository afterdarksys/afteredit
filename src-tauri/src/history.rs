//! Local history: every save recoverable, independent of version control.
//!
//! The motivating case is the `$EDITOR` bridge. `kubectl edit`, `crontab -e`
//! and `visudo` all work on temp files that are deleted the moment the command
//! returns, so editing a live Deployment currently leaves no record anywhere
//! of what changed. Snapshots here survive that.
//!
//! Threats: this deliberately copies file contents to a second location. The
//! store is 0700 under the app data directory, and key material (private
//! keys, certificates, .netrc, credentials files) is never snapshotted --
//! duplicating a private key to make undo nicer is a bad trade. It does NOT
//! encrypt at rest, so it is exactly as sensitive as the files it covers.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Bounds, so history never becomes an unbounded disk leak.
const MAX_ENTRIES: usize = 100;
const MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Never copied into the store. Losing undo on a private key beats making a
/// second copy of one.
const NEVER_SNAPSHOT: &[&str] = &[
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", "credentials", "kubeconfig",
];
const NEVER_SNAPSHOT_EXT: &[&str] = &["pem", "key", "p12", "pfx", "jks", "keystore", "asc", "gpg"];

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Label {
    Save,
    /// Taken before a terminal command edits the file, so the "before" of a
    /// `kubectl edit` survives the temp file being deleted.
    BridgeOpen,
    Restore,
}

impl Label {
    fn as_str(self) -> &'static str {
        match self {
            Label::Save => "save",
            Label::BridgeOpen => "bridge-open",
            Label::Restore => "restore",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "save" => Some(Label::Save),
            "bridge-open" => Some(Label::BridgeOpen),
            "restore" => Some(Label::Restore),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// Snapshot file name; also the handle used to read it back.
    pub id: String,
    pub millis: u64,
    pub label: Label,
    pub bytes: u64,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// FNV-1a. Hand-rolled because it must stay stable across Rust releases --
/// DefaultHasher explicitly does not, and these names are persisted.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Should this file be kept out of the store entirely?
pub fn excluded(file: &Path) -> bool {
    let name = file.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    if NEVER_SNAPSHOT.iter().any(|blocked| name == *blocked) {
        return true;
    }
    // `.env` is intentionally *not* excluded: it is one of the files people
    // most want to undo, and the commit gate already guards what leaves.
    let extension = file
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    NEVER_SNAPSHOT_EXT.iter().any(|blocked| extension == *blocked)
}

/// Directory for one file: a stable hash plus a readable hint.
fn bucket(root: &Path, file: &Path) -> PathBuf {
    let key = format!("{:016x}", fnv1a(file.to_string_lossy().as_bytes()));
    let hint: String = file
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .take(40)
        .collect();
    root.join(format!("{key}-{hint}"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

fn parse_entry(name: &str, bytes: u64) -> Option<Entry> {
    let (millis, label) = name.split_once('-')?;
    Some(Entry {
        millis: millis.parse().ok()?,
        label: Label::parse(label)?,
        id: name.to_string(),
        bytes,
    })
}

/// Newest first.
pub fn list(root: &Path, file: &Path) -> Result<Vec<Entry>, String> {
    let dir = bucket(root, file);
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };

    let mut found: Vec<Entry> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let bytes = entry.metadata().ok()?.len();
            parse_entry(&name, bytes)
        })
        .collect();
    found.sort_by(|a, b| b.millis.cmp(&a.millis));
    Ok(found)
}

pub fn read(root: &Path, file: &Path, id: &str) -> Result<String, String> {
    // `id` crosses the IPC boundary, so it must not be able to name a path
    // outside this file's bucket.
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("invalid history id".into());
    }
    if parse_entry(id, 0).is_none() {
        return Err("invalid history id".into());
    }
    fs::read_to_string(bucket(root, file).join(id)).map_err(|_| "that snapshot is gone".to_string())
}

/// Drop snapshots past the age, count or size bounds.
fn prune(dir: &Path) {
    let Ok(entries) = list_dir_entries(dir) else { return };
    let cutoff = now_millis().saturating_sub(MAX_AGE.as_millis() as u64);

    for (index, entry) in entries.iter().enumerate() {
        // Always keep the most recent one, however old it is: a file edited
        // once a year should still be recoverable.
        let too_old = index > 0 && entry.millis < cutoff;
        let too_many = index >= MAX_ENTRIES;
        if too_old || too_many {
            let _ = fs::remove_file(dir.join(&entry.id));
        }
    }
}

fn list_dir_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut found: Vec<Entry> = fs::read_dir(dir)
        .map_err(error)?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let bytes = entry.metadata().ok()?.len();
            parse_entry(&name, bytes)
        })
        .collect();
    found.sort_by(|a, b| b.millis.cmp(&a.millis));
    Ok(found)
}

/// Snapshot `content`. Returns the new entry, or None when nothing was stored
/// (excluded, too large, or identical to the previous snapshot).
pub fn record(root: &Path, file: &Path, content: &str, label: Label) -> Result<Option<Entry>, String> {
    if excluded(file) || content.len() > MAX_FILE_BYTES {
        return Ok(None);
    }

    let dir = bucket(root, file);
    fs::create_dir_all(&dir).map_err(error)?;
    restrict(root)?;
    restrict(&dir)?;

    // Saving the same bytes twice should not fill the history with duplicates.
    if let Some(previous) = list_dir_entries(&dir)?.first() {
        if fs::read_to_string(dir.join(&previous.id)).is_ok_and(|text| text == content) {
            return Ok(None);
        }
    }

    let mut millis = now_millis();
    let mut name = format!("{millis}-{}", label.as_str());
    // Two saves inside the same millisecond must not collide.
    while dir.join(&name).exists() {
        millis += 1;
        name = format!("{millis}-{}", label.as_str());
    }

    fs::write(dir.join(&name), content).map_err(error)?;
    prune(&dir);

    Ok(Some(Entry { id: name, millis, label, bytes: content.len() as u64 }))
}

// ------------------------------------------------------------- commands

use tauri::{AppHandle, Manager};

fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(error)?.join("history");
    fs::create_dir_all(&dir).map_err(error)?;
    restrict(&dir)?;
    Ok(dir)
}

/// Best effort: failing to record history must never stop a save from
/// happening. The snapshot is a safety net, not a precondition.
pub fn snapshot(app: &AppHandle, file: &Path, content: &str, label: Label) {
    if let Ok(root) = store_root(app) {
        let _ = record(&root, file, content, label);
    }
}

#[tauri::command]
pub fn history_list(app: AppHandle, path: String) -> Result<Vec<Entry>, String> {
    list(&store_root(&app)?, Path::new(&path))
}

#[tauri::command]
pub fn history_read(app: AppHandle, path: String, id: String) -> Result<String, String> {
    read(&store_root(&app)?, Path::new(&path), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("afteredit-history-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_save_is_recoverable() {
        let root = store("basic");
        let file = Path::new("/w/main.tf");

        record(&root, file, "first\n", Label::Save).unwrap().unwrap();
        record(&root, file, "second\n", Label::Save).unwrap().unwrap();

        let entries = list(&root, file).unwrap();
        assert_eq!(entries.len(), 2);
        // Newest first.
        assert_eq!(read(&root, file, &entries[0].id).unwrap(), "second\n");
        assert_eq!(read(&root, file, &entries[1].id).unwrap(), "first\n");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn identical_content_is_not_stored_twice() {
        let root = store("dedup");
        let file = Path::new("/w/a.yaml");
        assert!(record(&root, file, "same\n", Label::Save).unwrap().is_some());
        assert!(record(&root, file, "same\n", Label::Save).unwrap().is_none());
        assert_eq!(list(&root, file).unwrap().len(), 1);
        // A real change is stored again.
        assert!(record(&root, file, "different\n", Label::Save).unwrap().is_some());
        assert_eq!(list(&root, file).unwrap().len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_files_do_not_share_history() {
        let root = store("separate");
        record(&root, Path::new("/w/a.tf"), "a\n", Label::Save).unwrap();
        record(&root, Path::new("/w/b.tf"), "b\n", Label::Save).unwrap();
        assert_eq!(list(&root, Path::new("/w/a.tf")).unwrap().len(), 1);
        assert_eq!(read(&root, Path::new("/w/a.tf"), &list(&root, Path::new("/w/a.tf")).unwrap()[0].id).unwrap(), "a\n");
        assert_eq!(read(&root, Path::new("/w/b.tf"), &list(&root, Path::new("/w/b.tf")).unwrap()[0].id).unwrap(), "b\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_bridge_label_survives_a_round_trip() {
        let root = store("label");
        let file = Path::new("/tmp/kubectl-edit-123.yaml");
        let entry = record(&root, file, "apiVersion: v1\n", Label::BridgeOpen).unwrap().unwrap();
        assert_eq!(entry.label, Label::BridgeOpen);
        assert_eq!(list(&root, file).unwrap()[0].label, Label::BridgeOpen);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn saves_in_the_same_millisecond_do_not_collide() {
        let root = store("collide");
        let file = Path::new("/w/fast.txt");
        for index in 0..8 {
            record(&root, file, &format!("v{index}\n"), Label::Save).unwrap().unwrap();
        }
        let entries = list(&root, file).unwrap();
        assert_eq!(entries.len(), 8, "a same-millisecond save overwrote another");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_entry_count_is_bounded() {
        let root = store("bound");
        let file = Path::new("/w/busy.log");
        for index in 0..(MAX_ENTRIES + 25) {
            record(&root, file, &format!("line {index}\n"), Label::Save).unwrap();
        }
        assert!(list(&root, file).unwrap().len() <= MAX_ENTRIES, "history grew without bound");
        let _ = fs::remove_dir_all(&root);
    }

    // ---- negative: what must never reach the store -----------------------

    #[test]
    fn key_material_is_never_snapshotted() {
        for name in [
            "/home/u/.ssh/id_rsa", "/home/u/.ssh/id_ed25519", "/etc/ssl/server.pem",
            "/w/private.key", "/w/bundle.p12", "/home/u/.netrc", "/home/u/.aws/credentials",
        ] {
            assert!(excluded(Path::new(name)), "{name} must be excluded");
        }
    }

    #[test]
    fn ordinary_files_including_dotenv_are_kept() {
        // .env is one of the files people most want to undo.
        for name in ["/w/.env", "/w/main.tf", "/w/values.yaml", "/w/Makefile", "/w/app.py"] {
            assert!(!excluded(Path::new(name)), "{name} should be kept");
        }
    }

    #[test]
    fn an_excluded_file_stores_nothing_at_all() {
        let root = store("excluded");
        let file = Path::new("/home/u/.ssh/id_rsa");
        assert!(record(&root, file, "-----BEGIN OPENSSH PRIVATE KEY-----\n", Label::Save).unwrap().is_none());
        assert!(list(&root, file).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_oversized_file_is_skipped_rather_than_truncated() {
        let root = store("big");
        let file = Path::new("/w/huge.json");
        // A truncated snapshot would be a lie: restoring it would destroy data.
        assert!(record(&root, file, &"x".repeat(MAX_FILE_BYTES + 1), Label::Save).unwrap().is_none());
        assert!(list(&root, file).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_history_id_cannot_escape_its_bucket() {
        let root = store("traversal");
        let file = Path::new("/w/a.txt");
        record(&root, file, "content\n", Label::Save).unwrap();
        for bad in ["../../../etc/passwd", "..", "", "a/b", "1700000000-save/../x", "1700000000-bogus"] {
            assert!(read(&root, file, bad).is_err(), "{bad:?} must be rejected");
        }
        let _ = fs::remove_dir_all(&root);
    }
}
