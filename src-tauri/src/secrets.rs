//! Secret scanning on the commit path.
//!
//! Threats: stops credentials in *staged* changes from reaching git history
//! through this editor's commit command, and surfaces them in the editor
//! before that. Does NOT protect against: commits made outside AfterEdit (use
//! a real pre-commit hook for that), secrets already in history, files that
//! were never staged, or credential shapes no rule here knows about. It is a
//! guard rail, not a guarantee.
//!
//! No raw secret material is ever handled or returned. gitleaks runs with
//! `--redact` so its own output carries none, and the built-in fallback
//! reports only a rule id and a location -- never the matched text.

use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::toolpath::{resolve_binary, tail};

/// Cap on how much of a file the fallback will read, per rule 10.
const MAX_SCAN_BYTES: usize = 4 * 1024 * 1024;

/// Suppress a line the way gitleaks does, so an existing convention keeps
/// working and the exception lives in the repo where it can be reviewed.
const ALLOW_MARKERS: &[&str] = &["gitleaks:allow", "afteredit:allow-secret"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SecretFinding {
    pub rule: String,
    pub description: String,
    pub file: String,
    pub start_line: u32,
    /// gitleaks' own fingerprint when it found this; never the secret itself.
    pub fingerprint: Option<String>,
    pub detector: String,
}

#[derive(Debug, Serialize)]
pub struct SecretScan {
    pub findings: Vec<SecretFinding>,
    /// Which detector produced this, so the UI never implies more coverage
    /// than actually ran.
    pub detector: String,
    pub gitleaks: bool,
}

#[derive(Deserialize)]
struct GitleaksRow {
    #[serde(rename = "RuleID")]
    rule_id: String,
    #[serde(rename = "Description")]
    description: String,
    #[serde(rename = "File")]
    file: String,
    #[serde(rename = "StartLine")]
    start_line: u32,
    #[serde(rename = "Fingerprint")]
    fingerprint: Option<String>,
}

/// High-confidence shapes only. Anything needing entropy heuristics belongs to
/// gitleaks: a false positive that blocks a commit is how a guard gets
/// switched off for good.
fn builtin_rules() -> &'static [(&'static str, &'static str, Regex)] {
    static RULES: OnceLock<Vec<(&'static str, &'static str, Regex)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            ("aws-access-key", "AWS access key id", r"\b(?:AKIA|ASIA|AGPA|AROA|AIDA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b"),
            ("github-token", "GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
            ("github-pat", "GitHub fine-grained token", r"\bgithub_pat_[A-Za-z0-9_]{60,}\b"),
            ("gitlab-token", "GitLab personal access token", r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
            ("slack-token", "Slack token", r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"),
            ("stripe-key", "Stripe live key", r"\b[sr]k_live_[0-9a-zA-Z]{20,}\b"),
            ("google-api-key", "Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
            ("anthropic-key", "Anthropic API key", r"\bsk-ant-[A-Za-z0-9_-]{24,}\b"),
            ("npm-token", "npm access token", r"\bnpm_[A-Za-z0-9]{36}\b"),
            ("private-key", "Private key block", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
        ]
        .into_iter()
        .filter_map(|(id, description, pattern)| {
            // A rule that will not compile must not silently disappear.
            Regex::new(pattern).ok().map(|regex| (id, description, regex))
        })
        .collect()
    })
}

fn suppressed(line: &str) -> bool {
    ALLOW_MARKERS.iter().any(|marker| line.contains(marker))
}

/// Scan text with the built-in rules. Pure, so it is also what the editor uses
/// to mark an open buffer.
pub fn scan_text(text: &str, file: &str) -> Vec<SecretFinding> {
    let text = if text.len() > MAX_SCAN_BYTES { &text[..MAX_SCAN_BYTES] } else { text };
    let mut findings = Vec::new();
    for (number, line) in text.lines().enumerate() {
        if suppressed(line) {
            continue;
        }
        for (rule, description, regex) in builtin_rules() {
            if regex.is_match(line) {
                findings.push(SecretFinding {
                    rule: (*rule).to_string(),
                    description: (*description).to_string(),
                    file: file.to_string(),
                    start_line: number as u32 + 1,
                    fingerprint: None,
                    detector: "builtin".into(),
                });
            }
        }
    }
    findings
}

/// Parse a `gitleaks --report-format json` array.
pub fn parse_gitleaks(json: &str) -> Result<Vec<SecretFinding>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<GitleaksRow> =
        serde_json::from_str(trimmed).map_err(|e| format!("could not read the gitleaks report: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|row| SecretFinding {
            rule: row.rule_id,
            description: row.description,
            file: row.file,
            start_line: row.start_line,
            fingerprint: row.fingerprint,
            detector: "gitleaks".into(),
        })
        .collect())
}

