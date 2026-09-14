use super::*;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::{
    fs::{MetadataExt, PermissionsExt},
    net::{UnixListener, UnixStream},
};
const MAX_FRAME: u64 = 8 * 1024 * 1024;
pub fn default_socket(root: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(err)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hash);
    #[cfg(unix)]
    let user = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let user = 0;
    let dir = std::env::temp_dir().join(format!("afteredit-{user}"));
    private_directory(&dir)?;
    Ok(dir.join(format!("{:x}.sock", hash.finish())))
}
fn private_directory(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut b = fs::DirBuilder::new();
            b.mode(0o700);
            match b.create(dir) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(err(e)),
            }
        }
        #[cfg(not(unix))]
        fs::create_dir(dir).map_err(err)?;
    }
    let meta = fs::symlink_metadata(dir).map_err(err)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Socket directory must be a real private directory".into());
    }
    #[cfg(unix)]
    if meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
        return Err("Socket directory must be owned by you with mode 0700".into());
    }
    Ok(())
}
fn read_value(input: &mut impl BufRead) -> Result<Value, String> {
    let mut text = String::new();
    let n = input
        .take(MAX_FRAME + 1)
        .read_line(&mut text)
        .map_err(err)?;
    if n == 0 {
        return Err("Connection closed".into());
    }
    if n as u64 > MAX_FRAME || !text.ends_with('\n') {
        return Err("Protocol frame exceeds 8 MiB or is incomplete".into());
    }
    serde_json::from_str(&text).map_err(err)
}
fn write_value(output: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    if bytes.len() as u64 > MAX_FRAME {
        return Err("Response exceeds 8 MiB".into());
    }
    output.write_all(&bytes).map_err(err)?;
    output.write_all(b"\n").map_err(err)?;
    output.flush().map_err(err)
}
#[cfg(unix)]
pub fn serve(root: &Path, socket: &Path) -> Result<(), String> {
    private_directory(socket.parent().ok_or("Socket has no parent")?)?;
    if socket.exists() {
        if UnixStream::connect(socket).is_ok() {
            return Err("A server already owns this socket".into());
        }
        let meta = fs::symlink_metadata(socket).map_err(err)?;
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
            return Err("Refusing to replace an unrelated socket path".into());
        }
        fs::remove_file(socket).map_err(err)?;
    }
    let listener = UnixListener::bind(socket).map_err(err)?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600)).map_err(err)?;
    listener.set_nonblocking(true).map_err(err)?;
    let service = Service::new(root, socket.with_extension("recovery.json"))?;
    let clients = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    while !service.stopping.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).map_err(err)?;
                if clients.fetch_add(1, Ordering::SeqCst) >= 32 {
                    clients.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let service = service.clone();
                let clients = clients.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    let result = read_value(&mut BufReader::new(&mut stream)).and_then(|value| {
                        service.request(
                            text(&value, "method")?,
                            value.get("params").cloned().unwrap_or(json!({})),
                        )
                    });
                    let response = match result {
                        Ok(value) => json!({"ok":true,"result":value}),
                        Err(e) => json!({"ok":false,"error":e}),
                    };
                    let _ = write_value(&mut stream, &response);
                    clients.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(e) => return Err(err(e)),
        }
    }
    service.tasks.shutdown();
    service.lsp.shutdown();
    service.dap.shutdown();
    let _ = fs::remove_file(socket);
    Ok(())
}
#[cfg(not(unix))]
pub fn serve(_root: &Path, _socket: &Path) -> Result<(), String> {
    Err("Local socket prototype currently supports macOS and Linux".into())
}
#[cfg(unix)]
pub fn rpc(socket: &Path, method: &str, params: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(err)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(65)))
        .map_err(err)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(err)?;
    write_value(&mut stream, &json!({"method":method,"params":params}))?;
    let reply = read_value(&mut BufReader::new(stream))?;
    if reply["ok"] == true {
        Ok(reply["result"].clone())
    } else {
        Err(reply["error"]
            .as_str()
            .unwrap_or("Service request failed")
            .into())
    }
}
#[cfg(not(unix))]
pub fn rpc(_socket: &Path, _method: &str, _params: Value) -> Result<Value, String> {
    Err("Local socket prototype currently supports macOS and Linux".into())
}
pub fn ensure_server(root: &Path, socket: &Path) -> Result<(), String> {
    if let Ok(caps) = rpc(socket, "capabilities", json!({})) {
        if caps["root"] != root.canonicalize().map_err(err)?.to_string_lossy().as_ref() {
            return Err(
                "Socket belongs to another workspace; use --connect to join it explicitly".into(),
            );
        }
        return Ok(());
    }
    private_directory(socket.parent().ok_or("Socket directory required")?)?;
    let executable = std::env::current_exe().map_err(err)?;
    let mut log_options = fs::OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let log = log_options
        .open(socket.with_extension("log"))
        .map_err(err)?;
    let mut command = std::process::Command::new(executable);
    command
        .args(["--server", "--workspace"])
        .arg(root)
        .arg("--socket")
        .arg(socket)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(err)?;
    for _ in 0..100 {
        if rpc(socket, "capabilities", json!({})).is_ok() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(err)? {
            return Err(format!(
                "Workspace server exited {status}; inspect {}",
                socket.with_extension("log").display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("Workspace server did not become ready".into())
}
pub fn stdio(socket: &Path) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    loop {
        if input.fill_buf().map_err(err)?.is_empty() {
            return Ok(());
        }
        let response = read_value(&mut input).and_then(|v| {
            rpc(
                socket,
                text(&v, "method")?,
                v.get("params").cloned().unwrap_or(json!({})),
            )
        });
        write_value(
            &mut output,
            &match response {
                Ok(v) => json!({"ok":true,"result":v}),
                Err(e) => json!({"ok":false,"error":e}),
            },
        )?;
    }
}
pub fn ssh(endpoint: &str, method: &str, params: Value) -> Result<Value, String> {
    let target = endpoint
        .strip_prefix("ssh://")
        .ok_or("Expected ssh://host/absolute/workspace")?;
    let (host, path) = target
        .split_once('/')
        .ok_or("SSH endpoint needs an absolute workspace path")?;
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@.-_".contains(c))
    {
        return Err(
            "Invalid SSH host; use an SSH config alias for ports and identity files".into(),
        );
    }
    let workspace = format!("/{path}");
    let quoted = format!("'{}'", workspace.replace('\'', "'\\''"));
    let mut child = std::process::Command::new("ssh")
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "--",
            host,
            &format!("afteredit --stdio --workspace {quoted}"),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(err)?;
    let mut input = child.stdin.take().ok_or("SSH stdin missing")?;
    write_value(&mut input, &json!({"method":method,"params":params}))?;
    drop(input);
    let result = read_value(&mut BufReader::new(
        child.stdout.take().ok_or("SSH stdout missing")?,
    ));
    let _ = child.wait();
    let value = result?;
    if value["ok"] == true {
        Ok(value["result"].clone())
    } else {
        Err(value["error"]
            .as_str()
            .unwrap_or("Remote service failed")
            .into())
    }
}
