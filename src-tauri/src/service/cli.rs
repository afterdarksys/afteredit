use super::*;
use std::io::{self, IsTerminal, Read, Write};
#[derive(Clone)]
pub struct Client {
    pub endpoint: String,
}
impl Client {
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.endpoint.starts_with("ssh://") {
            transport::ssh(&self.endpoint, method, params)
        } else {
            rpc(Path::new(&self.endpoint), method, params)
        }
    }
}
pub const HELP:&str="AfterEdit — a shared, non-modal workspace editor\n\n  afteredit .                         Open the friendly plain terminal editor\n  afteredit file.rs --tui              Open the optional full-screen editor\n  afteredit file.rs --plain            Screen-reader-friendly line interaction\n  afteredit --server --workspace DIR   Keep a workspace service running\n  afteredit --connect SOCKET           Join an existing local session\n  afteredit --connect ssh://HOST/DIR    Connect using SSH (remote CLI required)\n  afteredit edit FILE --wait           Wait for a shared buffer to be saved\n\nCommands:\n  capabilities | status | files [DIR] | search TEXT\n  buffer list | create FILE | open FILE | get FILE | diff FILE\n  buffer set FILE --revision N --text TEXT\n  buffer save|undo|redo|close FILE --revision N\n  run TASK [--approve] [--confirm CONTEXT] | runs | cancel RUN_ID\n  language NAME --approve | diagnostics | symbols QUERY\n  debug start NAME --approve | debug threads | debug request COMMAND JSON\n  git status|diff | git stage FILE --approve\n  rpc METHOD JSON                     Explicit capability API\n  stop [--force]                       Stop server; dirty state needs --force\n\nOptions: --workspace DIR, --socket PATH, --connect ENDPOINT, --json, --help\nPlain editor: help lists discoverable editing commands. No modes or escape chords.\nFull screen: type to insert; arrows move; Ctrl-S saves; Ctrl-Q leaves; Ctrl-P commands.\nLocal service prototype supports macOS/Linux. Recovery is private and survives server\nrestarts, but the OS can remove temporary session data. No command runs on connect.\n";
fn argument_index(args: &[String], key: &str) -> Option<usize> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == key {
            return Some(index);
        }
        if [
            "--workspace",
            "--socket",
            "--connect",
            "--confirm",
            "--revision",
            "--text",
        ]
        .contains(&args[index].as_str())
        {
            index += 2;
        } else {
            index += 1;
        }
    }
    None
}
fn option(args: &mut Vec<String>, key: &str) -> Result<Option<String>, String> {
    if let Some(i) = argument_index(args, key) {
        args.remove(i);
        if i >= args.len() {
            return Err(format!("{key} requires a value"));
        }
        Ok(Some(args.remove(i)))
    } else {
        Ok(None)
    }
}
fn flag(args: &mut Vec<String>, key: &str) -> bool {
    if let Some(i) = argument_index(args, key) {
        args.remove(i);
        true
    } else {
        false
    }
}
pub fn main(args: Vec<String>) -> i32 {
    match run(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("AfterEdit: {}", spoken(&error));
            1
        }
    }
}
fn run(mut args: Vec<String>) -> Result<i32, String> {
    if flag(&mut args, "--help") || flag(&mut args, "-h") {
        print!("{HELP}");
        return Ok(0);
    }
    if flag(&mut args, "--version") {
        println!(
            "AfterEdit {} · service protocol 1",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(0);
    }
    let root = PathBuf::from(option(&mut args, "--workspace")?.unwrap_or_else(|| ".".into()));
    let socket = option(&mut args, "--socket")?;
    let connect = option(&mut args, "--connect")?;
    let server = flag(&mut args, "--server");
    let stdio = flag(&mut args, "--stdio");
    let json_output = flag(&mut args, "--json");
    let visual = flag(&mut args, "--tui");
    let _plain = flag(&mut args, "--plain");
    let wait = flag(&mut args, "--wait");
    let approve = flag(&mut args, "--approve");
    let force = flag(&mut args, "--force");
    let confirmation = option(&mut args, "--confirm")?;
    let revision = option(&mut args, "--revision")?
        .map(|v| v.parse::<u64>().map_err(err))
        .transpose()?;
    let content = option(&mut args, "--text")?;
    let mut workspace = root;
    if args.len() == 1 && Path::new(&args[0]).is_dir() && connect.is_none() {
        workspace = PathBuf::from(args.remove(0));
    }
    let joining = connect.as_ref().is_some_and(|v| v != "local");
    let endpoint = if let Some(endpoint) = connect {
        if endpoint == "local" {
            match socket {
                Some(v) => v,
                None => default_socket(&workspace)?.to_string_lossy().into(),
            }
        } else {
            endpoint
        }
    } else {
        match socket {
            Some(v) => v,
            None => default_socket(&workspace)?.to_string_lossy().into(),
        }
    };
    if server {
        eprintln!("AfterEdit workspace server: {endpoint}");
        serve(&workspace, Path::new(&endpoint))?;
        return Ok(0);
    }
    if !joining && !endpoint.starts_with("ssh://") {
        ensure_server(&workspace, Path::new(&endpoint))?;
    }
    if stdio {
        transport::stdio(Path::new(&endpoint))?;
        return Ok(0);
    }
    let client = Client { endpoint };
    let first = args.first().map(String::as_str).unwrap_or("edit");
    let param = |n: usize| {
        args.get(n)
            .map(String::as_str)
            .ok_or("Missing command argument".to_string())
    };
    let value=match first {
  "capabilities"=>client.call("capabilities",json!({}))?,"status"=>client.call("session.status",json!({}))?,"stop"=>client.call("session.stop",json!({"force":force}))?,
  "files"=>client.call("files",json!({"path":args.get(1).map(String::as_str).unwrap_or(".")}))?,"search"=>client.call("search",json!({"query":args[1..].join(" ")}))?,
  "buffer"=>{let operation=param(1)?;if operation=="list"{client.call("buffer.list",json!({}))?}else{let path=param(2)?;let operation=if operation=="set"{"edit"}else{operation};let mut p=json!({"path":path,"version":revision});if operation=="edit"{let value=match content{Some(v)=>v,None=>{if io::stdin().is_terminal(){return Err("Use --text TEXT or pipe UTF-8 text to buffer set".into());}let mut value=String::new();io::stdin().take((MAX_TEXT+1) as u64).read_to_string(&mut value).map_err(err)?;value}};p["text"]=json!(value);}client.call(&format!("buffer.{operation}"),p)?}},
  "run"=>{let name=param(1)?;let plan=client.call("task.plan",json!({"name":name}))?;if approve{client.call("task.run",json!({"name":name,"approval":plan["approval"],"confirmation":confirmation}))?}else{eprintln!("Review this plan. Add --approve to run it.");plan}},
  "runs"=>client.call("task.list",json!({}))?,"cancel"=>client.call("task.cancel",json!({"runId":param(1)?.parse::<u64>().map_err(err)?}))?,
  "language"=>client.call("language.start",json!({"name":param(1)?,"approve":approve}))?,"diagnostics"=>client.call("diagnostics",json!({}))?,"symbols"=>client.call("symbols",json!({"query":args[1..].join(" ")}))?,
  "git"=>client.call(&format!("git.{}",param(1)?),json!({"path":args.get(2),"approve":approve}))?,
  "debug"=>match param(1)?{"start"=>client.call("debug.start",json!({"name":param(2)?,"approve":approve}))?,"stop"=>client.call("debug.stop",json!({}))?,"threads"=>client.call("debug.request",json!({"command":"threads"}))?,"request"=>client.call("debug.request",json!({"command":param(2)?,"arguments":serde_json::from_str::<Value>(&args[3..].join(" ")).map_err(err)?}))?,_=>return Err("Use debug start, threads, request, or stop".into())},
  "rpc"=>client.call(param(1)?,serde_json::from_str(&args[2..].join(" ")).map_err(err)?)?,
  _=>{if first.starts_with('-'){return Err(format!("Unknown option {first}; use --help"));}let path=if first=="edit"{args.get(1).cloned()}else{Some(first.into())};if wait {let file=path.ok_or("edit --wait needs a file")?;let initial=client.call("buffer.open",json!({"path":file}))?;println!("Waiting for {} to be saved in a connected editor. Ctrl-C cancels waiting.",file);loop{std::thread::sleep(Duration::from_millis(500));let current=client.call("buffer.get",json!({"path":file}))?;if current["version"].as_u64()>initial["version"].as_u64()&&current["dirty"]==false{return Ok(0);}}}if visual {super::terminal::run(client,path)?;}else{plain(client,path)?;}return Ok(0);}
 };
    if json_output {
        println!("{}", serde_json::to_string(&value).map_err(err)?);
    } else {
        println!("{}", serde_json::to_string_pretty(&value).map_err(err)?);
    }
    Ok(0)
}
pub fn plain(client: Client, path: Option<String>) -> Result<(), String> {
    println!("AfterEdit plain editor. No modes. Type help for commands. Shared drafts remain on the server when you leave.");
    let mut buffer = path
        .map(|path| client.call("buffer.open", json!({"path":path})))
        .transpose()?;
    if let Some(b) = &buffer {
        describe(b);
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    loop {
        print!("afteredit> ");
        io::stdout().flush().map_err(err)?;
        let Some(line) = lines.next() else {
            break;
        };
        let line = line.map_err(err)?;
        let (command, rest) = line.split_once(' ').unwrap_or((&line, ""));
        let result = (|| -> Result<Option<Value>, String> {
            match command {
                "help" | "?" => {
                    println!("open PATH; new PATH; files; buffers; show [LINE]; status; append TEXT; replace LINE TEXT; insert LINE TEXT; delete LINE; find TEXT; save; undo; redo; refresh; diff; search TEXT; diagnostics; symbols QUERY; run TASK; rpc METHOD JSON; quit\nEditing commands are line based and use the displayed buffer revision. Another client's changes produce a conflict. Use refresh to inspect them. run prints a plan; rpc task.run requires its approval value. Nothing is silently overwritten.");
                    Ok(None)
                }
                "quit" | "exit" => Ok(Some(json!({"quit":true}))),
                "open" | "new" => {
                    buffer = Some(client.call(
                        if command == "new" {
                            "buffer.create"
                        } else {
                            "buffer.open"
                        },
                        json!({"path":rest}),
                    )?);
                    describe(buffer.as_ref().unwrap());
                    Ok(None)
                }
                "files" => Ok(Some(
                    client.call("files", json!({"path":if rest.is_empty(){"."}else{rest}}))?,
                )),
                "buffers" => Ok(Some(client.call("buffer.list", json!({}))?)),
                "search" => Ok(Some(client.call("search", json!({"query":rest}))?)),
                "diagnostics" => Ok(Some(client.call("diagnostics", json!({}))?)),
                "symbols" => Ok(Some(client.call("symbols", json!({"query":rest}))?)),
                "run" => Ok(Some(client.call("task.plan", json!({"name":rest}))?)),
                "rpc" => {
                    let (method, params) = rest.split_once(' ').unwrap_or((rest, "{}"));
                    Ok(Some(client.call(
                        method,
                        serde_json::from_str(params).map_err(err)?,
                    )?))
                }
                _ => {
                    let b = buffer.as_mut().ok_or("Open a file first: open PATH")?;
                    let path = b["path"].clone();
                    match command {
                        "show" => {
                            let text = b["text"].as_str().unwrap_or("");
                            if rest.is_empty() {
                                for (i, line) in text.lines().take(200).enumerate() {
                                    println!("{}: {}", i + 1, spoken(line));
                                }
                            } else {
                                let n = rest.parse::<usize>().map_err(err)?;
                                println!(
                                    "{}: {}",
                                    n,
                                    spoken(
                                        text.lines()
                                            .nth(n.saturating_sub(1))
                                            .ok_or("Line does not exist")?
                                    )
                                );
                            }
                            Ok(None)
                        }
                        "status" => {
                            describe(b);
                            Ok(None)
                        }
                        "refresh" => {
                            *b = client.call("buffer.get", json!({"path":path}))?;
                            describe(b);
                            Ok(None)
                        }
                        "find" => {
                            for (i, line) in b["text"].as_str().unwrap_or("").lines().enumerate() {
                                if line.contains(rest) {
                                    println!("{}: {}", i + 1, spoken(line));
                                }
                            }
                            Ok(None)
                        }
                        "save" | "undo" | "redo" => {
                            *b = client.call(
                                &format!("buffer.{command}"),
                                json!({"path":path,"version":b["version"]}),
                            )?;
                            describe(b);
                            Ok(None)
                        }
                        "diff" => Ok(Some(client.call("buffer.diff", json!({"path":path}))?)),
                        "append" | "replace" | "insert" | "delete" => {
                            let old = b["text"].as_str().unwrap_or("");
                            let value = edit_lines(old, command, rest)?;
                            *b = client.call(
                                "buffer.edit",
                                json!({"path":path,"version":b["version"],"text":value}),
                            )?;
                            describe(b);
                            Ok(None)
                        }
                        _ => Err("Unknown command. Type help for the command list.".into()),
                    }
                }
            }
        })();
        match result {
            Ok(Some(v)) if v["quit"] == true => break,
            Ok(Some(v)) => println!("{}", serde_json::to_string_pretty(&v).map_err(err)?),
            Ok(None) => {}
            Err(e) => println!("Error: {e}"),
        }
    }
    Ok(())
}
use std::io::BufRead;
pub fn edit_lines(old: &str, command: &str, rest: &str) -> Result<String, String> {
    let newline = if old.contains("\r\n") { "\r\n" } else { "\n" };
    if command == "append" {
        return Ok(format!(
            "{old}{}{rest}{newline}",
            if old.is_empty() || old.ends_with('\n') {
                ""
            } else {
                newline
            }
        ));
    }
    let (number, text) = rest.split_once(' ').unwrap_or((rest, ""));
    let line = number.parse::<usize>().map_err(err)?;
    let mut lines = old.lines().map(String::from).collect::<Vec<_>>();
    if line == 0 || line > lines.len() + usize::from(command == "insert") {
        return Err("Line is outside the buffer".into());
    }
    match command {
        "replace" => lines[line - 1] = text.into(),
        "insert" => lines.insert(line - 1, text.into()),
        "delete" => {
            lines.remove(line - 1);
        }
        _ => return Err("Unknown edit".into()),
    };
    Ok(if lines.is_empty() {
        String::new()
    } else {
        lines.join(newline) + if old.ends_with('\n') { newline } else { "" }
    })
}
fn describe(b: &Value) {
    println!(
        "{} · revision {} · {} · {} lines",
        spoken(b["path"].as_str().unwrap_or("")),
        b["version"],
        if b["dirty"] == true {
            "unsaved shared draft"
        } else {
            "saved"
        },
        b["text"].as_str().unwrap_or("").lines().count()
    );
}
pub fn spoken(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            if c == '\t' {
                "    ".chars().collect::<Vec<_>>()
            } else if c.is_control() {
                format!("\\u{{{:x}}}", c as u32).chars().collect()
            } else {
                vec![c]
            }
        })
        .collect()
}
