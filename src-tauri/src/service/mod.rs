//! Client-neutral workspace service. No window or renderer is required.
pub mod cli;
mod terminal;
mod transport;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
pub use transport::{default_socket, ensure_server, rpc, serve};
const MAX_TEXT: usize = 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Buffer {
    pub path: String,
    pub text: String,
    pub saved: String,
    pub version: u64,
    #[serde(default)]
    pub undo: Vec<String>,
    #[serde(default)]
    pub redo: Vec<String>,
}
impl Buffer {
    fn view(&self) -> Value {
        json!({"path":self.path,"text":self.text,"version":self.version,"dirty":self.text!=self.saved,"undo":self.undo.len(),"redo":self.redo.len()})
    }
}
pub struct Service {
    root: PathBuf,
    buffers: Mutex<HashMap<String, Buffer>>,
    recovery: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    pub stopping: AtomicBool,
    tasks: crate::tasks::TaskState,
    runs: Arc<Mutex<Vec<Value>>>,
    lsp: crate::lsp::LspState,
    language: Mutex<Option<(u64, String, Value)>>,
    dap: crate::dap::DapState,
    debug: Mutex<Option<(u64, Value, String)>>,
}
impl Service {
    pub fn new(root: &Path, recovery: PathBuf) -> Result<Arc<Self>, String> {
        let root = root.canonicalize().map_err(err)?;
        if !root.is_dir() {
            return Err("Workspace must be a directory".into());
        }
        let mut buffers = HashMap::new();
        if recovery.exists() {
            let meta = fs::symlink_metadata(&recovery).map_err(err)?;
            if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
                return Err("Recovery file is invalid or too large".into());
            }
            let saved: Value =
                serde_json::from_slice(&fs::read(&recovery).map_err(err)?).map_err(err)?;
            if saved["root"] != root.to_string_lossy().as_ref() {
                return Err("Recovery belongs to a different workspace".into());
            }
            buffers = serde_json::from_value(saved["buffers"].clone()).map_err(err)?;
        }
        if buffers.len() > 20 {
            return Err("Too many recovery buffers".into());
        }
        for (path, b) in &buffers {
            let b: &Buffer = b;
            if b.path != *path
                || b.text.len() > MAX_TEXT
                || b.saved.len() > MAX_TEXT
                || b.undo.len() > 20
                || b.redo.len() > 20
                || b.undo.iter().chain(&b.redo).any(|v| v.len() > MAX_TEXT)
                || !Path::new(path)
                    .canonicalize()
                    .map_err(err)?
                    .starts_with(&root)
            {
                return Err("Recovery buffer is invalid".into());
            }
        }
        Ok(Arc::new(Self {
            root,
            buffers: Mutex::new(buffers),
            recovery,
            events: Arc::new(Mutex::new(vec![])),
            stopping: AtomicBool::new(false),
            tasks: Default::default(),
            runs: Arc::new(Mutex::new(vec![])),
            lsp: Default::default(),
            language: Mutex::new(None),
            dap: Default::default(),
            debug: Mutex::new(None),
        }))
    }
    fn path(&self, text: &str) -> Result<PathBuf, String> {
        let input = Path::new(text);
        let path = if input.is_absolute() {
            input.to_path_buf()
        } else {
            self.root.join(input)
        }
        .canonicalize()
        .map_err(err)?;
        if !path.starts_with(&self.root) {
            return Err("Path is outside this workspace".into());
        }
        Ok(path)
    }
    fn persist(&self, buffers: &HashMap<String, Buffer>) -> Result<(), String> {
        let bytes =
            serde_json::to_vec(&json!({"root":self.root,"buffers":buffers})).map_err(err)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("Session recovery exceeds 16 MiB; close saved buffers".into());
        }
        let temp = self.recovery.with_extension("new");
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temp)
                .map_err(err)?;
            file.write_all(&bytes).map_err(err)?;
            file.sync_all().map_err(err)?;
        }
        #[cfg(not(unix))]
        fs::write(&temp, bytes).map_err(err)?;
        fs::rename(temp, &self.recovery).map_err(err)
    }
    fn config(&self) -> Result<Value, String> {
        let file = self.root.join(".afteredit.json");
        if !file.exists() {
            return Ok(json!({}));
        }
        let file = self.path(".afteredit.json")?;
        if fs::metadata(&file).map_err(err)?.len() > MAX_TEXT as u64 {
            return Err("Configuration exceeds 1 MiB".into());
        }
        serde_json::from_slice(&fs::read(file).map_err(err)?).map_err(err)
    }
    fn event(events: &Arc<Mutex<Vec<Value>>>, value: Value) {
        let value = if value.to_string().len() > 16000 {
            json!({"truncated":true,"summary":value.to_string().chars().take(8000).collect::<String>()})
        } else {
            value
        };
        if let Ok(mut e) = events.lock() {
            let sequence = e.last().and_then(|v| v["sequence"].as_u64()).unwrap_or(0) + 1;
            e.push(json!({"sequence":sequence,"event":value}));
            if e.len() > 300 {
                e.remove(0);
            }
        }
    }
    fn notify_buffer(&self, b: &Buffer, opened: bool) {
        if let Ok(language) = self.language.lock() {
            if let Some((id, language, _)) = language.as_ref() {
                let uri = reqwest::Url::from_file_path(&b.path).unwrap().to_string();
                let params = if opened {
                    json!({"textDocument":{"uri":uri,"languageId":language,"version":b.version,"text":b.text}})
                } else {
                    json!({"textDocument":{"uri":uri,"version":b.version},"contentChanges":[{"text":b.text}]})
                };
                let _ = crate::lsp::service_notify(
                    &self.lsp,
                    *id,
                    if opened {
                        "textDocument/didOpen"
                    } else {
                        "textDocument/didChange"
                    },
                    params,
                );
            }
        }
    }
    pub fn request(self: &Arc<Self>, method: &str, p: Value) -> Result<Value, String> {
        match method {
            "capabilities" => Ok(
                json!({"protocol":1,"root":self.root,"bufferVersioning":true,"terminalModes":["plain","visual"],"methods":["capabilities","session.status","session.stop","files","search","buffer.create","buffer.open","buffer.get","buffer.list","buffer.edit","buffer.save","buffer.undo","buffer.redo","buffer.diff","buffer.close","events","task.plan","task.run","task.list","task.cancel","git.status","git.diff","git.stage","language.start","language.request","diagnostics","symbols","debug.start","debug.request","debug.stop"],"limits":{"bufferBytes":MAX_TEXT,"buffers":20},"languageConnected":self.language.lock().unwrap().is_some(),"debugConnected":self.debug.lock().unwrap().is_some()}),
            ),
            "session.status" => Ok(
                json!({"root":self.root,"buffers":self.buffers.lock().unwrap().values().map(|b|json!({"path":b.path,"version":b.version,"dirty":b.text!=b.saved})).collect::<Vec<_>>(),"recovery":self.recovery}),
            ),
            "session.stop" => {
                if p["force"] != true
                    && self
                        .buffers
                        .lock()
                        .unwrap()
                        .values()
                        .any(|b| b.text != b.saved)
                {
                    return Err("Unsaved shared buffers remain. Save them or use force; recovery is retained.".into());
                }
                self.stopping.store(true, Ordering::SeqCst);
                self.tasks.shutdown();
                self.lsp.shutdown();
                self.dap.shutdown();
                Ok(json!({"stopping":true}))
            }
            "files" => {
                let path = self.path(p["path"].as_str().unwrap_or("."))?;
                let mut entries = vec![];
                for item in fs::read_dir(path).map_err(err)?.take(2000) {
                    let item = item.map_err(err)?;
                    let kind = item.file_type().map_err(err)?;
                    if !kind.is_symlink() {
                        entries.push(json!({"name":item.file_name().to_string_lossy(),"path":item.path(),"directory":kind.is_dir()}));
                    }
                }
                Ok(json!(entries))
            }
            "buffer.list" => Ok(json!(self
                .buffers
                .lock()
                .unwrap()
                .values()
                .map(|b| json!({"path":b.path,"version":b.version,"dirty":b.text!=b.saved}))
                .collect::<Vec<_>>())),
            m if m.starts_with("buffer.") => self.buffer(m, &p),
            "search" => self.search(&p),
            "events" => Ok(json!(self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["sequence"].as_u64().unwrap_or(0) > p["after"].as_u64().unwrap_or(0))
                .cloned()
                .collect::<Vec<_>>())),
            "task.plan" => {
                let plan = self.task_plan(text(&p, "name")?)?;
                Ok(json!({"tasks":plan,"approval":serde_json::to_string(&plan).map_err(err)?}))
            }
            "task.run" => self.run_task(&p),
            "task.list" => Ok(json!(self.runs.lock().unwrap().clone())),
            "task.cancel" => {
                let id = p["runId"].as_u64().ok_or("runId is required")?;
                let mut runs = self.runs.lock().unwrap();
                let run = runs
                    .iter_mut()
                    .find(|v| v["id"] == id && v["status"] == "running")
                    .ok_or("No running task with this service id")?;
                run["cancelled"] = json!(true);
                let native = run["nativeId"].as_u64();
                drop(runs);
                if let Some(native) = native {
                    self.tasks.cancel(Some(native));
                }
                Ok(json!({"cancelRequested":id}))
            }
            "git.status" => self.git(&["status", "--short", "--branch"]),
            "git.diff" => self.git(&["--no-pager", "diff", "--no-ext-diff", "--no-textconv"]),
            "git.stage" => {
                if p["approve"] != true {
                    return Err("Staging requires approve=true".into());
                }
                let path = self.path(text(&p, "path")?)?;
                if self
                    .buffers
                    .lock()
                    .unwrap()
                    .get(&path.to_string_lossy().to_string())
                    .is_some_and(|b| b.text != b.saved)
                {
                    return Err("Save the shared buffer before staging".into());
                }
                self.git(&["add", "--", path.to_str().ok_or("Invalid path")?])
            }
            "language.start" => self.start_language(&p),
            "language.request" => {
                let id = self
                    .language
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|v| v.0)
                    .ok_or("Start a configured language server first")?;
                crate::lsp::service_request(&self.lsp, id, text(&p, "method")?, p["params"].clone())
            }
            "diagnostics" => Ok(json!(self
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v.pointer("/event/language/message/method")
                    == Some(&json!("textDocument/publishDiagnostics")))
                .cloned()
                .collect::<Vec<_>>())),
            "symbols" => {
                let id = self
                    .language
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|v| v.0)
                    .ok_or("Start a language server first")?;
                crate::lsp::service_request(
                    &self.lsp,
                    id,
                    "workspace/symbol",
                    json!({"query":p["query"].as_str().unwrap_or("")}),
                )
            }
            "debug.start" => self.start_debug(&p),
            "debug.request" => {
                let (id, caps, _) = self
                    .debug
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or("Start a debugger first")?;
                let command = text(&p, "command")?;
                let cap = match command {
                    "readMemory" => Some("supportsReadMemoryRequest"),
                    "disassemble" => Some("supportsDisassembleRequest"),
                    "stepBack" | "reverseContinue" => Some("supportsStepBack"),
                    "dataBreakpointInfo" | "setDataBreakpoints" => Some("supportsDataBreakpoints"),
                    _ => None,
                };
                if cap.is_some_and(|c| caps[c] != true) {
                    return Err("Adapter does not support this operation".into());
                }
                crate::dap::service_request(
                    &self.dap,
                    id,
                    command,
                    p.get("arguments").cloned().unwrap_or(json!({})),
                )
            }
            "debug.stop" => {
                if let Some((id, _, mode)) = self.debug.lock().unwrap().take() {
                    let _ = crate::dap::service_request(
                        &self.dap,
                        id,
                        "disconnect",
                        json!({"terminateDebuggee":mode=="launch"}),
                    );
                    crate::dap::service_stop(&self.dap, id);
                }
                Ok(json!({"stopped":true}))
            }
            _ => Err(format!(
                "Unknown method: {method}. Use capabilities to discover supported methods."
            )),
        }
    }
    fn buffer(&self, method: &str, p: &Value) -> Result<Value, String> {
        if method == "buffer.create" {
            let input = Path::new(text(p, "path")?);
            let candidate = if input.is_absolute() {
                input.to_path_buf()
            } else {
                self.root.join(input)
            };
            let parent = candidate
                .parent()
                .ok_or("File needs a parent directory")?
                .canonicalize()
                .map_err(err)?;
            if !parent.starts_with(&self.root) {
                return Err("Path is outside this workspace".into());
            }
            let target = parent.join(candidate.file_name().ok_or("File name required")?);
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(target).map_err(err)?;
            return self.buffer("buffer.open", p);
        }
        let path = self.path(text(p, "path")?)?;
        let key = path.to_string_lossy().to_string();
        let mut buffers = self.buffers.lock().map_err(err)?;
        if method == "buffer.open" && !buffers.contains_key(&key) {
            if buffers.len() >= 20 {
                return Err("Close a buffer first (maximum 20)".into());
            }
            if fs::metadata(&path).map_err(err)?.len() > MAX_TEXT as u64 {
                return Err("File exceeds 1 MiB prototype buffer limit".into());
            }
            let value = fs::read_to_string(&path).map_err(err)?;
            if value.contains('\0') {
                return Err("Binary files are not supported".into());
            }
            let b = Buffer {
                path: key.clone(),
                text: value.clone(),
                saved: value,
                version: 1,
                undo: vec![],
                redo: vec![],
            };
            self.notify_buffer(&b, true);
            buffers.insert(key.clone(), b);
            if let Err(e) = self.persist(&buffers) {
                buffers.remove(&key);
                return Err(e);
            }
        }
        let b = buffers.get(&key).ok_or("Open the buffer first")?.clone();
        if method == "buffer.get" || method == "buffer.open" {
            return Ok(b.view());
        }
        if method == "buffer.diff" {
            return Ok(json!({"path":key,"version":b.version,"saved":b.saved,"current":b.text}));
        }
        let expected = p["version"]
            .as_u64()
            .ok_or("Expected buffer version is required")?;
        if expected != b.version {
            return Err(format!("Version conflict: expected {expected}, current {}. Fetch and review the current buffer.",b.version));
        }
        if method == "buffer.close" {
            if b.text != b.saved {
                return Err("Save this buffer before closing it".into());
            }
            buffers.remove(&key);
            if let Err(e) = self.persist(&buffers) {
                buffers.insert(key, b);
                return Err(e);
            }
            return Ok(json!({"closed":key}));
        }
        let mut next = b.clone();
        match method {
            "buffer.edit" => {
                let text = text(p, "text")?;
                if text.len() > MAX_TEXT || text.contains('\0') {
                    return Err("Buffer must be UTF-8 text under 1 MiB".into());
                }
                next.undo.push(next.text.clone());
                next.redo.clear();
                next.text = text.into();
            }
            "buffer.undo" => {
                next.text = next.undo.pop().ok_or("Nothing to undo")?;
                next.redo.push(b.text.clone());
            }
            "buffer.redo" => {
                next.text = next.redo.pop().ok_or("Nothing to redo")?;
                next.undo.push(b.text.clone());
            }
            "buffer.save" => {
                crate::workspace::write_checked(&path, &b.text, &b.saved)?;
                next.saved = next.text.clone();
            }
            _ => return Err("Unknown buffer operation".into()),
        }
        next.version += 1;
        while next.undo.len() > 20
            || next.undo.iter().map(String::len).sum::<usize>() > 2 * MAX_TEXT
        {
            next.undo.remove(0);
        }
        while next.redo.len() > 20
            || next.redo.iter().map(String::len).sum::<usize>() > 2 * MAX_TEXT
        {
            next.redo.remove(0);
        }
        buffers.insert(key.clone(), next.clone());
        if let Err(e) = self.persist(&buffers) {
            if method != "buffer.save" {
                buffers.insert(key, b);
            }
            return Err(format!("Recovery could not be written: {e}"));
        }
        self.notify_buffer(&next, false);
        Self::event(
            &self.events,
            json!({"buffer":{"path":next.path,"version":next.version,"dirty":next.text!=next.saved}}),
        );
        Ok(next.view())
    }
    fn search(&self, p: &Value) -> Result<Value, String> {
        let query = text(p, "query")?;
        if query.is_empty() {
            return Err("Search text is required".into());
        }
        let buffers = self.buffers.lock().unwrap().clone();
        let mut hits = vec![];
        let mut dirs = vec![self.root.clone()];
        let mut count = 0;
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).map_err(err)? {
                count += 1;
                if count > 10000 || hits.len() >= 200 {
                    return Ok(json!({"hits":hits,"truncated":true}));
                }
                let entry = entry.map_err(err)?;
                let kind = entry.file_type().map_err(err)?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if ![".git", "node_modules", "target", "dist"]
                        .contains(&entry.file_name().to_string_lossy().as_ref())
                    {
                        dirs.push(entry.path());
                    }
                    continue;
                }
                if entry.metadata().map_err(err)?.len() > MAX_TEXT as u64 {
                    continue;
                }
                let path = entry.path().to_string_lossy().to_string();
                let value = buffers
                    .get(&path)
                    .map(|b| b.text.clone())
                    .or_else(|| fs::read_to_string(entry.path()).ok());
                if let Some(value) = value {
                    for (line, text) in value.lines().enumerate() {
                        if text.contains(query) {
                            hits.push(json!({"path":path,"line":line+1,"text":text.chars().take(300).collect::<String>()}));
                            if hits.len() >= 200 {
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(json!({"hits":hits,"truncated":false}))
    }
    fn git(&self, args: &[&str]) -> Result<Value, String> {
        let mut command = std::process::Command::new("git");
        command
            .args(args)
            .current_dir(&self.root)
            .env("GIT_OPTIONAL_LOCKS", "0");
        let result = crate::process::run(command, Duration::from_secs(30))?;
        if result.code != 0 {
            return Err(result.stderr);
        }
        Ok(json!({"output":result.stdout}))
    }
}
fn text<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p[key].as_str().ok_or_else(|| format!("{key} is required"))
}
impl Service {
    fn task_plan(&self, name: &str) -> Result<Vec<(String, Value)>, String> {
        let config = self.config()?;
        let tasks = config["tasks"]
            .as_object()
            .ok_or("No tasks in .afteredit.json")?;
        fn visit(
            name: &str,
            tasks: &serde_json::Map<String, Value>,
            seen: &mut Vec<String>,
            visiting: &mut Vec<String>,
            out: &mut Vec<(String, Value)>,
        ) -> Result<(), String> {
            if seen.iter().any(|s| s == name) {
                return Ok(());
            }
            if visiting.iter().any(|s| s == name) {
                return Err("Task dependency cycle".into());
            }
            if out.len() + visiting.len() > 100 {
                return Err("Too many task dependencies".into());
            }
            let task = tasks
                .get(name)
                .ok_or_else(|| format!("Unknown task {name}"))?;
            visiting.push(name.into());
            if let Some(deps) = task["dependsOn"].as_array() {
                for dep in deps {
                    visit(
                        dep.as_str().ok_or("Invalid dependency")?,
                        tasks,
                        seen,
                        visiting,
                        out,
                    )?;
                }
            }
            visiting.pop();
            seen.push(name.into());
            out.push((name.into(), task.clone()));
            Ok(())
        }
        let mut out = vec![];
        visit(name, tasks, &mut vec![], &mut vec![], &mut out)?;
        for (_, task) in &mut out {
            *task = expand_workspace(task, &self.root.to_string_lossy());
            if task.get("args").is_none() {
                task["args"] = json!([]);
            }
            if task.to_string().contains("${file}") {
                return Err("Shared tasks require explicit file paths; ${file} has no shared active-file meaning".into());
            }
        }
        Ok(out)
    }
    fn run_task(self: &Arc<Self>, p: &Value) -> Result<Value, String> {
        let plan = self.task_plan(text(p, "name")?)?;
        if p["approval"].as_str() != Some(serde_json::to_string(&plan).map_err(err)?.as_str()) {
            return Err("Review task.plan and send its exact approval value; configuration may have changed".into());
        }
        if self
            .buffers
            .lock()
            .unwrap()
            .values()
            .any(|b| b.text != b.saved)
        {
            return Err("Save shared buffers before running a task".into());
        }
        for (_, task) in &plan {
            let args: Vec<String> =
                serde_json::from_value(task.get("args").cloned().unwrap_or(json!([])))
                    .map_err(err)?;
            if let Some(challenge) =
                crate::guard::challenge_for_task(Some(&self.root), text(task, "command")?, &args)
            {
                if !crate::guard::answered(&challenge, p["confirmation"].as_str()) {
                    return Err(format!(
                        "Confirmation required for {}: type {} using --confirm",
                        challenge.action, challenge.expected
                    ));
                }
            }
        }
        let mut runs = self.runs.lock().unwrap();
        if runs.iter().any(|v| v["status"] == "running") {
            return Err("A service task is running".into());
        }
        let id = runs.last().and_then(|r| r["id"].as_u64()).unwrap_or(0) + 1;
        runs.push(json!({"id":id,"name":p["name"],"status":"running","output":""}));
        if runs.len() > 20 {
            runs.remove(0);
        }
        drop(runs);
        let service = self.clone();
        std::thread::spawn(move || {
            let mut code = 0;
            let mut output = String::new();
            let mut status = "succeeded".to_string();
            for (name, task) in plan {
                if service.stopping.load(Ordering::SeqCst)
                    || service
                        .runs
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|r| r["id"] == id && r["cancelled"] == true)
                {
                    status = "cancelled".into();
                    code = -1;
                    break;
                }
                let parsed = serde_json::from_value::<crate::tasks::Task>(task.clone());
                let directory = service.path(task["cwd"].as_str().unwrap_or("."));
                let events = service.events.clone();
                let records = service.runs.clone();
                let cancellation = service.tasks.clone();
                let result = parsed.map_err(err).and_then(|task| {
                    directory.and_then(|dir| {
                        crate::tasks::execute(
                            task,
                            dir,
                            service.tasks.clone(),
                            format!("service-{id}"),
                            Arc::new(move |event| {
                                let value = serde_json::to_value(event).unwrap_or(Value::Null);
                                if let Ok(mut runs) = records.lock() {
                                    if let Some(run) = runs.iter_mut().find(|v| v["id"] == id) {
                                        run["nativeId"] = value["runId"].clone();

                                        let text = value["text"].as_str().unwrap_or("");
                                        let combined = format!(
                                            "{}{}",
                                            run["output"].as_str().unwrap_or(""),
                                            text
                                        );
                                        run["output"] = json!(tail(&combined, 200000));
                                    }
                                }
                                if value["kind"] == "started" {
                                    let cancelled = records
                                        .lock()
                                        .unwrap()
                                        .iter()
                                        .any(|r| r["id"] == id && r["cancelled"] == true);
                                    if cancelled {
                                        if let Some(native) = value["runId"].as_u64() {
                                            cancellation.cancel(Some(native));
                                        }
                                    }
                                }
                                Self::event(&events, json!({"task":value}));
                            }),
                        )
                    })
                });
                match result {
                    Ok(result) => {
                        let result = serde_json::to_value(result).unwrap();
                        code = result["code"].as_i64().unwrap_or(-1);
                        status = result["status"].as_str().unwrap_or("error").into();
                        output = tail(
                            &format!(
                                "{output}\n{name}:\n{}",
                                result["output"].as_str().unwrap_or("")
                            ),
                            200000,
                        );
                        if code != 0 {
                            break;
                        }
                    }
                    Err(e) => {
                        code = -1;
                        status = "error".into();
                        output = tail(&format!("{output}\n{e}"), 200000);
                        break;
                    }
                }
            }
            if let Some(run) = service
                .runs
                .lock()
                .unwrap()
                .iter_mut()
                .find(|v| v["id"] == id)
            {
                run["status"] = json!(status);
                run["code"] = json!(code);
                run["output"] = json!(output);
            }
        });
        Ok(json!({"id":id,"status":"running"}))
    }
    fn start_language(&self, p: &Value) -> Result<Value, String> {
        if p["approve"] != true {
            return Err("Starting language-server code requires approve=true".into());
        }
        let config = self.config()?;
        let name = text(p, "name")?;
        let server = &config["languageServers"][name];
        let mut language = self.language.lock().unwrap();
        if language.is_some() {
            return Err(
                "A language server is already connected; stop the workspace service to change it"
                    .into(),
            );
        }
        let events = self.events.clone();
        let args = serde_json::from_value(server.get("args").cloned().unwrap_or(json!([])))
            .map_err(err)?;
        let env =
            serde_json::from_value(server.get("env").cloned().unwrap_or(json!({}))).map_err(err)?;
        let started = crate::lsp::service_start(
            &self.lsp,
            self.root.clone(),
            text(server, "command")?.into(),
            args,
            env,
            move |message| Self::event(&events, json!({"language":message})),
        )?;
        let started = serde_json::to_value(started).map_err(err)?;
        let id = started["id"].as_u64().ok_or("Missing server id")?;
        let initialized = (|| -> Result<Value, String> {
            let caps = crate::lsp::service_request(
                &self.lsp,
                id,
                "initialize",
                json!({"processId":std::process::id(),"rootUri":started["root_uri"],"workspaceFolders":[{"uri":started["root_uri"],"name":self.root.file_name().unwrap_or_default().to_string_lossy()}],"capabilities":{"general":{"positionEncodings":["utf-16"]},"textDocument":{"synchronization":{"didSave":true}}}}),
            )?;
            crate::lsp::service_notify(&self.lsp, id, "initialized", json!({}))?;
            Ok(caps)
        })();
        let caps = match initialized {
            Ok(caps) => caps,
            Err(e) => {
                self.lsp.shutdown();
                return Err(e);
            }
        };
        *language = Some((
            id,
            p["language"].as_str().unwrap_or(name).into(),
            caps.clone(),
        ));
        drop(language);
        for b in self.buffers.lock().unwrap().values() {
            self.notify_buffer(b, true);
        }
        Ok(json!({"session":id,"capabilities":caps}))
    }
    fn start_debug(&self, p: &Value) -> Result<Value, String> {
        if p["approve"] != true {
            return Err("Starting a debugger and target requires approve=true".into());
        }
        if self
            .buffers
            .lock()
            .unwrap()
            .values()
            .any(|b| b.text != b.saved)
        {
            return Err("Save shared buffers before debugging".into());
        }
        let config = self.config()?;
        let cfg = &config["debug"][text(p, "name")?];
        let adapter = serde_json::from_value(cfg["adapter"].clone()).map_err(err)?;
        let mode = cfg["request"].as_str().unwrap_or("launch");
        if !["launch", "attach"].contains(&mode) {
            return Err("Expected launch or attach".into());
        }
        let mut debug = self.debug.lock().unwrap();
        if debug.is_some() {
            return Err("Stop the current debugger first".into());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let events = self.events.clone();
        let id =
            crate::dap::service_start(&self.dap, self.root.clone(), adapter, move |message| {
                if message["message"]["event"] == "initialized" {
                    let _ = tx.send(());
                }
                Self::event(&events, json!({"debug":message}));
            })?;
        let run = || -> Result<Value, String> {
            let caps = crate::dap::service_request(
                &self.dap,
                id,
                "initialize",
                json!({"clientID":"afteredit-service","adapterID":"configured","pathFormat":"path","linesStartAt1":true,"columnsStartAt1":true,"supportsRunInTerminalRequest":false}),
            )?;
            fn expand(v: &Value, root: &str) -> Value {
                match v {
                    Value::String(s) => json!(s.replace("${workspaceFolder}", root)),
                    Value::Array(a) => json!(a.iter().map(|v| expand(v, root)).collect::<Vec<_>>()),
                    Value::Object(o) => Value::Object(
                        o.iter()
                            .map(|(k, v)| (k.clone(), expand(v, root)))
                            .collect(),
                    ),
                    _ => v.clone(),
                }
            }
            let args = expand(&cfg["configuration"], &self.root.to_string_lossy());
            std::thread::scope(|scope| -> Result<(), String> {
                let launched =
                    scope.spawn(|| crate::dap::service_request(&self.dap, id, mode, args));
                if rx.recv_timeout(Duration::from_secs(30)).is_err() {
                    crate::dap::service_stop(&self.dap, id);
                    return Err("Adapter did not initialize".into());
                }
                if caps["supportsConfigurationDoneRequest"] == true {
                    crate::dap::service_request(&self.dap, id, "configurationDone", json!({}))?;
                }
                launched.join().map_err(|_| "Launch worker failed")??;
                Ok(())
            })?;
            Ok(caps)
        };
        match run() {
            Ok(caps) => {
                *debug = Some((id, caps.clone(), mode.into()));
                Ok(json!({"session":id,"capabilities":caps}))
            }
            Err(e) => {
                crate::dap::service_stop(&self.dap, id);
                Err(e)
            }
        }
    }
}
fn tail(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut cut = text.len() - limit;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    text[cut..].into()
}

fn expand_workspace(value: &Value, root: &str) -> Value {
    match value {
        Value::String(s) => json!(s
            .replace("${project}", root)
            .replace("${workspaceFolder}", root)),
        Value::Array(a) => Value::Array(a.iter().map(|v| expand_workspace(v, root)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), expand_workspace(v, root)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests;
