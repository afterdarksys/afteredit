use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::Emitter;
#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    sequence: AtomicU64,
}
struct Session {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>,
    sequence: AtomicU64,
}
impl Session {
    fn send(&self, message: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        write_message(&mut *input, message)
    }
    fn request(&self, method: String, params: Value) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        let result = self
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(45))
                    .map_err(|_| "Language server request timed out".to_string())?
            });
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        result
    }
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("Language server stopped".into()));
            }
        }
    }
}
impl LspState {
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
    }
}
fn write_message(output: &mut impl Write, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len()).map_err(|e| e.to_string())?;
    output.write_all(&bytes).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())
}
fn read_message(input: &mut impl BufRead) -> Result<Value, String> {
    let mut length = None;
    let mut headers = 0;
    loop {
        let mut line = String::new();
        let n = input.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Language server closed output".into());
        }
        headers += n;
        if headers > 16384 {
            return Err("LSP header too large".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "Invalid LSP length")?,
                );
            }
        }
    }
    let length = length.ok_or("LSP message has no Content-Length")?;
    if length > 8 * 1024 * 1024 {
        return Err("LSP message exceeds 8 MiB".into());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub struct Started {
    id: u64,
    root_uri: String,
}
#[tauri::command]
pub fn lsp_start(
    app: tauri::AppHandle,
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
    state: tauri::State<'_, LspState>,
    root: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<Started, String> {
    let root = crate::workspace::allowed(&workspace, Path::new(&root))?;
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.len() >= 8 {
        return Err("Disconnect a language server before starting another (maximum 8)".into());
    }
    let mut cmd = Command::new(command);
    if let Ok(path)=std::env::join_paths(crate::toolpath::search_dirs()){cmd.env("PATH",path);}
    cmd.args(args)
        .envs(env)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        format!("Cannot start language server: {e}. Configure its executable path.")
    })?;
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let id = state.sequence.fetch_add(1, Ordering::SeqCst);
    let session = Arc::new(Session {
        child: Mutex::new(child),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        sequence: AtomicU64::new(1),
    });
    sessions.insert(id, session.clone());
    drop(sessions);
    read_server(session, output, move |message| {
        let _ = app.emit("lsp:notification", json!({"session":id,"message":message}));
    });
    Ok(Started {
        id,
        root_uri: reqwest::Url::from_directory_path(root)
            .map_err(|_| "Invalid project path")?
            .to_string(),
    })
}
#[tauri::command]
pub async fn lsp_request(
    state: tauri::State<'_, LspState>,
    session: u64,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if ![
        "initialize",
        "shutdown",
        "textDocument/hover",
        "textDocument/completion",
        "textDocument/definition",
        "textDocument/formatting",
    ]
    .contains(&method.as_str())
    {
        return Err("Unsupported LSP request".into());
    }
    let server = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session)
        .cloned()
        .ok_or("Language server is not connected")?;
    tauri::async_runtime::spawn_blocking(move || server.request(method, params))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn lsp_notify(
    state: tauri::State<'_, LspState>,
    session: u64,
    method: String,
    params: Value,
) -> Result<(), String> {
    if ![
        "initialized",
        "exit",
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didClose",
        "textDocument/didSave",
        "workspace/didChangeConfiguration",
    ]
    .contains(&method.as_str())
    {
        return Err("Unsupported LSP notification".into());
    }
    let server = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session)
        .cloned()
        .ok_or("Language server is not connected")?;
    server.send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
}
#[tauri::command]
pub fn lsp_stop(state: tauri::State<'_, LspState>, session: u64) -> Result<(), String> {
    if let Some(server) = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session)
    {
        server.stop();
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_framing_and_back_to_back_messages() {
        let message = json!({"text":"日本語"});
        let mut bytes = Vec::new();
        write_message(&mut bytes, &message).unwrap();
        write_message(&mut bytes, &json!({"id":2})).unwrap();
        let mut reader = std::io::Cursor::new(bytes);
        assert_eq!(read_message(&mut reader).unwrap(), message);
        assert_eq!(read_message(&mut reader).unwrap()["id"], 2);
    }
    #[test]
    fn malformed_frames_fail_closed() {
        for bytes in [
            b"Content-Length: 99999999\r\n\r\n".as_slice(),
            b"Missing: 4\r\n\r\n{}",
            b"Content-Length: 20\r\n\r\n{}",
        ] {
            assert!(read_message(&mut std::io::Cursor::new(bytes)).is_err());
        }
    }
}

