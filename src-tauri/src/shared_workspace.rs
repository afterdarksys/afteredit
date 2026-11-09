//! GUI access to the same service used by the terminal clients.
//!
//! Threats: the webview may only talk to an endpoint this window started.
//! A remote join supplies a host alias and an absolute directory. This process
//! runs `ssh` with a fixed option list and `afteredit --stdio`. It does not
//! accept a password, identity file, port, proxy command, or custom ssh binary.
//! Unknown hosts fail through normal known_hosts. A failed capabilities check
//! is not recorded. This does not connect to SAH. Does NOT authenticate other
//! local processes that already know a socket path.
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

/// Threats: see the module comment. The host and directory are checked before
/// any SSH process starts. The endpoint is recorded only after protocol 1.
#[tauri::command]
pub async fn ssh_workspace_connect(
    joins: tauri::State<'_, ServiceJoins>,
    host: String,
    workspace: String,
) -> Result<Value, String> {
    let endpoint = crate::service::ssh_endpoint(&host, &workspace)?;
    let capabilities = tauri::async_runtime::spawn_blocking({
        let endpoint = endpoint.clone();
        move || crate::service::cli::Client { endpoint }.call("capabilities", json!({}))
    })
    .await
    .map_err(|e| e.to_string())??;
    {
        let mut guard = joins.0.lock().map_err(|e| e.to_string())?;
        admit_ssh_join(&mut guard, &endpoint, &capabilities)?;
    }
    Ok(json!({"endpoint": endpoint, "capabilities": capabilities}))
}

#[tauri::command]
pub async fn service_request(
    joins: tauri::State<'_, ServiceJoins>,
    endpoint: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    {
        let guard = joins.0.lock().map_err(|e| e.to_string())?;
        authorize_service_endpoint(&guard, &endpoint)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::service::cli::Client { endpoint }.call(&method, params)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn authorize_service_endpoint(joins: &HashSet<String>, endpoint: &str) -> Result<(), String> {
    if joins.contains(endpoint) {
        Ok(())
    } else {
        Err("Connect only to a workspace service this window started".into())
    }
}

/// Record `endpoint` only when it is a validated SSH target and the remote
/// service speaks protocol 1. Any other capabilities value leaves `joins` unchanged.
pub(crate) fn admit_ssh_join(
    joins: &mut HashSet<String>,
    endpoint: &str,
    capabilities: &Value,
) -> Result<(), String> {
    let _ = crate::service::parse_ssh_endpoint(endpoint)?;
    if capabilities["protocol"] != json!(1) {
        return Err("The remote AfterEdit service speaks an unsupported protocol.".into());
    }
    joins.insert(endpoint.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_or_unknown_ssh_check_is_not_a_join() {
        let mut joins = HashSet::new();
        let endpoint = crate::service::ssh_endpoint("dev", "/srv/app").expect("endpoint");
        assert!(admit_ssh_join(&mut joins, &endpoint, &json!({"protocol": 2})).is_err());
        assert!(admit_ssh_join(&mut joins, &endpoint, &json!({})).is_err());
        assert!(admit_ssh_join(&mut joins, "ssh://-oProxyCommand=x/tmp", &json!({"protocol": 1})).is_err());
        assert!(admit_ssh_join(&mut joins, "ssh://dev/tmp/../etc", &json!({"protocol": 1})).is_err());
        assert!(joins.is_empty());
        assert!(authorize_service_endpoint(&joins, &endpoint).is_err());
        assert!(authorize_service_endpoint(&joins, "ssh://evil/tmp").is_err());
        admit_ssh_join(&mut joins, &endpoint, &json!({"protocol": 1, "root": "/srv/app"})).expect("admit");
        assert!(authorize_service_endpoint(&joins, &endpoint).is_ok());
        assert!(authorize_service_endpoint(&joins, "ssh://other/srv/app").is_err());
        assert!(authorize_service_endpoint(&joins, "/tmp/not-started.sock").is_err());
    }
}
