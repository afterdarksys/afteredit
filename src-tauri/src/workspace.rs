use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Workspace>);
#[derive(Default)]
pub struct Workspace {
    roots: HashSet<PathBuf>,
    files: HashSet<PathBuf>,
}
#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(crate) fn allowed(state: &WorkspaceState, path: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(error)?;
    let access = state.0.lock().map_err(error)?;
    if access.files.contains(&path) || access.roots.iter().any(|root| path.starts_with(root)) {
        Ok(path)
    } else {
        Err("Open this file or its project first.".into())
    }
}
#[tauri::command]
pub async fn choose_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    directory: bool,
) -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        if directory {
            app.dialog().file().blocking_pick_folder()
        } else {
            app.dialog().file().blocking_pick_file()
        }
    })
    .await
    .map_err(error)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(error)?
        .canonicalize()
        .map_err(error)?;
    let mut access = state.0.lock().map_err(error)?;
    if directory {
        access.roots.insert(path.clone());
    } else {
        access.files.insert(path.clone());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[tauri::command]
pub fn list_directory(
    state: tauri::State<'_, WorkspaceState>,
    path: String,
) -> Result<Vec<Entry>, String> {
    let path = allowed(&state, Path::new(&path))?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(error)? {
        let entry = entry.map_err(error)?;
        // Do not silently traverse symlinks or expose files outside the selected root.
        if entry.file_type().map_err(error)?.is_symlink() {
            continue;
        }
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            directory: entry.file_type().map_err(error)?.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
#[tauri::command]
pub fn read_file(state: tauri::State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    let path = allowed(&state, Path::new(&path))?;
    if fs::metadata(&path).map_err(error)?.len() > 8 * 1024 * 1024 {
        return Err("File exceeds the 8 MiB text editing limit.".into());
    }
    let text = fs::read_to_string(path).map_err(error)?;
    if text.contains('\0') {
        return Err("Binary files cannot be edited as text.".into());
    }
    Ok(text)
}
#[tauri::command]
pub fn save_file(
    state: tauri::State<'_, WorkspaceState>,
    path: String,
    content: String,
    expected: String,
) -> Result<(), String> {
    let path = allowed(&state, Path::new(&path))?;
    write_checked(&path, &content, &expected)
}
#[derive(Serialize)]
pub struct ConfigLayer {
    pub path: String,
    pub value: serde_json::Value,
}
#[tauri::command]
pub fn project_config(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    directory: String,
) -> Result<Vec<ConfigLayer>, String> {
    let root = allowed(&state, Path::new(&root))?;
    let directory = allowed(&state, Path::new(&directory))?;
    if !directory.starts_with(&root) {
        return Err("Directory is outside the project.".into());
    }
    let mut dirs: Vec<_> = directory
        .ancestors()
        .take_while(|p| p.starts_with(&root))
        .collect();
    dirs.reverse();
    let mut layers = Vec::new();
    for dir in dirs {
        let path = dir.join(".afteredit.json");
        if path.exists() {
            let path = allowed(&state, &path)?;
            let value =
                serde_json::from_str(&fs::read_to_string(&path).map_err(error)?).map_err(error)?;
            layers.push(ConfigLayer {
                path: path.to_string_lossy().into_owned(),
                value,
            });
        }
    }
    Ok(layers)
}
#[tauri::command]
pub fn create_config(
    state: tauri::State<'_, WorkspaceState>,
    directory: String,
    content: String,
) -> Result<String, String> {
    use std::io::Write;
    let dir = allowed(&state, Path::new(&directory))?;
    let path = dir.join(".afteredit.json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(error)?;
    file.write_all(content.as_bytes()).map_err(error)?;
    Ok(path.to_string_lossy().into_owned())
}
// Commands are executed only by an explicit Run action in the workbench.
#[tauri::command]
pub fn task_directory(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    cwd: String,
) -> Result<String, String> {
    let root = allowed(&state, Path::new(&root))?;
    let dir = allowed(&state, &root.join(cwd))?;
    if !dir.is_dir() || !dir.starts_with(root) {
        return Err("Task working directory must be inside the project.".into());
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_preserves_external_changes() {
        let dir = std::env::temp_dir().join(format!("afteredit-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        fs::write(&path, "original").unwrap();
        write_checked(&path, "edited", "original").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
        assert!(write_checked(&path, "stale overwrite", "original").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn symlinks_cannot_escape_selected_root() {
        let dir =
            std::env::temp_dir().join(format!("afteredit-symlink-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap();
        std::os::unix::fs::symlink("/", root.join("escape")).unwrap();
        let state = WorkspaceState::default();
        state.0.lock().unwrap().roots.insert(root.clone());
        assert!(allowed(&state, &root.join("escape")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn access_requires_selection() {
        let state = WorkspaceState::default();
        let dir = std::env::temp_dir().canonicalize().unwrap();
        assert!(allowed(&state, &dir).is_err());
        state.0.lock().unwrap().roots.insert(dir.clone());
        assert_eq!(allowed(&state, &dir).unwrap(), dir);
        assert!(allowed(&state, Path::new("/")).is_err());
    }
}

fn write_checked(path: &Path, content: &str, expected: &str) -> Result<(), String> {
    use std::io::Write;
    if fs::read_to_string(path).map_err(error)? != expected {
        return Err(
            "File changed on disk. Reopen it before saving to avoid overwriting external edits."
                .into(),
        );
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_nanos();
    let temporary = path.with_file_name(format!(".afteredit-save-{}-{stamp}", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(error)?;
        file.set_permissions(fs::metadata(path).map_err(error)?.permissions())
            .map_err(error)?;
        file.write_all(content.as_bytes()).map_err(error)?;
        file.sync_all().map_err(error)?;
        if fs::read_to_string(path).map_err(error)? != expected {
            return Err("File changed during save; disk content was preserved.".into());
        }
        fs::rename(&temporary, path).map_err(error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
#[tauri::command]
pub async fn save_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    content: String,
) -> Result<Option<String>, String> {
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_save_file())
            .await
            .map_err(error)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(error)?;
    // New files only: existing files use the conflict-checked Save operation.
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Choose a new filename (open an existing file to edit it): {e}"))?;
    file.write_all(content.as_bytes()).map_err(error)?;
    let path = path.canonicalize().map_err(error)?;
    state.0.lock().map_err(error)?.files.insert(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[tauri::command]
pub async fn confirm_discard(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message("There are unsaved files. Close and discard those edits?")
            .title("Unsaved changes")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .await
    .map_err(error)
}

#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    line: usize,
    text: String,
}
#[derive(Serialize)]
pub struct SearchResults {
    hits: Vec<SearchHit>,
    truncated: bool,
}
#[tauri::command]
pub async fn workspace_search(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    query: String,
) -> Result<SearchResults, String> {
    let root = allowed(&state, Path::new(&root))?;
    if query.is_empty() || query.len() > 512 {
        return Err("Enter 1–512 characters".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = SearchResults {
            hits: Vec::new(),
            truncated: false,
        };
        let mut dirs = vec![root];
        let mut visited = 0;
        let start = std::time::Instant::now();
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).map_err(error)? {
                let entry = entry.map_err(error)?;
                visited += 1;
                if visited > 20000
                    || start.elapsed() > std::time::Duration::from_secs(3)
                    || result.hits.len() >= 200
                {
                    result.truncated = true;
                    return Ok(result);
                }
                let kind = entry.file_type().map_err(error)?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if ![".git", "node_modules", "target", "dist", ".venv", "vendor"]
                        .contains(&entry.file_name().to_string_lossy().as_ref())
                    {
                        dirs.push(entry.path());
                    }
                    continue;
                }
                if entry.metadata().map_err(error)?.len() > 1024 * 1024 {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(entry.path()) {
                    if text.contains('\0') {
                        continue;
                    }
                    for (line, text) in text.lines().enumerate() {
                        if text.contains(&query) {
                            result.hits.push(SearchHit {
                                path: entry.path().to_string_lossy().into_owned(),
                                line: line + 1,
                                text: text.chars().take(500).collect(),
                            });
                            if result.hits.len() >= 200 {
                                result.truncated = true;
                                return Ok(result);
                            }
                        }
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(error)?
}

#[tauri::command]
pub fn project_file_path(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    relative: String,
) -> Result<String, String> {
    let root = allowed(&state, Path::new(&root))?;
    let candidate = Path::new(&relative);
    if candidate.is_absolute()
        || candidate.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("File path must stay inside the agent project".into());
    }
    let path = allowed(&state, &root.join(candidate))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("File is outside the agent project".into());
    }
    Ok(path.to_string_lossy().into_owned())
}