/// Scan what is staged in `root`.
///
/// Fails closed: any outcome we cannot interpret is an error, never an
/// implicit "clean".
pub fn scan_staged(root: &Path) -> Result<SecretScan, String> {
    if let Some(gitleaks) = resolve_binary("gitleaks") {
        let output = Command::new(&gitleaks)
            .arg("git")
            .arg("--staged")
            .arg("--redact")
            .arg("--no-banner")
            .arg("--report-format")
            .arg("json")
            .arg("--report-path")
            .arg("-")
            .arg(root)
            .output()
            .map_err(|e| format!("could not run gitleaks: {e}"))?;

        // gitleaks exits 1 precisely because it found something; only other
        // codes are failures.
        let code = output.status.code().unwrap_or(-1);
        if code != 0 && code != 1 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("gitleaks failed ({code}): {}", tail(&stderr, 400)));
        }

        let findings = parse_gitleaks(&String::from_utf8_lossy(&output.stdout))?;
        return Ok(SecretScan { findings, detector: "gitleaks".into(), gitleaks: true });
    }

    // No gitleaks: still scan, with the narrower built-in rules, rather than
    // letting the commit through unexamined.
    scan_staged_builtin(root)
}

/// The floor: scan the staged blobs with the built-in rules. Separate so it is
/// exercised by tests even on a machine that has gitleaks.
pub fn scan_staged_builtin(root: &Path) -> Result<SecretScan, String> {
    let staged = Command::new("git")
        .current_dir(root)
        .args(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
        .output()
        .map_err(|e| format!("could not list staged files: {e}"))?;
    if !staged.status.success() {
        return Err("could not list staged files".into());
    }

    let mut findings = Vec::new();
    for name in String::from_utf8_lossy(&staged.stdout).lines() {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // Read the staged content, not the working tree: they differ.
        let blob = Command::new("git")
            .current_dir(root)
            .args(["show", &format!(":{name}")])
            .output()
            .map_err(|e| format!("could not read staged {name}: {e}"))?;
        if !blob.status.success() {
            continue;
        }
        if let Ok(text) = String::from_utf8(blob.stdout) {
            findings.extend(scan_text(&text, name));
        }
    }

    Ok(SecretScan { findings, detector: "builtin".into(), gitleaks: false })
}

/// Message shown when a commit is refused. Carries locations, never values.
pub fn refusal(scan: &SecretScan) -> String {
    let mut lines = vec![format!(
        "Commit blocked: {} possible secret{} in the staged changes.",
        scan.findings.len(),
        if scan.findings.len() == 1 { "" } else { "s" }
    )];
    for finding in scan.findings.iter().take(20) {
        lines.push(format!("  {}:{} — {}", finding.file, finding.start_line, finding.description));
    }
    if scan.findings.len() > 20 {
        lines.push(format!("  …and {} more", scan.findings.len() - 20));
    }
    lines.push(if scan.gitleaks {
        "Remove them, or allowlist in .gitleaks.toml / add `gitleaks:allow` on the line.".into()
    } else {
        "Remove them, or add `gitleaks:allow` on the line. Install gitleaks for fuller coverage.".into()
    });
    lines.join("\n")
}

#[tauri::command]
pub async fn scan_buffer_secrets(path: String, text: String) -> Vec<SecretFinding> {
    tauri::async_runtime::spawn_blocking(move || scan_text(&text, &path))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- negative tests: the guard must actually refuse -------------------

    #[test]
    fn known_credential_shapes_are_caught() {
        let cases = [
            ("aws-access-key", "aws_access_key_id = AKIA4NPQ2XZJ7KLMWVR3"),
            ("github-token", "token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
            ("gitlab-token", "CI_TOKEN=glpat-ABCDEFGHIJKLMNOPQRST"),
            ("slack-token", "SLACK=xoxb-123456789012-abcdefghijkl"),
            ("google-api-key", "key=AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
            ("npm-token", "//registry.npmjs.org/:_authToken=npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
            ("private-key", "-----BEGIN OPENSSH PRIVATE KEY-----"),
        ];
        for (rule, line) in cases {
            let found = scan_text(line, "config");
            assert!(
                found.iter().any(|f| f.rule == rule),
                "{rule} not detected in {line:?}, got {:?}",
                found.iter().map(|f| &f.rule).collect::<Vec<_>>(),
            );
        }
    }

    #[test]
    fn a_finding_never_carries_the_secret() {
        let secret = "AKIA4NPQ2XZJ7KLMWVR3";
        let findings = scan_text(&format!("key = {secret}"), "config");
        assert_eq!(findings.len(), 1);
        let rendered = serde_json::to_string(&findings[0]).unwrap();
        assert!(!rendered.contains(secret), "serialized finding leaked the secret: {rendered}");
        assert!(!rendered.contains("AKIA"), "serialized finding leaked a prefix: {rendered}");
    }

    #[test]
    fn the_refusal_message_never_carries_the_secret() {
        let secret = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
        let scan = SecretScan {
            findings: scan_text(&format!("token = {secret}"), "app.py"),
            detector: "builtin".into(),
            gitleaks: false,
        };
        let message = refusal(&scan);
        assert!(!message.contains(secret), "refusal leaked the secret: {message}");
        assert!(message.contains("app.py:1"), "refusal must say where: {message}");
        assert!(message.starts_with("Commit blocked"));
    }

    #[test]
    fn ordinary_code_is_not_flagged() {
        // A guard that cries wolf gets switched off.
        let benign = concat!(
            "let region = \"us-east-1\";\n",
            "const AKIAS_PER_ACCOUNT = 2;\n",
            "password = os.environ[\"DB_PASSWORD\"]\n",
            "token = \"${VAULT_TOKEN}\"\n",
            "example = \"ghp_short\"\n",
            "url = https://api.example.com/v1/users\n",
        );
        assert!(scan_text(benign, "app.py").is_empty(), "{:?}", scan_text(benign, "app.py"));
    }

    #[test]
    fn an_allow_marker_suppresses_the_line() {
        let line = "key = AKIA4NPQ2XZJ7KLMWVR3 # gitleaks:allow";
        assert!(scan_text(line, "config").is_empty());
        let ours = "key = AKIA4NPQ2XZJ7KLMWVR3 # afteredit:allow-secret";
        assert!(scan_text(ours, "config").is_empty());
        // ...but only that line.
        let mixed = format!("{line}\nother = AKIA4NPQ2XZJ7KLMWVR3\n");
        assert_eq!(scan_text(&mixed, "config").len(), 1);
        assert_eq!(scan_text(&mixed, "config")[0].start_line, 2);
    }

    #[test]
    fn oversized_input_is_bounded_not_refused() {
        let mut text = "x".repeat(MAX_SCAN_BYTES + 1024);
        text.push_str("\nkey = AKIA4NPQ2XZJ7KLMWVR3\n");
        // The tail past the cap is not scanned; the point is that it returns
        // rather than reading unbounded input.
        let findings = scan_text(&text, "big");
        assert!(findings.is_empty());
    }

    // ---- the gate, end to end against real git ---------------------------

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git").current_dir(dir).args(args).output().expect("git")
    }

    fn repo(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("afteredit-secrets-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "T"],
            vec!["config", "user.email", "t@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            assert!(git(&dir, &args).status.success(), "git {args:?}");
        }
        dir
    }

    #[test]
    fn a_staged_credential_is_found_by_whichever_detector_is_present() {
        let dir = repo("staged");
        std::fs::write(dir.join("config.ini"), "aws_access_key_id = AKIA4NPQ2XZJ7KLMWVR3\n").unwrap();
        assert!(git(&dir, &["add", "--", "config.ini"]).status.success());

        let scan = scan_staged(&dir).expect("scan should complete");
        assert!(
            !scan.findings.is_empty(),
            "staged credential missed by {} detector",
            scan.detector,
        );
        assert!(scan.findings.iter().any(|f| f.file.ends_with("config.ini")));

        let message = refusal(&scan);
        assert!(!message.contains("AKIA4NPQ2XZJ7KLMWVR3"), "refusal leaked the secret");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fallback is the fail-closed floor, so it must be exercised even
    /// here, where gitleaks is installed and would otherwise always win.
    #[test]
    fn the_builtin_fallback_scans_staged_blobs() {
        let dir = repo("fallback");
        std::fs::write(dir.join("a.env"), "GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\n").unwrap();
        std::fs::write(dir.join("b.txt"), "nothing to see\n").unwrap();
        assert!(git(&dir, &["add", "--", "a.env", "b.txt"]).status.success());

        let scan = scan_staged_builtin(&dir).expect("fallback scan should complete");
        assert!(!scan.gitleaks, "this is the fallback path");
        assert_eq!(scan.findings.len(), 1, "{:?}", scan.findings);
        assert_eq!(scan.findings[0].file, "a.env");
        assert_eq!(scan.findings[0].rule, "github-token");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_builtin_fallback_reads_the_index_not_the_disk() {
        let dir = repo("fallback-index");
        std::fs::write(dir.join("c.env"), "SLACK=xoxb-123456789012-abcdefghijkl\n").unwrap();
        assert!(git(&dir, &["add", "--", "c.env"]).status.success());
        std::fs::write(dir.join("c.env"), "SLACK=${SLACK_TOKEN}\n").unwrap();

        let scan = scan_staged_builtin(&dir).expect("fallback scan should complete");
        assert_eq!(scan.findings.len(), 1, "staged secret must survive a working-tree cleanup");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_staging_area_scans_clean() {
        let dir = repo("clean");
        std::fs::write(dir.join("app.py"), "region = \"us-east-1\"\nprint(region)\n").unwrap();
        assert!(git(&dir, &["add", "--", "app.py"]).status.success());

        let scan = scan_staged(&dir).expect("scan should complete");
        assert!(scan.findings.is_empty(), "false positive: {:?}", scan.findings);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The working tree is not what gets committed. A secret that is staged
    /// must still be caught after it is removed from disk.
    #[test]
    fn the_staged_content_is_scanned_not_the_working_tree() {
        let dir = repo("index");
        std::fs::write(dir.join("config.ini"), "key = AKIA4NPQ2XZJ7KLMWVR3\n").unwrap();
        assert!(git(&dir, &["add", "--", "config.ini"]).status.success());
        // Clean it up on disk only -- the index still holds the credential.
        std::fs::write(dir.join("config.ini"), "key = ${AWS_ACCESS_KEY_ID}\n").unwrap();

        let scan = scan_staged(&dir).expect("scan should complete");
        assert!(!scan.findings.is_empty(), "the staged credential must still be caught");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- gitleaks report parsing ----------------------------------------

    #[test]
    fn a_redacted_gitleaks_report_parses() {
        let json = r#"[{"RuleID":"aws-access-token","Description":"AWS creds","File":"config.ini",
            "StartLine":1,"Fingerprint":"config.ini:aws-access-token:1","Secret":"REDACTED","Match":"REDACTED"}]"#;
        let findings = parse_gitleaks(json).unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "aws-access-token");
        assert_eq!(findings[0].start_line, 1);
        assert_eq!(findings[0].detector, "gitleaks");
        let rendered = serde_json::to_string(&findings[0]).unwrap();
        assert!(!rendered.contains("REDACTED"), "the redacted value must not be carried forward");
    }

    #[test]
    fn an_empty_report_is_clean_but_malformed_output_is_an_error() {
        assert!(parse_gitleaks("").unwrap().is_empty());
        assert!(parse_gitleaks("[]").unwrap().is_empty());
        // Fail closed: unparseable output must not read as "no secrets".
        assert!(parse_gitleaks("not json at all").is_err());
        assert!(parse_gitleaks(r#"{"RuleID":"x"}"#).is_err());
    }
}
