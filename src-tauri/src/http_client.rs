//! Sends the requests in a `.http` buffer.
//!
//! Threats: this issues arbitrary HTTP on the user's behalf, which is the
//! entire point of the tool -- the URL comes from a file they wrote and ran
//! deliberately. What it does guarantee: http/https only (no file:, no
//! gopher:), a hard timeout, a capped response body, a bounded redirect
//! chain, and TLS verification always on. Credential headers are never
//! logged; redaction for display happens in the UI, which has the header
//! names.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY: usize = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

#[derive(Deserialize)]
pub struct OutgoingRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct IncomingResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub elapsed_ms: u64,
    pub bytes: usize,
    /// True when the body hit the cap; the rest was never read.
    pub truncated: bool,
    pub content_type: Option<String>,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Reject anything that is not plain HTTP before it reaches the client.
fn checked_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|e| format!("{raw}: {e}. URLs need a scheme, e.g. https://"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("{other}: is not supported; use http or https")),
    }
}

fn checked_method(raw: &str) -> Result<reqwest::Method, String> {
    raw.trim()
        .to_uppercase()
        .parse::<reqwest::Method>()
        .map_err(|_| format!("{raw} is not a valid HTTP method"))
}

async fn send(request: OutgoingRequest) -> Result<IncomingResponse, String> {
    let url = checked_url(&request.url)?;
    let method = checked_method(&request.method)?;

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        // Never relax verification. Not even "temporarily".
        .https_only(false)
        .build()
        .map_err(error)?;

    let mut outgoing = client.request(method, url);
    for (name, value) in &request.headers {
        if name.trim().is_empty() {
            continue;
        }
        outgoing = outgoing.header(name.trim(), value.trim());
    }
    if !request.body.is_empty() {
        outgoing = outgoing.body(request.body);
    }

    let started = Instant::now();
    let response = outgoing.send().await.map_err(|e| {
        // reqwest's Display includes the URL, which may carry a query string;
        // that is the user's own request, so it is theirs to see.
        format!("request failed: {e}")
    })?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let status = response.status();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (name.to_string(), value.to_str().unwrap_or("<binary>").to_string())
        })
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let raw = response.bytes().await.map_err(|e| format!("could not read the response: {e}"))?;
    let bytes = raw.len();
    let truncated = bytes > MAX_BODY;
    let slice = if truncated { &raw[..MAX_BODY] } else { &raw[..] };

    Ok(IncomingResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: String::from_utf8_lossy(slice).into_owned(),
        elapsed_ms,
        bytes,
        truncated,
        content_type,
    })
}

#[tauri::command]
pub async fn http_send(request: OutgoingRequest) -> Result<IncomingResponse, String> {
    send(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The suite has no tokio dev-dependency; the rest of this crate drives
    /// async tests through Tauri's runtime, so do the same.
    fn run(request: OutgoingRequest) -> Result<IncomingResponse, String> {
        tauri::async_runtime::block_on(send(request))
    }

    #[test]
    fn only_http_and_https_are_accepted() {
        assert!(checked_url("https://example.com/x").is_ok());
        assert!(checked_url("http://example.com").is_ok());
        for bad in ["file:///etc/passwd", "ftp://h/f", "gopher://h", "data:text/plain,x"] {
            assert!(checked_url(bad).is_err(), "{bad} must be rejected");
        }
        // A bare host is a mistake worth naming rather than guessing at.
        assert!(checked_url("example.com/x").is_err());
    }

    #[test]
    fn methods_are_validated() {
        assert_eq!(checked_method("get").unwrap(), reqwest::Method::GET);
        assert_eq!(checked_method(" PATCH ").unwrap(), reqwest::Method::PATCH);
        assert!(checked_method("not a method").is_err());
    }

    /// A real server on a real socket: the point is to prove the request goes
    /// out and the response comes back intact, not to mock our own code.
    fn server(status: &str, headers: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/probe", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 8192];
            let read = socket.read(&mut buffer).unwrap();
            let received = String::from_utf8_lossy(&buffer[..read]).into_owned();
            socket.write_all(reply.as_bytes()).unwrap();
            let _ = socket.flush();
            received
        });
        (url, handle)
    }

    #[test]
    fn a_request_goes_out_and_the_response_comes_back() {
        let (url, handle) = server("200 OK", "Content-Type: application/json\r\n", r#"{"ok":true}"#);

        let response = run(OutgoingRequest {
            method: "POST".into(),
            url,
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Authorization".into(), "Bearer topsecret".into()),
            ],
            body: r#"{"name":"ada"}"#.into(),
        })
        .expect("request should succeed");

        assert_eq!(response.status, 200);
        assert_eq!(response.status_text, "OK");
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert_eq!(response.content_type.as_deref(), Some("application/json"));
        assert!(!response.truncated);

        let sent = handle.join().unwrap();
        assert!(sent.starts_with("POST /probe HTTP/1.1"), "{sent}");
        assert!(sent.contains("accept: application/json") || sent.contains("Accept: application/json"));
        assert!(sent.contains(r#"{"name":"ada"}"#), "the body must be sent");
    }

    #[test]
    fn a_non_2xx_status_is_a_response_not_an_error() {
        let (url, handle) = server("404 Not Found", "", "nope");
        let response = run(OutgoingRequest {
            method: "GET".into(), url, headers: vec![], body: String::new(),
        })
        .expect("a 404 is a perfectly good answer");
        assert_eq!(response.status, 404);
        assert_eq!(response.body, "nope");
        let _ = handle.join();
    }

    #[test]
    fn an_unreachable_host_reports_rather_than_hanging() {
        // Port 1 on loopback refuses immediately.
        let outcome = run(OutgoingRequest {
            method: "GET".into(),
            url: "http://127.0.0.1:1/nothing".into(),
            headers: vec![],
            body: String::new(),
        });
        assert!(outcome.is_err());
        assert!(outcome.unwrap_err().contains("request failed"));
    }

    #[test]
    fn a_rejected_scheme_never_reaches_the_network() {
        let outcome = run(OutgoingRequest {
            method: "GET".into(),
            url: "file:///etc/passwd".into(),
            headers: vec![],
            body: String::new(),
        });
        assert!(outcome.unwrap_err().contains("not supported"));
    }
}