fn read_server(
    session: Arc<Session>,
    output: ChildStdout,
    notify: impl Fn(Value) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        while let Ok(message) = read_message(&mut reader) {
            if message.get("method").is_some() {
                if let Some(request_id) = message.get("id") {
                    let method = message["method"].as_str().unwrap_or("");
                    let response = match method {
                        "workspace/configuration" => {
                            json!({"jsonrpc":"2.0","id":request_id,"result":message.pointer("/params/items").and_then(Value::as_array).map(|items|vec![Value::Null;items.len()]).unwrap_or_default()})
                        }
                        "window/workDoneProgress/create" => {
                            json!({"jsonrpc":"2.0","id":request_id,"result":null})
                        }
                        _ => {
                            json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Client capability not supported"}})
                        }
                    };
                    let _ = session.send(&response);
                } else {
                    notify(message);
                }
            } else if let Some(request_id) = message["id"].as_u64() {
                if let Ok(mut pending) = session.pending.lock() {
                    if let Some(tx) = pending.remove(&request_id) {
                        let value = if message.get("error").is_some() {
                            Err(message["error"].to_string())
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = tx.send(value);
                    }
                }
            }
        }
        session.stop();
        notify(json!({"method":"afteredit/stopped"}));
    });
}
#[cfg(test)]
mod integration_tests {
    use super::*;
    #[test]
    #[ignore = "requires an installed clangd; run explicitly for native LSP smoke testing"]
    fn clangd_stdio_roundtrip() { language_smoke(false); }
    #[test]
    #[ignore = "requires Xcode SourceKit-LSP and Swift package toolchain caches"]
    fn sourcekit_swift_diagnostics() { language_smoke(true); }
    fn language_smoke(swift:bool) {
        let mut child = Command::new(if swift{"/usr/bin/xcrun"}else{"clangd"})
            .args(if swift{vec!["sourcekit-lsp"]}else{vec!["--log=error"]})
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("clangd must be installed");
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let session = Arc::new(Session {
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        });
        let (tx, rx) = mpsc::channel();
        read_server(session.clone(), output, move |message| {
            let _ = tx.send(message);
        });
        struct Cleanup(Arc<Session>);impl Drop for Cleanup{fn drop(&mut self){self.0.stop();}}let _cleanup=Cleanup(session.clone());
        let root=if swift{Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/apple").canonicalize().unwrap()}else{std::path::PathBuf::from("/tmp")};
        let root_uri=reqwest::Url::from_directory_path(&root).unwrap().to_string();
        let result=session.request("initialize".into(),json!({"processId":null,"rootUri":root_uri,"workspaceFolders":[{"uri":root_uri,"name":"Fixture"}],"capabilities":{"general":{"positionEncodings":["utf-16"]}}}));
        assert!(result.as_ref().unwrap()["capabilities"]["hoverProvider"]
            .as_bool()
            .unwrap());
        session
            .send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .unwrap();
        let uri=if swift{reqwest::Url::from_file_path(root.join("Sources/SampleCore/Answer.swift")).unwrap().to_string()}else{"file:///tmp/afteredit-lsp-smoke.c".into()};
        session.send(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":if swift{"swift"}else{"c"},"version":1,"text":if swift{"public func answer() -> Int { missing_symbol }"}else{"int main() { return missing_symbol; }"}}}})).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let mut diagnostics = false;
        while std::time::Instant::now() < deadline {
            if let Ok(message) = rx.recv_timeout(Duration::from_millis(500)) {
                if message["method"] == "textDocument/publishDiagnostics"
                    && !message["params"]["diagnostics"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                {
                    diagnostics = true;
                    break;
                }
            }
        }
        let _ = session.request("shutdown".into(), Value::Null);
        session.stop();
        assert!(
            diagnostics,
            "Language server should publish diagnostics for the unsaved source buffer"
        );
    }
}
