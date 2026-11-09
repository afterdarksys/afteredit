use super::*;
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::{
    fs::{MetadataExt, PermissionsExt},
    net::{UnixListener, UnixStream},
};
const MAX_FRAME: u64 = 8 * 1024 * 1024;
pub fn default_socket(root: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(err)?;
    let key = crate::history::fnv1a(root.to_string_lossy().as_bytes());
    #[cfg(unix)]
    let user = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let user = 0;
    let dir = std::env::temp_dir().join(format!("afteredit-{user}"));
    private_directory(&dir)?;
    Ok(dir.join(format!("{key:016x}.sock")))
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
const SSH_HOST_ERROR: &str =
    "Invalid SSH host; use an SSH config alias for ports and identity files";

/// Host alias plus absolute directory, as `ssh://alias/absolute/path`.
/// The host is an SSH config alias: no port, identity file, or proxy.
/// A trailing slash on the directory is removed. `/` alone is refused.
pub fn ssh_endpoint(host: &str, workspace: &str) -> Result<String, String> {
    let host = host.trim();
    let workspace = normalize_ssh_workspace(workspace)?;
    validate_ssh_host(host)?;
    Ok(format!("ssh://{host}{workspace}"))
}

/// Split an endpoint this crate built. A string that does not round-trip
/// through [`ssh_endpoint`] is refused, so option smuggling cannot survive.
pub fn parse_ssh_endpoint(endpoint: &str) -> Result<(String, String), String> {
    let target = endpoint
        .strip_prefix("ssh://")
        .ok_or("Expected ssh://host/absolute/workspace")?;
    let (host, path) = target
        .split_once('/')
        .ok_or("SSH endpoint needs an absolute workspace path")?;
    let workspace = format!("/{path}");
    let rebuilt = ssh_endpoint(host, &workspace)?;
    if rebuilt != endpoint {
        return Err("Invalid SSH endpoint".into());
    }
    let workspace = rebuilt
        .strip_prefix(&format!("ssh://{host}"))
        .ok_or("Invalid SSH endpoint")?
        .to_string();
    Ok((host.to_string(), workspace))
}

fn validate_ssh_host(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@.-_".contains(c))
    {
        return Err(SSH_HOST_ERROR.into());
    }
    Ok(())
}

fn normalize_ssh_workspace(workspace: &str) -> Result<String, String> {
    // Controls are rejected before trim. A leading newline must not become a path.
    if workspace.chars().any(|c| {
        c.is_control() || c == '\u{2028}' || c == '\u{2029}' || c == '\'' || c == '"' || c == '\\'
    }) {
        return Err("Remote project contains a character SSH will not pass through.".into());
    }
    let mut workspace = workspace.trim().to_string();
    if workspace.len() > 1 && workspace.ends_with('/') {
        workspace.pop();
    }
    if workspace.len() < 2 || workspace.len() > 4096 || !workspace.starts_with('/') {
        return Err("Remote project must be an absolute path.".into());
    }
    if workspace == "/" {
        return Err("Remote project must be an absolute path.".into());
    }
    for (index, part) in workspace.split('/').enumerate() {
        if index == 0 {
            if !part.is_empty() {
                return Err("Remote project must be an absolute path.".into());
            }
            continue;
        }
        if part.is_empty() || part == "." || part == ".." {
            return Err("Remote project must stay on one absolute path.".into());
        }
    }
    Ok(workspace)
}

/// One JSON request over `ssh` with a fixed option list.
/// BatchMode refuses passwords and unknown-host prompts. stderr is drained
/// so a full pipe cannot stall the reply, capped, and attached only to an
/// error. It is not written to a log.
pub fn ssh(endpoint: &str, method: &str, params: Value) -> Result<Value, String> {
    let (host, workspace) = parse_ssh_endpoint(endpoint)?;
    // Quotes are already refused. The escape stays so a later charset change
    // cannot break out of the remote command.
    let quoted = format!("'{}'", workspace.replace('\'', "'\\''"));
    let remote = format!("afteredit --stdio --workspace {quoted}");
    let mut command = std::process::Command::new("ssh");
    command
        .arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg("--")
        .arg(&host)
        .arg(&remote)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(err)?;
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || drain_capped(stderr, 4096));
    let exchanged = (|| -> Result<Value, String> {
        let mut input = child.stdin.take().ok_or("SSH stdin missing")?;
        write_value(&mut input, &json!({"method":method,"params":params}))?;
        drop(input);
        read_value(&mut BufReader::new(
            child.stdout.take().ok_or("SSH stdout missing")?,
        ))
    })();
    let status = child.wait().map_err(err)?;
    let stderr_text = match stderr_thread.join() {
        Ok(text) => text,
        Err(_) => String::new(),
    };
    let value = exchanged.map_err(|message| ssh_failure(&message, &stderr_text, &status))?;
    if value["ok"] == true {
        Ok(value["result"].clone())
    } else {
        let message = value["error"].as_str().unwrap_or("Remote service failed");
        Err(ssh_failure(message, &stderr_text, &status))
    }
}

