//! One reviewed capture of a page on this machine. The model picks a localhost
//! URL. It does not click, type, or use the user's browser profile. Chrome
//! does not finish a screenshot under the task Seatbelt profile, so this
//! process is confined by the loopback address, a temporary profile, and a
//! kill after the image is written.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    io::Read,
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};

#[derive(Serialize)]
pub struct PageCapture {
    console: String,
    image: String,
}

pub fn local_page(url: &str) -> Result<(), String> {
    let rest = url.strip_prefix("http://").ok_or("Capture only http://127.0.0.1, http://localhost, or http://[::1].")?;
    if rest.len() > 2000 || rest.contains('@') || rest.contains('\\') || rest.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("That page URL is not allowed.".into());
    }
    let hostport = rest.split_once('/').map(|(host, _)| host).unwrap_or(rest);
    if hostport.is_empty() { return Err("That page URL is not allowed.".into()); }
    let host = if let Some(wrapped) = hostport.strip_prefix('[') {
        let (addr, tail) = wrapped.split_once(']').ok_or("That page URL is not allowed.")?;
        if addr != "::1" || !(tail.is_empty() || port(tail.strip_prefix(':').ok_or("That page URL is not allowed.")?)) {
            return Err("Capture only http://127.0.0.1, http://localhost, or http://[::1].".into());
        }
        addr
    } else {
        let (host, tail) = match hostport.split_once(':') {
            Some((host, tail)) => {
                if !port(tail) { return Err("That page URL is not allowed.".into()); }
                (host, true)
            }
            None => (hostport, false),
        };
        let _ = tail;
        if host != "127.0.0.1" && host != "localhost" {
            return Err("Capture only http://127.0.0.1, http://localhost, or http://[::1].".into());
        }
        host
    };
    let _ = host;
    Ok(())
}

fn port(text: &str) -> bool {
    let value: u32 = text.parse().unwrap_or(0);
    (1..=65535).contains(&value) && !text.starts_with('+') && text.chars().all(|c| c.is_ascii_digit())
}

fn browser() -> Result<PathBuf, String> {
    for candidate in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() { return Ok(path); }
    }
    for name in ["google-chrome", "chromium", "chrome", "msedge"] {
        if let Some(path) = crate::toolpath::resolve_binary(name) { return Ok(path); }
    }
    Err("Install Chrome, Chromium, or Edge to capture a local page.".into())
}

pub fn capture(url: &str) -> Result<PageCapture, String> {
    local_page(url)?;
    let program = browser()?;
    let dir = std::env::temp_dir().join(format!(
        "afteredit-page-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()
    ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _cleanup = Cleanup(dir.clone());
    let png = dir.join("page.png");
    let log = dir.join("browser.log");
    let profile = dir.join("profile");
    let crashes = dir.join("crashes");
    std::fs::create_dir_all(&crashes).map_err(|e| e.to_string())?;
    // Chrome cannot finish a screenshot under the task Seatbelt profile. The
    // confinement here is the loopback URL, a fresh temporary profile, and
    // killing the process after the image is written.
    let mut command = std::process::Command::new(&program);
    let user_data = format!("--user-data-dir={}", profile.display());
    let shot = format!("--screenshot={}", png.display());
    let crash_dir = format!("--crash-dumps-dir={}", crashes.display());
    let log_file = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    command
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-breakpad",
            "--disable-crash-reporter",
            "--disable-background-networking",
            &user_data,
            &shot,
            &crash_dir,
            "--window-size=800,600",
            "--virtual-time-budget=1500",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log_file);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("The browser did not start: {e}"))?;
    let started = Instant::now();
    let mut last = 0u64;
    let mut stable = 0;
    while started.elapsed() < Duration::from_secs(12) {
        if let Ok(meta) = png.metadata() {
            if meta.len() > 1000 && meta.len() == last {
                stable += 1;
                if stable >= 2 { break; }
            } else {
                stable = 0;
                last = meta.len();
            }
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
        std::thread::sleep(Duration::from_millis(200));
    }
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    let mut logged = String::new();
    if let Ok(file) = std::fs::File::open(&log) {
        let mut bytes = Vec::new();
        let _ = file.take(80_000).read_to_end(&mut bytes);
        logged = String::from_utf8_lossy(&bytes).chars().rev().take(4000).collect::<String>().chars().rev().collect();
    }
    if !crate::secrets::scan_text(&logged, "browser").is_empty() {
        return Err("Browser log withheld because it looks like a secret.".into());
    }
    let bytes = std::fs::read(&png).map_err(|_| format!("The browser did not produce a screenshot. {}", logged.chars().take(500).collect::<String>()))?;
    if bytes.len() < 100 || bytes.len() > 1_500_000 { return Err("The screenshot was empty or larger than 1.5 MB.".into()); }
    Ok(PageCapture { console: logged, image: STANDARD.encode(bytes) })
}

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[tauri::command]
pub async fn capture_page(url: String) -> Result<PageCapture, String> {
    tauri::async_runtime::spawn_blocking(move || capture(&url)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_http_pages_are_captured() {
        for url in ["http://127.0.0.1:3000/app", "http://localhost/", "http://[::1]:8080/x"] {
            assert!(local_page(url).is_ok(), "{url}");
        }
        for url in ["https://127.0.0.1/", "http://example.com/", "http://127.0.0.1.evil/", "http://user:pass@127.0.0.1/", "http://127.0.0.1:0/", "file:///etc/passwd", "http://localhost/a b"] {
            assert!(local_page(url).is_err(), "{url}");
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_local_page_returns_a_png() {
        if browser().is_err() { return; }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let body = b"<html><body>afteredit-page</body></html>";
                let header = format!("HTTP/1.0 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = std::io::Write::write_all(&mut stream, header.as_bytes());
                let _ = std::io::Write::write_all(&mut stream, body);
            }
        });
        let page = capture(&format!("http://127.0.0.1:{port}/")).expect("capture");
        assert!(page.image.len() > 100);
        assert!(STANDARD.decode(&page.image).unwrap().starts_with(b"\x89PNG"));
    }
}
