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
}
