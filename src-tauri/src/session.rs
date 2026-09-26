use crate::workspace::{allowed, WorkspaceState};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::Manager;

#[derive(Default, Clone, Deserialize, Serialize)]
pub struct Session {
    pub roots: Vec<String>,
    pub files: Vec<String>,
    pub active: String,
    pub root: String,
    pub directory: String,
}
fn validate(session: &Session) -> Result<(), String> {
    if session.roots.len() > 20 || session.files.len() > 100 {
        return Err("Session limit: 20 projects and 100 files.".into());
    }
    if session.roots.iter().chain(session.files.iter()).chain([&session.active, &session.root, &session.directory]).any(|p| p.len() > 4096) {
        return Err("Session path is too long.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn save_session(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceState>, session: Session) -> Result<(), String> {
    validate(&session)?;
    for path in session.roots.iter().chain(session.files.iter()).chain([&session.active, &session.root, &session.directory]).filter(|p| !p.is_empty()) {
        allowed(&state, Path::new(path))?;
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let temporary = dir.join("session.tmp");
    fs::write(&temporary, serde_json::to_vec(&session).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, dir.join("session.json")).map_err(|e| e.to_string())
}
pub(crate) fn restore_paths(session: Session, state: &WorkspaceState) -> Result<Session, String> {
    validate(&session)?;
    // Never follow a saved path which has since become a symlink to another location.
    let unchanged = |p: &String, directory: bool| {
        let path = Path::new(p);
        path.is_absolute() && path.canonicalize().is_ok_and(|canonical| canonical == path && if directory { canonical.is_dir() } else { canonical.is_file() })
    };
    let roots: Vec<_> = session.roots.into_iter().filter(|p| unchanged(p, true)).collect();
    let files: Vec<_> = session.files.into_iter().filter(|p| unchanged(p, false)).collect();
    let mut access = state.0.lock().map_err(|e| e.to_string())?;
    access.roots.extend(roots.iter().map(std::path::PathBuf::from));
    access.files.extend(files.iter().map(std::path::PathBuf::from));
    let active = if files.contains(&session.active) {session.active} else {String::new()};
    let root = if roots.contains(&session.root) {session.root} else {roots.first().cloned().unwrap_or_default()};
    let directory = if !root.is_empty() && unchanged(&session.directory, true) && Path::new(&session.directory).starts_with(&root) {session.directory} else {root.clone()};
    Ok(Session { roots, files, active, root, directory })
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Draft {
    pub path: String,
    pub basis: String,
    pub value: String,
}
#[derive(Serialize)]
pub struct DraftSave {
    pub withheld: Vec<String>,
}
const DRAFT_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn write_drafts(dir: &Path, state: &WorkspaceState, drafts: Vec<Draft>) -> Result<DraftSave, String> {
    if drafts.len() > 100 {
        return Err("Save some files before keeping more than 100 unsaved drafts.".into());
    }
    let mut kept = Vec::new();
    let mut withheld = Vec::new();
    let mut bytes = 0usize;
    for draft in drafts {
        if draft.path.len() > 4096 || draft.value == draft.basis {
            continue;
        }
        let path = Path::new(&draft.path);
        if allowed(state, path).is_err() {
            withheld.push(draft.path);
            continue;
        }
        // Fail closed: an unscanned tail must not land in application data.
        if draft.value.len() > DRAFT_BYTES
            || draft.basis.len() > DRAFT_BYTES
            || !crate::secrets::scan_text(&draft.value, &draft.path).is_empty()
            || !crate::secrets::scan_text(&draft.basis, &draft.path).is_empty()
        {
            withheld.push(draft.path);
            continue;
        }
        bytes += draft.value.len() + draft.basis.len();
        if bytes > DRAFT_BYTES {
            return Err("Unsaved drafts exceed 4 MiB. Save some files.".into());
        }
        kept.push(draft);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temporary = dir.join("drafts.tmp");
    fs::write(&temporary, serde_json::to_vec(&kept).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, dir.join("drafts.json")).map_err(|e| e.to_string())?;
    Ok(DraftSave { withheld })
}
pub(crate) fn read_drafts(dir: &Path, state: &WorkspaceState) -> Result<Vec<Draft>, String> {
    let path = dir.join("drafts.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= DRAFT_BYTES * 2 => bytes,
        Ok(_) => return Err("Saved drafts are too large.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let drafts: Vec<Draft> = serde_json::from_slice(&bytes).map_err(|e| format!("Cannot restore unsaved drafts: {e}"))?;
    Ok(drafts
        .into_iter()
        .filter(|draft| {
            let path = Path::new(&draft.path);
            allowed(state, path).is_ok()
                && path.is_file()
                && draft.value.len() <= DRAFT_BYTES
                && crate::secrets::scan_text(&draft.value, &draft.path).is_empty()
        })
        .take(100)
        .collect())
}
#[tauri::command]
pub fn save_drafts(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceState>, drafts: Vec<Draft>) -> Result<DraftSave, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    write_drafts(&dir, &state, drafts)
}
#[tauri::command]
pub fn restore_drafts(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceState>) -> Result<Vec<Draft>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    read_drafts(&dir, &state)
}
#[tauri::command]
pub fn restore_session(app: tauri::AppHandle, state: tauri::State<'_, WorkspaceState>) -> Result<Session, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("session.json");
    let bytes = match fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => bytes,
        Ok(_) => return Err("Saved session is too large.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Session::default()),
        Err(e) => return Err(e.to_string()),
    };
    restore_paths(serde_json::from_slice(&bytes).map_err(|e| format!("Cannot restore saved session: {e}"))?, &state)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restoration_skips_missing_paths_and_preserves_authorized_files() {
        let dir = std::env::temp_dir().join(format!("afteredit-session-{}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dir=dir.canonicalize().unwrap();
        let file=dir.join("file.txt"); fs::write(&file,"saved").unwrap();
        let state=WorkspaceState::default();
        let restored=restore_paths(Session{roots:vec![dir.to_string_lossy().into()],files:vec![file.to_string_lossy().into(),dir.join("missing").to_string_lossy().into()],active:file.to_string_lossy().into(),..Default::default()},&state).unwrap();
        assert_eq!(restored.files.len(),1);
        assert!(allowed(&state,&file).is_ok());
        assert_eq!(restored.root,dir.to_string_lossy());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn restoration_does_not_grant_retargeted_symlinks() {
        let dir=std::env::temp_dir().join(format!("afteredit-session-link-{}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let link=dir.join("link");std::os::unix::fs::symlink("/", &link).unwrap();
        let state=WorkspaceState::default();
        let restored=restore_paths(Session{roots:vec![link.to_string_lossy().into()],..Default::default()},&state).unwrap();
        assert!(restored.roots.is_empty()); assert!(allowed(&state,Path::new("/")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn drafts_roundtrip_and_withhold_secrets() {
        let dir = std::env::temp_dir().join(format!("afteredit-drafts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let project = dir.join("project");
        let store = dir.join("store");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let file = project.join("file.txt");
        fs::write(&file, "saved").unwrap();
        let state = WorkspaceState::default();
        state.0.lock().unwrap().roots.insert(project.clone());
        let secret = "token AKIAIOSFODNN7EXAMPLE\n";
        let saved = write_drafts(&store, &state, vec![
            Draft { path: file.to_string_lossy().into(), basis: "saved".into(), value: "edited".into() },
            Draft { path: file.to_string_lossy().into(), basis: "saved".into(), value: secret.into() },
        ]).unwrap();
        assert_eq!(saved.withheld.len(), 1);
        let restored = read_drafts(&store, &state).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].value, "edited");
        fs::remove_dir_all(dir).unwrap();
    }
}
