//! Reviewed MCP client. The model can call a tool the user connected. It cannot
//! choose the server command. Stdio uses newline-delimited JSON-RPC.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use tauri::AppHandle;

use crate::workspace::{allowed, WorkspaceState};

#[derive(Default)]
pub struct McpState {
    sessions: Mutex<HashMap<String, Session>>,
}
struct Session {
    child: Mutex<Child>,
    input: Mutex<std::process::ChildStdin>,
    incoming: Mutex<mpsc::Receiver<Result<Value, String>>>,
    tools: Vec<String>,
    next_id: AtomicU64,
}
#[derive(Clone, Serialize)]
pub struct McpTool {
    name: String,
    description: String,
}
#[derive(Clone)]
struct ServerSpec {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
}
fn blocked_env(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key == "PATH" || key.starts_with("LD_") || key.starts_with("DYLD_") || key.starts_with("GIT_")
}
fn server_name(name: &str) -> Result<(), String> {
    if name.len() > 41 || !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("MCP server name must be a short identifier.".into());
    }
    Ok(())
}
fn tool_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("MCP tool name must be a short identifier.".into());
    }
    Ok(())
}
fn configured(root: &Path, name: &str) -> Result<ServerSpec, String> {
    server_name(name)?;
    let mut spec: Option<ServerSpec> = None;
    let mut dirs: Vec<_> = root.ancestors().take_while(|dir| dir.starts_with(root)).collect();
    dirs.reverse();
    for dir in dirs {
        let path = dir.join(".afteredit.json");
        if !path.is_file() { continue; }
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let Some(servers) = value.get("mcp").and_then(|item| item.get("servers")).and_then(Value::as_object) else { continue };
        let Some(server) = servers.get(name) else { continue };
        let command = server.get("command").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if command.is_empty() || command.contains(['\n', '\0']) { return Err(format!("MCP server {name} needs a command.")); }
        let args = server.get("args").and_then(Value::as_array).ok_or_else(|| format!("MCP server {name} needs args."))?;
        if args.len() > 32 { return Err("MCP server has too many arguments.".into()); }
        let args: Vec<String> = args.iter().map(|arg| arg.as_str().map(str::to_string).ok_or_else(|| "MCP arguments must be text.".to_string())).collect::<Result<_, _>>()?;
        if args.iter().any(|arg| arg.contains('\0') || arg.len() > 4000) { return Err("An MCP argument is invalid.".into()); }
        let mut env = HashMap::new();
        if let Some(values) = server.get("env").and_then(Value::as_object) {
            for (key, value) in values {
                if blocked_env(key) { return Err(format!("MCP environment cannot set {key}.")); }
                env.insert(key.clone(), value.as_str().ok_or_else(|| "MCP environment values must be text.".to_string())?.to_string());
            }
        }
        spec = Some(ServerSpec { command, args, env });
    }
    spec.ok_or_else(|| format!("No MCP server named {name} is configured."))
}
fn write_line(input: &mut impl Write, message: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if line.contains(&b'\n') { return Err("MCP message must fit on one line.".into()); }
    line.push(b'\n');
    input.write_all(&line).map_err(|e| e.to_string())?;
    input.flush().map_err(|e| e.to_string())
}
fn start_session(mut child: Child) -> Result<Session, String> {
    let input = child.stdin.take().ok_or("MCP server has no input.")?;
    let output = child.stdout.take().ok_or("MCP server has no output.")?;
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut output = BufReader::new(output);
        loop {
            let mut line = String::new();
            match output.read_line(&mut line) {
                Ok(0) => { let _ = tx.send(Err("MCP server closed.".into())); break; }
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) if line.len() > 1024 * 1024 => { let _ = tx.send(Err("MCP message exceeds 1 MiB.".into())); break; }
                Ok(_) => { let _ = tx.send(serde_json::from_str(line.trim()).map_err(|error| error.to_string())); }
                Err(error) => { let _ = tx.send(Err(error.to_string())); break; }
            }
        }
    });
    Ok(Session { child: Mutex::new(child), input: Mutex::new(input), incoming: Mutex::new(rx), tools: Vec::new(), next_id: AtomicU64::new(0) })
}
impl Session {
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        write_line(&mut *input, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        drop(input);
        let incoming = self.incoming.lock().map_err(|e| e.to_string())?;
        loop {
            let message = incoming.recv_timeout(Duration::from_secs(30)).map_err(|_| "MCP server timed out.".to_string())??;
            if message.get("id").and_then(Value::as_u64) != Some(id) { continue; }
            if let Some(error) = message.get("error") { return Err(format!("MCP {method} failed: {error}")); }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    fn notify(&self, method: &str) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        write_line(&mut *input, &json!({"jsonrpc":"2.0","method":method}))
    }
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            #[cfg(unix)]
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl McpState {
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() { session.stop(); }
        }
    }
}
fn key(root: &Path, name: &str) -> String { format!("{}\n{name}", root.display()) }
fn text_result(result: &Value) -> String {
    let content = result.get("content").and_then(Value::as_array);
    let text = content.map(|items| items.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")).unwrap_or_else(|| result.to_string());
    text.chars().take(60_000).collect()
}
#[tauri::command]
pub fn mcp_connect(workspace: tauri::State<'_, WorkspaceState>, state: tauri::State<'_, McpState>, root: String, name: String) -> Result<Vec<McpTool>, String> {
    let root = allowed(&workspace, Path::new(&root))?;
    let spec = configured(&root, &name)?;
    let mut command = Command::new(&spec.command);
    command.current_dir(&root).args(&spec.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (key, value) in &spec.env { command.env(key, value); }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().map_err(|e| format!("MCP server did not start: {e}"))?;
    let session = start_session(child)?;
    let init = session.request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"afteredit","version":"0.1.0"}}))?;
    let _ = init;
    session.notify("notifications/initialized")?;
    let listed = session.request("tools/list", json!({}))?;
    let mut tools = Vec::new();
    for tool in listed.get("tools").and_then(Value::as_array).ok_or("MCP server returned no tool list.")?.iter().take(100) {
        let listed_name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        if tool_name(listed_name).is_err() { continue; }
        tools.push(McpTool { name: listed_name.to_string(), description: tool.get("description").and_then(Value::as_str).unwrap_or("").chars().take(300).collect() });
    }
    let mut stored = session;
    stored.tools = tools.iter().map(|tool| tool.name.clone()).collect();
    let id = key(&root, &name);
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = sessions.insert(id, stored) { previous.stop(); }
    Ok(tools)
}
#[tauri::command]
pub fn mcp_call(app: AppHandle, workspace: tauri::State<'_, WorkspaceState>, state: tauri::State<'_, McpState>, root: String, name: String, tool: String, arguments: Value) -> Result<String, String> {
    let root = allowed(&workspace, Path::new(&root))?;
    tool_name(&tool)?;
    if !arguments.is_object() { return Err("MCP arguments must be an object.".into()); }
    if serde_json::to_vec(&arguments).map_err(|e| e.to_string())?.len() > 65536 { return Err("MCP arguments exceed 64 KiB.".into()); }
    let id = key(&root, &name);
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("Connect the MCP server before calling a tool.")?;
    if !session.tools.iter().any(|known| known == &tool) { return Err("That tool was not in the connected server's list.".into()); }
    let result = session.request("tools/call", json!({"name": tool, "arguments": arguments}))?;
    drop(sessions);
    let text = text_result(&result);
    if !crate::secrets::scan_text(&text, &tool).is_empty() { return Err("MCP tool result withheld because it looks like a secret.".into()); }
    crate::journal::record_app(&app, "mcp", "mcp tool", "", &tool, &root.to_string_lossy());
    Ok(text)
}
#[tauri::command]
pub fn mcp_stop(workspace: tauri::State<'_, WorkspaceState>, state: tauri::State<'_, McpState>, root: String, name: String) -> Result<(), String> {
    let root = allowed(&workspace, Path::new(&root))?;
    server_name(&name)?;
    if let Some(session) = state.sessions.lock().map_err(|e| e.to_string())?.remove(&key(&root, &name)) { session.stop(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_cannot_replace_the_loader_path() {
        assert!(blocked_env("PATH"));
        assert!(blocked_env("LD_PRELOAD"));
        assert!(blocked_env("DYLD_INSERT_LIBRARIES"));
        assert!(blocked_env("GIT_DIR"));
        assert!(!blocked_env("API_TOKEN"));
    }
    #[test]
    fn newline_messages_roundtrip_with_a_fixture_server() {
        let dir = std::env::temp_dir().join(format!("afteredit-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let node = crate::toolpath::resolve_binary("node").expect("node");
        let script = dir.join("server.mjs");
        std::fs::write(&script, r#"
let buf='';
process.stdin.on('data', chunk => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index); buf = buf.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id: message.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'fixture', version:'0'}}}) + '\n');
    else if (message.method === 'notifications/initialized') {}
    else if (message.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id: message.id, result:{tools:[{name:'echo', description:'Echo'}]}}) + '\n');
    else if (message.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id: message.id, result:{content:[{type:'text', text:'pong ' + message.params.arguments.value}]}}) + '\n');
  }
});
"#).unwrap();
        let mut command = Command::new(node);
        command.current_dir(&dir).arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let session = start_session(child).unwrap();
        session.request("initialize", json!({})).unwrap();
        session.notify("notifications/initialized").unwrap();
        let tools = session.request("tools/list", json!({})).unwrap();
        assert_eq!(tools["tools"][0]["name"], "echo");
        let result = session.request("tools/call", json!({"name":"echo","arguments":{"value":"ok"}})).unwrap();
        assert_eq!(text_result(&result), "pong ok");
        session.stop();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
