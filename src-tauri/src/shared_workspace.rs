//! GUI access to the same service used by the terminal clients.
//!
//! Threats: the webview may only talk to a socket this window started.
//! SSH joins stay a CLI feature. Does NOT authenticate other local processes
//! that already know the socket path.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

#[derive(Default)]
pub struct ServiceJoins(Mutex<HashSet<String>>);

#[tauri::command]
pub async fn service_start(
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    joins: tauri::State<'_, ServiceJoins>,
    root: String,
) -> Result<Value, String> {
    let root = crate::workspace::allowed(&state, Path::new(&root))?;
    let (socket, capabilities) = tauri::async_runtime::spawn_blocking({
        let root = root.clone();
        move || {
            let socket = crate::service::default_socket(&root)?;
            crate::service::ensure_server(&root, &socket)?;
            let capabilities = crate::service::rpc(&socket, "capabilities", json!({}))?;
            Ok::<_, String>((socket, capabilities))
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let endpoint = socket.to_string_lossy().into_owned();
    joins.0.lock().map_err(|e| e.to_string())?.insert(endpoint.clone());
    Ok(json!({"endpoint":endpoint,"capabilities":capabilities}))
}

#[tauri::command]
pub async fn service_request(
    joins: tauri::State<'_, ServiceJoins>,
    endpoint: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if endpoint.starts_with("ssh://") {
        return Err("Remote SSH joins are a CLI feature, not a webview feature".into());
    }
    let allowed = joins
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&endpoint);
    if !allowed {
        return Err("Connect only to a workspace service this window started".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::service::cli::Client { endpoint }.call(&method, params)
    })
    .await
    .map_err(|e| e.to_string())?
}
