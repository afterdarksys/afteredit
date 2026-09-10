use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::Emitter;
#[derive(Default)]
pub struct DapState {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    sequence: AtomicU64,
}
#[derive(Deserialize)]
pub struct Adapter {
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    port: Option<u16>,
}
struct Session {
    child: Mutex<Option<Child>>,
    socket: Option<TcpStream>,
    input: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<Value, String>>>>,
    sequence: AtomicU64,
    closed: AtomicBool,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn write_frame(output: &mut impl Write, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(error)?;
    write!(output, "Content-Length: {}\r\n\r\n", bytes.len()).map_err(error)?;
    output.write_all(&bytes).map_err(error)?;
    output.flush().map_err(error)
}
fn read_frame(input: &mut impl BufRead) -> Result<Value, String> {
    let mut length = None;
    let mut total = 0;
    loop {
        let mut line = String::new();
        let n = (&mut *input)
            .take(16385)
            .read_line(&mut line)
            .map_err(error)?;
        total += n;
        if n == 0 {
            return Err("Debug adapter closed output".into());
        }
        if total > 16384 {
            return Err("DAP header too large".into());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("Content-Length") {
                if length.is_some() {
                    return Err("Duplicate DAP length".into());
                }
                length = Some(value.trim().parse::<usize>().map_err(error)?);
            }
        }
    }
    let length = length.ok_or("Missing DAP Content-Length")?;
    if length > 8 * 1024 * 1024 {
        return Err("DAP body exceeds 8 MiB".into());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(error)?;
    serde_json::from_slice(&bytes).map_err(error)
}
impl Session {
    fn send(&self, message: &Value) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Debug session closed".into());
        }
        write_frame(&mut *self.input.lock().map_err(error)?, message)
    }
    fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().map_err(error)?;
            if pending.len() >= 64 {
                return Err("Too many pending debugger requests".into());
            }
            pending.insert(seq, tx);
        }
        let result = self
            .send(&json!({"seq":seq,"type":"request","command":command,"arguments":arguments}))
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(45))
                    .map_err(|_| "Debugger request timed out".to_string())?
            });
        self.pending.lock().map_err(error)?.remove(&seq);
        result
    }
    fn stop(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(socket) = &self.socket {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err("Debug session closed".into()));
            }
        }
    }
}
impl DapState {
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
    }
}
fn connect(
    root: &Path,
    adapter: Adapter,
) -> Result<(Arc<Session>, Box<dyn BufRead + Send>), String> {
    let (child, socket, input, output): (
        Option<Child>,
        Option<TcpStream>,
        Box<dyn Write + Send>,
        Box<dyn BufRead + Send>,
    ) = if let Some(port) = adapter.port {
        if port == 0 || adapter.command.is_some() {
            return Err("Choose a stdio command OR a localhost TCP port".into());
        }
        let socket = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_secs(5),
        )
        .map_err(error)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(error)?;
        (
            None,
            Some(socket.try_clone().map_err(error)?),
            Box::new(socket.try_clone().map_err(error)?),
            Box::new(BufReader::new(socket)),
        )
    } else {
        let command = adapter
            .command
            .filter(|v| !v.trim().is_empty())
            .ok_or("Supply a debug adapter command")?;
        let mut cmd = Command::new(command);
        if let Ok(path) = std::env::join_paths(crate::toolpath::search_dirs()) {
            cmd.env("PATH", path);
        }
        cmd.args(adapter.args)
            .envs(adapter.env)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Cannot start debug adapter: {e}"))?;
        let input = Box::new(child.stdin.take().ok_or("Adapter stdin missing")?);
        let output = Box::new(BufReader::new(
            child.stdout.take().ok_or("Adapter stdout missing")?,
        ));
        (Some(child), None, input, output)
    };
    Ok((
        Arc::new(Session {
            child: Mutex::new(child),
            socket,
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        }),
        output,
    ))
}
fn read_adapter(
    session: Arc<Session>,
    mut output: Box<dyn BufRead + Send>,
    emit: impl Fn(Value) + Send + 'static,
) {
    std::thread::spawn(move || {
        loop {
            let message = match read_frame(&mut output) {
                Ok(v) => v,
                Err(e) => {
                    emit(json!({"type":"event","event":"aftereditClosed","body":{"reason":e}}));
                    break;
                }
            };
            match message["type"].as_str() {
                Some("response") => {
                    if let Some(seq) = message["request_seq"].as_u64() {
                        if let Ok(mut pending) = session.pending.lock() {
                            if let Some(tx) = pending.remove(&seq) {
                                let result = if message["success"] == true {
                                    Ok(message["body"].clone())
                                } else {
                                    Err(message["message"]
                                        .as_str()
                                        .unwrap_or("Debug adapter request failed")
                                        .into())
                                };
                                let _ = tx.send(result);
                            }
                        }
                    }
                }
                Some("event") => emit(message),
                Some("request") => {
                    let seq = session.sequence.fetch_add(1, Ordering::SeqCst);
                    let _=session.send(&json!({"seq":seq,"type":"response","request_seq":message["seq"],"command":message["command"],"success":false,"message":"Reverse requests (including runInTerminal) are not supported; use internalConsole"}));
                }
                _ => {}
            }
        }
        session.stop();
    });
}
#[tauri::command]
pub fn dap_start(
    app: tauri::AppHandle,
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
    state: tauri::State<'_, DapState>,
    root: String,
    adapter: Adapter,
) -> Result<u64, String> {
    let root = crate::workspace::allowed(&workspace, Path::new(&root))?;
    if !root.is_dir() {
        return Err("Select a project folder".into());
    }
    let mut sessions = state.sessions.lock().map_err(error)?;
    sessions.retain(|_, s| !s.closed.load(Ordering::SeqCst));
    if !sessions.is_empty() {
        return Err("Stop the existing debug session first".into());
    }
    let (session, output) = connect(&root, adapter)?;
    let id = state.sequence.fetch_add(1, Ordering::SeqCst);
    sessions.insert(id, session.clone());
    read_adapter(session, output, move |message| {
        let _ = app.emit("dap:event", json!({"session":id,"message":message}));
    });
    Ok(id)
}
#[tauri::command]
pub async fn dap_request(
    state: tauri::State<'_, DapState>,
    session: u64,
    command: String,
    arguments: Value,
) -> Result<Value, String> {
    if ![
        "initialize",
        "launch",
        "attach",
        "setBreakpoints",
        "setExceptionBreakpoints",
        "configurationDone",
        "threads",
        "stackTrace",
        "scopes",
        "variables",
        "continue",
        "pause",
        "next",
        "stepIn",
        "stepOut",
        "evaluate",
        "setVariable",
        "disconnect",
        "exceptionInfo",
    ]
    .contains(&command.as_str())
    {
        return Err("Unsupported debug request".into());
    }
    let session = state
        .sessions
        .lock()
        .map_err(error)?
        .get(&session)
        .cloned()
        .ok_or("Debugger not connected")?;
    tauri::async_runtime::spawn_blocking(move || session.request(&command, arguments))
        .await
        .map_err(error)?
}
#[tauri::command]
pub fn dap_stop(state: tauri::State<'_, DapState>, session: u64) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().map_err(error)?.remove(&session) {
        session.stop();
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_preserves_utf8_and_rejects_unbounded_headers() {
        let message = json!({"type":"event","event":"output","body":{"output":"héllo"}});
        let mut bytes = vec![];
        write_frame(&mut bytes, &message).unwrap();
        assert_eq!(read_frame(&mut &bytes[..]).unwrap(), message);
        assert!(read_frame(&mut &b"Content-Length: 1\r\nContent-Length: 1\r\n\r\n0"[..]).is_err());
        assert!(read_frame(&mut &vec![b'x'; 16385][..]).is_err());
        assert!(read_frame(&mut &b"Content-Length: 99999999\r\n\r\n"[..]).is_err());
    }
}
#[cfg(test)]
mod integration_tests {
    use super::*;
    struct Cleanup(Arc<Session>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    fn event(rx: &mpsc::Receiver<Value>, name: &str) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let message = rx
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap_or_else(|e| panic!("Waiting for {name}: {e}"));
            if message["event"] == name {
                return message;
            }
            if message["event"] == "aftereditClosed" {
                panic!("Adapter closed: {message}");
            }
        }
    }
    #[test]
    #[ignore = "requires Xcode lldb-dap and permission to debug a local test process"]
    fn lldb_breakpoint_stack_variables_and_step() { smoke(false); }
    #[test]
    #[ignore = "requires Xcode Swift and permission to debug a local Swift process"]
    fn swift_breakpoint_stack_variables_and_step() { smoke(true); }
    fn smoke(swift:bool) {
        let root = std::env::temp_dir().join(format!("afteredit-dap-smoke-{}-{swift}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join(if swift{"main.swift"}else{"main.c"});
        let program = root.join("program");
        std::fs::write(&source,if swift{"@inline(never)\nfunc runFixture() {\n var value = 41\n value += 1\n print(value)\n}\nrunFixture()\n"}else{"#include <stdio.h>\nint main(void) {\n volatile int value = 41;\n value += 1;\n printf(\"%d\\n\", value);\n return 0;\n}\n"}).unwrap();
        assert!(Command::new("xcrun")
            .args(if swift{["swiftc","-g","-Onone"]}else{["clang", "-g", "-O0"]})
            .arg(&source)
            .arg("-o")
            .arg(&program)
            .status()
            .unwrap()
            .success());
        let (session, output) = connect(
            &root,
            Adapter {
                command: Some("xcrun".into()),
                args: vec!["lldb-dap".into()],
                env: HashMap::new(),
                port: None,
            },
        )
        .unwrap();
        let _cleanup = Cleanup(session.clone());
        let (tx, rx) = mpsc::channel();
        read_adapter(session.clone(), output, move |message| {
            eprintln!("DAP event: {}", message);
            let _ = tx.send(message);
        });
        let caps=session.request("initialize",json!({"adapterID":"lldb","pathFormat":"path","linesStartAt1":true,"columnsStartAt1":true,"supportsRunInTerminalRequest":false})).unwrap();
        let launch_session = session.clone();
        let launch = std::thread::spawn(move || {
            let result = launch_session.request(
                "launch",
                json!({"program":program,"cwd":root,"stopOnEntry":false}),
            );
            eprintln!("Launch result: {:?}", result);
            result
        });
        event(&rx, "initialized");
        let points = session
            .request(
                "setBreakpoints",
                json!({"source":{"path":source},"breakpoints":[{"line":5}]}),
            )
            .unwrap();
        assert_eq!(points["breakpoints"][0]["verified"], true);
        if caps["supportsConfigurationDoneRequest"] == true {
            session.request("configurationDone", json!({})).unwrap();
        }
        launch.join().unwrap().unwrap();
        let stopped = event(&rx, "stopped");
        let threads = session.request("threads", json!({})).unwrap();
        assert!(!threads["threads"].as_array().unwrap().is_empty());
        let thread = stopped["body"]["threadId"].clone();
        let frames = session
            .request("stackTrace", json!({"threadId":thread}))
            .unwrap();
        let frame = frames["stackFrames"][0]["id"].clone();
        assert_eq!(frames["stackFrames"][0]["line"], 5);
        let scopes = session.request("scopes", json!({"frameId":frame})).unwrap();
        let mut found = false;
        for scope in scopes["scopes"].as_array().unwrap() {
            let variables = session
                .request(
                    "variables",
                    json!({"variablesReference":scope["variablesReference"]}),
                )
                .unwrap();
            if variables["variables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["name"] == "value" && v["value"] == "42")
            {
                found = true;
                break;
            }
        }
        assert!(found, "Local value=42 must be visible");
        let evaluated = session
            .request(
                "evaluate",
                json!({"expression":"value","frameId":frame,"context":"watch"}),
            )
            .unwrap();
        assert!(evaluated["result"].as_str().unwrap().contains("42"));
        session.request("next", json!({"threadId":thread})).unwrap();
        event(&rx, "stopped");
        session
            .request("continue", json!({"threadId":thread}))
            .unwrap();
        event(&rx, "terminated");
        let _ = session.request("disconnect", json!({"terminateDebuggee":true}));
    }
}
