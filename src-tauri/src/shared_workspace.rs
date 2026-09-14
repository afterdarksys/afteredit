//! GUI access to the same service used by the terminal clients.
use serde_json::{json, Value};
use std::path::Path;

#[tauri::command]
pub async fn service_start(
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: String,
) -> Result<Value, String> {
    let root = crate::workspace::allowed(&state, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let socket = crate::service::default_socket(&root)?;
        crate::service::ensure_server(&root, &socket)?;
        let capabilities = crate::service::rpc(&socket, "capabilities", json!({}))?;
        Ok(json!({"endpoint":socket,"capabilities":capabilities}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn service_request(
    endpoint: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::service::cli::Client { endpoint }.call(&method, params)
    })
    .await
    .map_err(|e| e.to_string())?
}