fn ssh_failure(message: &str, stderr: &str, status: &std::process::ExitStatus) -> String {
    let stderr = stderr.trim();
    let mut text = message.to_string();
    if !status.success() {
        text.push_str(&format!(" (ssh exited {status})"));
    }
    if !stderr.is_empty() {
        text.push('\n');
        text.push_str(stderr);
    }
    text
}

fn drain_capped(pipe: Option<std::process::ChildStderr>, cap: usize) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut kept = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&kept).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_name_is_stable_for_the_same_workspace() {
        let root = std::env::temp_dir().join(format!("afteredit-socket-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = default_socket(&root).expect("socket path");
        let b = default_socket(&root).expect("socket path");
        assert_eq!(a, b);
        assert!(a.file_name().unwrap().to_string_lossy().ends_with(".sock"));
        assert_eq!(a.file_name().unwrap().to_string_lossy().len(), 16 + 5);
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        assert_ne!(default_socket(&other).unwrap(), a);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ssh_endpoint_accepts_an_alias_and_absolute_directory() {
        assert_eq!(
            ssh_endpoint("dev", "/srv/app").unwrap(),
            "ssh://dev/srv/app"
        );
        assert_eq!(
            ssh_endpoint("user@host", "/srv/app/").unwrap(),
            "ssh://user@host/srv/app"
        );
        let (host, workspace) = parse_ssh_endpoint("ssh://dev/srv/app").unwrap();
        assert_eq!(host, "dev");
        assert_eq!(workspace, "/srv/app");
        assert_eq!(
            ssh_endpoint(&"a".repeat(253), &format!("/{}", "b".repeat(4094))).unwrap(),
            format!("ssh://{}/{}", "a".repeat(253), "b".repeat(4094))
        );
    }

    #[test]
    fn ssh_endpoint_rejects_options_and_paths_that_leave_the_directory() {
        for host in ["", "-oProxyCommand=x", "host name", "host/path", "host;rm", "../x"] {
            assert!(ssh_endpoint(host, "/srv/app").is_err(), "{host}");
        }
        assert!(ssh_endpoint(&"a".repeat(254), "/srv/app").is_err());
        for path in [
            "",
            "relative",
            "/",
            "/tmp/../etc",
            "/tmp/./etc",
            "/tmp//etc",
            "\n/tmp",
            "/tmp/it's",
            "/tmp/a\nb",
            "/tmp/a\\b",
            "/tmp/a\"b",
        ] {
            assert!(ssh_endpoint("dev", path).is_err(), "{path:?}");
        }
        assert!(ssh_endpoint("dev", &format!("/{}", "c".repeat(4096))).is_err());
        assert!(parse_ssh_endpoint("ssh://-oProxyCommand=x/tmp").is_err());
        assert!(parse_ssh_endpoint("ssh://dev/tmp/../etc").is_err());
        assert!(parse_ssh_endpoint("ssh://dev").is_err());
        assert!(parse_ssh_endpoint("not-ssh://dev/srv/app").is_err());
        assert!(parse_ssh_endpoint("ssh://dev/srv/app\n").is_err());
    }
}
