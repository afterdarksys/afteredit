use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct WorkspaceState(pub Mutex<Workspace>);
#[derive(Default)]
pub struct Workspace {
    pub(crate) roots: HashSet<PathBuf>,
    pub(crate) files: HashSet<PathBuf>,
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
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    path: String,
    content: String,
    expected: String,
) -> Result<(), String> {
    let path = allowed(&state, Path::new(&path))?;
    write_checked(&path, &content, &expected)?;
    // After the write succeeds: a snapshot of something that failed to save
    // would be misleading.
    crate::history::snapshot(&app, &path, &content, crate::history::Label::Save);
    Ok(())
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
    fn fixture() -> (PathBuf, WorkspaceState) {
        let dir = std::env::temp_dir().join(format!("afteredit-explore-{}-{}", std::process::id(), crate::history::fnv1a(format!("{:?}", std::time::SystemTime::now()).as_bytes())));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "fn value() {}\nfn valuable() {}\n").unwrap();
        fs::write(dir.join("notes.txt"), "Value stays.\n").unwrap();
        fs::create_dir_all(dir.join("vendor")).unwrap();
        fs::write(dir.join("vendor/skip.rs"), "fn value() {}\n").unwrap();
        let root = dir.canonicalize().unwrap();
        let state = WorkspaceState::default();
        state.0.lock().unwrap().roots.insert(root.clone());
        (root, state)
    }
    #[test]
    fn search_respects_case_word_and_globs() {
        let (root, _state) = fixture();
        let literal = search_path(&root, "value", &SearchOptions::default()).unwrap();
        assert!(literal.hits.iter().any(|hit| hit.path.ends_with("lib.rs")));
        assert!(literal.hits.iter().all(|hit| !hit.path.contains("vendor")));
        let insensitive = search_path(&root, "value", &SearchOptions { case_sensitive: false, ..SearchOptions::default() }).unwrap();
        assert!(insensitive.hits.iter().any(|hit| hit.path.ends_with("notes.txt")));
        let whole = search_path(&root, "value", &SearchOptions { whole_word: true, ..SearchOptions::default() }).unwrap();
        assert!(whole.hits.iter().any(|hit| hit.text.contains("fn value()")));
        assert!(whole.hits.iter().all(|hit| !hit.text.contains("valuable")));
        let rust_only = search_path(&root, "fn", &SearchOptions { include: "*.rs".into(), ..SearchOptions::default() }).unwrap();
        assert!(rust_only.hits.iter().all(|hit| hit.path.ends_with(".rs")));
        let excluded = search_path(&root, "fn", &SearchOptions { exclude: "src/**".into(), ..SearchOptions::default() }).unwrap();
        assert!(excluded.hits.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn replace_refuses_a_file_that_changed_after_review() {
        let (root, state) = fixture();
        let preview = preview_replace(&root, "valuable", "rest", &SearchOptions::default()).unwrap();
        let file = preview.files.iter().find(|file| file.path.ends_with("lib.rs")).unwrap();
        fs::write(&file.path, "fn valuable() { changed }\n").unwrap();
        let skipped = anchored(&state, Path::new(&file.path)).unwrap();
        assert_ne!(fingerprint(&fs::read_to_string(&skipped).unwrap()), file.fingerprint);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explorer_creates_renames_and_keeps_the_root() {
        let (root, state) = fixture();
        let created = make_directory(&state, &root, "fresh").unwrap();
        assert!(created.ends_with("fresh"));
        assert!(make_directory(&state, &root, "../fresh").is_err());
        let renamed = move_path(&state, &created, &root, "renamed").unwrap();
        assert!(renamed.ends_with("renamed"));
        assert!(remove_path(&state, &root).is_err());
        remove_path(&state, &renamed).unwrap();
        assert!(!renamed.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn explorer_does_not_follow_a_symlink() {
        let (root, state) = fixture();
        std::os::unix::fs::symlink("lib.rs", root.join("src/link.rs")).unwrap();
        assert!(anchored(&state, &root.join("src/link.rs")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

pub(crate) fn write_checked(path: &Path, content: &str, expected: &str) -> Result<(), String> {
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
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default = "default_true")]
    pub case_sensitive: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
}
fn default_true() -> bool {
    true
}
impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: true,
            regex: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
        }
    }
}
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".venv", "vendor"];

fn glob_regex(pattern: &str) -> Result<regex::Regex, String> {
    let mut out = String::from("^");
    if !pattern.contains('/') {
        out.push_str("(?:.*/)?");
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                index += 2;
                if chars.get(index) == Some(&'/') {
                    index += 1;
                }
                out.push_str(".*");
            }
            '*' => {
                out.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                out.push_str("[^/]");
                index += 1;
            }
            character => {
                out.push_str(&regex::escape(&character.to_string()));
                index += 1;
            }
        }
    }
    out.push('$');
    regex::RegexBuilder::new(&out)
        .size_limit(1 << 20)
        .build()
        .map_err(|err| err.to_string())
}
fn compile_globs(source: &str) -> Result<Vec<regex::Regex>, String> {
    source
        .split(',')
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .take(20)
        .map(glob_regex)
        .collect()
}
fn matcher(query: &str, options: &SearchOptions) -> Result<regex::Regex, String> {
    let body = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!("(?-u:\\b)(?:{body})(?-u:\\b)")
    } else {
        body
    };
    let expression = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 20)
        .build()
        .map_err(|err| format!("Invalid regular expression: {err}"))?;
    if expression.is_match("") {
        return Err("The pattern matches empty text.".into());
    }
    Ok(expression)
}
fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
/// Stable across process restarts so a reviewed replace can refuse a file
/// that changed after the preview.
pub(crate) fn fingerprint(text: &str) -> String {
    format!("{:016x}:{}", crate::history::fnv1a(text.as_bytes()), text.len())
}
fn replace_line(expression: &regex::Regex, line: &str, replacement: &str, literal: bool) -> String {
    if literal {
        expression
            .replace_all(line, regex::NoExpand(replacement))
            .into_owned()
    } else {
        expression.replace_all(line, replacement).into_owned()
    }
}
pub(crate) fn search_path(root: &Path, query: &str, options: &SearchOptions) -> Result<SearchResults, String> {
    if query.is_empty() || query.len() > 512 {
        return Err("Enter 1–512 characters".into());
    }
    let expression = matcher(query, options)?;
    let include = compile_globs(&options.include)?;
    let exclude = compile_globs(&options.exclude)?;
    let mut result = SearchResults { hits: Vec::new(), truncated: false };
    let mut dirs = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let start = std::time::Instant::now();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(error)? {
            let entry = entry.map_err(error)?;
            visited += 1;
            if visited > 20_000 || start.elapsed() > std::time::Duration::from_secs(3) || result.hits.len() >= 200 {
                result.truncated = true;
                return Ok(result);
            }
            let kind = entry.file_type().map_err(error)?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    dirs.push(entry.path());
                }
                continue;
            }
            let relative = relative_to(root, &entry.path());
            if !include.is_empty() && !include.iter().any(|pattern| pattern.is_match(&relative)) {
                continue;
            }
            if exclude.iter().any(|pattern| pattern.is_match(&relative)) {
                continue;
            }
            if entry.metadata().map_err(error)?.len() > 1024 * 1024 {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            if text.contains('\0') {
                continue;
            }
            for (line, text) in text.lines().enumerate() {
                if expression.is_match(text) {
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
    Ok(result)
}
#[tauri::command]
pub async fn workspace_search(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<SearchResults, String> {
    let root = allowed(&state, Path::new(&root))?;
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || search_path(&root, &query, &options))
        .await
        .map_err(error)?
}
#[derive(Serialize)]
pub struct ReplaceHunk {
    line: usize,
    before: String,
    after: String,
}
#[derive(Serialize)]
pub struct ReplaceFile {
    path: String,
    fingerprint: String,
    matches: usize,
    hunks: Vec<ReplaceHunk>,
    hunks_truncated: bool,
}
#[derive(Serialize)]
pub struct ReplacePreview {
    files: Vec<ReplaceFile>,
    truncated: bool,
}
#[derive(Deserialize)]
pub struct ReviewedFile {
    path: String,
    fingerprint: String,
}
#[derive(Serialize)]
pub struct ReplaceReport {
    changed: Vec<String>,
    skipped: Vec<String>,
}
fn preview_file(path: &Path, expression: &regex::Regex, replacement: &str, literal: bool) -> Result<Option<ReplaceFile>, String> {
    if fs::metadata(path).map_err(error)?.len() > 1024 * 1024 {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(error)?;
    if text.contains('\0') {
        return Ok(None);
    }
    let mut hunks = Vec::new();
    let mut matches = 0usize;
    let mut truncated = false;
    for (index, line) in text.lines().enumerate() {
        let count = expression.find_iter(line).count();
        if count == 0 {
            continue;
        }
        matches += count;
        if hunks.len() >= 30 {
            truncated = true;
            continue;
        }
        let after = replace_line(expression, line, replacement, literal);
        hunks.push(ReplaceHunk {
            line: index + 1,
            before: line.chars().take(500).collect(),
            after: after.chars().take(500).collect(),
        });
    }
    if matches == 0 {
        return Ok(None);
    }
    Ok(Some(ReplaceFile {
        path: path.to_string_lossy().into_owned(),
        fingerprint: fingerprint(&text),
        matches,
        hunks,
        hunks_truncated: truncated,
    }))
}
pub(crate) fn preview_replace(root: &Path, query: &str, replacement: &str, options: &SearchOptions) -> Result<ReplacePreview, String> {
    if replacement.len() > 8_192 {
        return Err("Replacement is limited to 8192 characters.".into());
    }
    let expression = matcher(query, options)?;
    let found = search_path(root, query, options)?;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for hit in &found.hits {
        if !seen.insert(hit.path.clone()) {
            continue;
        }
        if files.len() >= 40 {
            break;
        }
        if let Some(file) = preview_file(Path::new(&hit.path), &expression, replacement, !options.regex)? {
            files.push(file);
        }
    }
    let truncated = found.truncated || files.len() >= 40;
    Ok(ReplacePreview { files, truncated })
}
#[tauri::command]
pub async fn workspace_replace_preview(
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
) -> Result<ReplacePreview, String> {
    let root = allowed(&state, Path::new(&root))?;
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || preview_replace(&root, &query, &replacement, &options))
        .await
        .map_err(error)?
}
#[tauri::command]
pub async fn workspace_replace(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    root: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
    files: Vec<ReviewedFile>,
) -> Result<ReplaceReport, String> {
    let root = allowed(&state, Path::new(&root))?;
    if files.is_empty() || files.len() > 40 {
        return Err("Review between 1 and 40 files before replacing.".into());
    }
    if replacement.len() > 8_192 {
        return Err("Replacement is limited to 8192 characters.".into());
    }
    let (roots, opened) = {
        let access = state.0.lock().map_err(error)?;
        (access.roots.clone(), access.files.clone())
    };
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let expression = matcher(&query, &options)?;
        let mut report = ReplaceReport { changed: Vec::new(), skipped: Vec::new() };
        for file in files {
            let path = Path::new(&file.path).canonicalize().ok().filter(|path| {
                path.starts_with(&root) && path.is_file() && (opened.contains(path) || roots.iter().any(|root| path.starts_with(root)))
            });
            let Some(path) = path else {
                report.skipped.push(file.path);
                continue;
            };
            let original = match fs::read_to_string(&path) {
                Ok(text) if fingerprint(&text) == file.fingerprint => text,
                _ => {
                    report.skipped.push(path.to_string_lossy().into_owned());
                    continue;
                }
            };
            let mut next = String::new();
            for (index, line) in original.split_inclusive('\n').enumerate() {
                let (body, ending) = line.strip_suffix("\r\n").map(|body| (body, "\r\n")).or_else(|| line.strip_suffix('\n').map(|body| (body, "\n"))).unwrap_or((line, ""));
                let _ = index;
                next.push_str(&replace_line(&expression, body, &replacement, !options.regex));
                next.push_str(ending);
            }
            if next == original {
                report.skipped.push(path.to_string_lossy().into_owned());
                continue;
            }
            write_checked(&path, &next, &original)?;
            crate::history::snapshot(&app, &path, &next, crate::history::Label::Save);
            report.changed.push(path.to_string_lossy().into_owned());
        }
        Ok(report)
    })
    .await
    .map_err(error)?
}
fn component_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("Use a single file or folder name.".into());
    }
    Ok(())
}
fn project_root<'a>(state: &'a WorkspaceState, path: &Path) -> Result<PathBuf, String> {
    let access = state.0.lock().map_err(error)?;
    access
        .roots
        .iter()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.as_os_str().len())
        .cloned()
        .ok_or_else(|| "Choose a folder inside an open project.".to_string())
}
/// Parent is canonical. The final component is not resolved, so a symlink
/// cannot be renamed or deleted onto its target.
fn anchored(state: &WorkspaceState, raw: &Path) -> Result<PathBuf, String> {
    let parent = raw.parent().filter(|path| !path.as_os_str().is_empty()).ok_or("Choose a file inside the project.")?;
    let name = raw.file_name().ok_or("Choose a file inside the project.")?;
    let parent = allowed(state, parent)?;
    let path = parent.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(error)?;
    if metadata.file_type().is_symlink() {
        return Err("Symlinks are left unchanged.".into());
    }
    let _ = project_root(state, &path)?;
    Ok(path)
}
pub(crate) fn make_directory(state: &WorkspaceState, parent: &Path, name: &str) -> Result<PathBuf, String> {
    component_name(name)?;
    let parent = allowed(state, parent)?;
    if !parent.is_dir() {
        return Err("Choose a folder.".into());
    }
    let root = project_root(state, &parent)?;
    let path = parent.join(name);
    if !path.starts_with(&root) {
        return Err("The folder must stay inside the project.".into());
    }
    fs::create_dir(&path).map_err(error)?;
    let created = path.canonicalize().map_err(error)?;
    if !created.starts_with(&root) {
        let _ = fs::remove_dir(&created);
        return Err("The folder must stay inside the project.".into());
    }
    Ok(created)
}
pub(crate) fn move_path(state: &WorkspaceState, from: &Path, dest_dir: &Path, name: &str) -> Result<PathBuf, String> {
    component_name(name)?;
    let from = anchored(state, from)?;
    let dest_dir = allowed(state, dest_dir)?;
    if !dest_dir.is_dir() {
        return Err("Move into a folder.".into());
    }
    let root = project_root(state, &from)?;
    if project_root(state, &dest_dir)? != root {
        return Err("Move stays inside the same project.".into());
    }
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err("Something already has that name.".into());
    }
    if from.is_dir() && (dest == from || dest.starts_with(&from)) {
        return Err("A folder cannot be moved into itself.".into());
    }
    if !dest.starts_with(&root) {
        return Err("The new path must stay inside the project.".into());
    }
    fs::rename(&from, &dest).map_err(error)?;
    Ok(dest)
}
pub(crate) fn remove_path(state: &WorkspaceState, path: &Path) -> Result<(), String> {
    let path = anchored(state, path)?;
    let root = project_root(state, &path)?;
    if path == root {
        return Err("The project root stays.".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(error)?;
    } else {
        fs::remove_file(&path).map_err(error)?;
    }
    Ok(())
}
#[tauri::command]
pub fn create_directory(state: tauri::State<'_, WorkspaceState>, parent: String, name: String) -> Result<String, String> {
    make_directory(&state, Path::new(&parent), &name).map(|path| path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn rename_path(state: tauri::State<'_, WorkspaceState>, from: String, dest_dir: String, name: String) -> Result<String, String> {
    move_path(&state, Path::new(&from), Path::new(&dest_dir), &name).map(|path| path.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn delete_path(state: tauri::State<'_, WorkspaceState>, path: String) -> Result<(), String> {
    remove_path(&state, Path::new(&path))
}
#[derive(Default)]
pub struct WatchState(pub AtomicU64);
#[derive(Clone, Serialize)]
struct WatchEvent {
    paths: Vec<String>,
}
fn collect_stamps(root: &Path) -> HashSet<(String, u128)> {
    let mut found = HashSet::new();
    let mut dirs = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 20_000 || found.len() >= 20_000 {
                return found;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            let stamp = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_millis())
                .unwrap_or(0);
            found.insert((entry.path().to_string_lossy().into_owned(), stamp));
            if kind.is_dir() {
                dirs.push(entry.path());
            }
        }
    }
    found
}
#[tauri::command]
pub fn watch_project(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceState>, watch: tauri::State<'_, WatchState>, root: String) -> Result<(), String> {
    let generation = watch.0.fetch_add(1, Ordering::Relaxed) + 1;
    if root.is_empty() {
        return Ok(());
    }
    let root = allowed(&state, Path::new(&root))?;
    if !root.is_dir() {
        return Err("Choose a project folder to watch.".into());
    }
    let token = generation;
    std::thread::spawn(move || {
        let mut previous = collect_stamps(&root);
        while app.state::<WatchState>().0.load(Ordering::Relaxed) == token {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if app.state::<WatchState>().0.load(Ordering::Relaxed) != token {
                break;
            }
            let current = collect_stamps(&root);
            let mut paths: Vec<String> = current
                .difference(&previous)
                .chain(previous.difference(&current))
                .map(|(path, _)| path.clone())
                .collect();
            paths.sort();
            paths.dedup();
            previous = current;
            if paths.is_empty() {
                continue;
            }
            paths.truncate(200);
            let _ = app.emit("workspace:changed", WatchEvent { paths });
        }
    });
    Ok(())
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
