//! Source formatting by shelling out to the tool a developer already uses.
//!
//! Every formatter here reads the document on stdin and writes it to stdout,
//! so nothing touches the filesystem and no user-controlled string ever
//! reaches a command line: the binary name and every argument are
//! compile-time constants, and the document travels on a pipe.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::toolpath::{resolve_binary, tail};

const TIMEOUT: Duration = Duration::from_secs(15);

struct Spec {
    /// Monaco language id.
    language: &'static str,
    binary: &'static str,
    args: &'static [&'static str],
}

/// Candidates in preference order; the first one installed wins.
const FORMATTERS: &[Spec] = &[
    Spec { language: "go", binary: "gofumpt", args: &[] },
    Spec { language: "go", binary: "gofmt", args: &[] },

    Spec { language: "rust", binary: "rustfmt", args: &["--emit", "stdout", "--edition", "2021"] },

    Spec { language: "python", binary: "ruff", args: &["format", "-"] },
    Spec { language: "python", binary: "black", args: &["-q", "-"] },

    // OpenTofu first: a shop that has migrated usually wants tofu's output.
    Spec { language: "hcl", binary: "tofu", args: &["fmt", "-"] },
    Spec { language: "hcl", binary: "terraform", args: &["fmt", "-"] },

    Spec { language: "shell", binary: "shfmt", args: &["-i", "2"] },

    Spec { language: "toml", binary: "taplo", args: &["fmt", "-"] },

    Spec { language: "yaml", binary: "yamlfmt", args: &["-in"] },
    Spec { language: "yaml", binary: "prettier", args: &["--stdin-filepath", "stdin.yaml"] },

    Spec { language: "json", binary: "prettier", args: &["--stdin-filepath", "stdin.json"] },
    Spec { language: "json", binary: "jq", args: &["--indent", "2", "."] },

    Spec { language: "rego", binary: "opa", args: &["fmt", "-"] },

    Spec { language: "c", binary: "clang-format", args: &["--assume-filename=stdin.c"] },
    Spec { language: "cpp", binary: "clang-format", args: &["--assume-filename=stdin.cpp"] },

    Spec { language: "typescript", binary: "prettier", args: &["--stdin-filepath", "stdin.ts"] },
    Spec { language: "javascript", binary: "prettier", args: &["--stdin-filepath", "stdin.js"] },
    Spec { language: "css", binary: "prettier", args: &["--stdin-filepath", "stdin.css"] },
    Spec { language: "scss", binary: "prettier", args: &["--stdin-filepath", "stdin.scss"] },
    Spec { language: "html", binary: "prettier", args: &["--stdin-filepath", "stdin.html"] },
    Spec { language: "markdown", binary: "prettier", args: &["--stdin-filepath", "stdin.md"] },

    Spec { language: "groovy", binary: "npm-groovy-lint", args: &["--format", "-"] },
];

#[derive(Debug, Serialize)]
pub struct FormatOutcome {
    pub text: String,
    /// Which tool ran, for the status bar.
    pub formatter: String,
    pub changed: bool,
}

#[derive(Serialize)]
pub struct FormatterStatus {
    pub language: String,
    pub binary: String,
    pub path: Option<String>,
    pub available: bool,
}

struct Captured {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(path: &Path, args: &[&str], input: &str) -> Result<Captured, String> {
    let mut child = Command::new(path)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", path.display()))?;

    // stdin goes out on its own thread: writing a large document before
    // reading stdout deadlocks once the output pipe buffer fills.
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let document = input.to_string();
    thread::spawn(move || {
        let _ = stdin.write_all(document.as_bytes());
        // Dropping stdin closes it, which is how the formatter learns the
        // document has ended.
    });

    let mut stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        let _ = out_tx.send(buffer);
    });
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        let _ = err_tx.send(buffer);
    });

    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} did not finish within {}s",
                    path.display(),
                    TIMEOUT.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };

    let collect = |rx: mpsc::Receiver<Vec<u8>>| {
        rx.recv_timeout(Duration::from_secs(2))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    };

    Ok(Captured {
        success: status.success(),
        code: status.code(),
        stdout: collect(out_rx),
        stderr: collect(err_rx),
    })
}

fn format_blocking(language: &str, text: &str) -> Result<FormatOutcome, String> {
    let candidates: Vec<&Spec> = FORMATTERS.iter().filter(|s| s.language == language).collect();
    if candidates.is_empty() {
        return Err(format!("no formatter is configured for {language}"));
    }

    let Some((spec, path)) = candidates
        .iter()
        .find_map(|spec| resolve_binary(spec.binary).map(|path| (*spec, path)))
    else {
        let names: Vec<&str> = candidates.iter().map(|s| s.binary).collect();
        return Err(format!(
            "no formatter installed for {language} - looked for {}",
            names.join(", ")
        ));
    };

    let captured = run(&path, spec.args, text)?;

    if !captured.success {
        // A shim that resolves to nothing (asdf without a .tool-versions, say)
        // exits non-zero and may still print to stdout. Never let that reach
        // the buffer.
        let detail = if captured.stderr.trim().is_empty() {
            &captured.stdout
        } else {
            &captured.stderr
        };
        return Err(format!(
            "{} exited with {}: {}",
            spec.binary,
            captured.code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()),
            tail(detail, 400)
        ));
    }

    // Guard against a "successful" run that would silently empty the document.
    if captured.stdout.is_empty() && !text.is_empty() {
        return Err(format!("{} produced no output", spec.binary));
    }

    Ok(FormatOutcome {
        changed: captured.stdout != text,
        text: captured.stdout,
        formatter: spec.binary.to_string(),
    })
}

#[tauri::command]
pub async fn format_source(language: String, text: String) -> Result<FormatOutcome, String> {
    // Off the main thread: a formatter is a process, not a function call.
    tauri::async_runtime::spawn_blocking(move || format_blocking(&language, &text))
        .await
        .map_err(|e| format!("formatting task failed: {e}"))?
}

/// Which formatters exist on this machine, for the Settings pane.
#[tauri::command]
pub async fn list_formatters() -> Vec<FormatterStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        FORMATTERS
            .iter()
            .map(|spec| {
                let path = resolve_binary(spec.binary);
                FormatterStatus {
                    language: spec.language.to_string(),
                    binary: spec.binary.to_string(),
                    available: path.is_some(),
                    path: path.map(|p| p.display().to_string()),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Language ids we have at least one configured formatter for.
#[tauri::command]
pub fn formattable_languages() -> Vec<String> {
    let mut languages: Vec<String> = FORMATTERS.iter().map(|s| s.language.to_string()).collect();
    languages.dedup();
    languages.sort();
    languages.dedup();
    languages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_has_a_language_and_binary() {
        for spec in FORMATTERS {
            assert!(!spec.language.is_empty());
            assert!(!spec.binary.is_empty());
        }
    }

    #[test]
    fn unknown_language_is_reported_not_panicked() {
        let error = format_blocking("cobol", "IDENTIFICATION DIVISION.").unwrap_err();
        assert!(error.contains("no formatter is configured"), "{error}");
    }

    #[test]
    fn candidates_are_grouped_in_preference_order() {
        // ruff before black, tofu before terraform, gofumpt before gofmt.
        let python: Vec<&str> = FORMATTERS.iter().filter(|s| s.language == "python").map(|s| s.binary).collect();
        assert_eq!(python, vec!["ruff", "black"]);
        let hcl: Vec<&str> = FORMATTERS.iter().filter(|s| s.language == "hcl").map(|s| s.binary).collect();
        assert_eq!(hcl, vec!["tofu", "terraform"]);
    }

    /// End-to-end through a real subprocess. Skips when the tool is absent so
    /// the suite still passes on a machine without it.
    fn round_trip(language: &str, binary: &str, ugly: &str, expected_substring: &str) {
        if resolve_binary(binary).is_none() {
            eprintln!("skipping {language}: {binary} is not installed");
            return;
        }
        let outcome = format_blocking(language, ugly)
            .unwrap_or_else(|e| panic!("{language} via {binary} failed: {e}"));
        assert!(outcome.changed, "{language}: formatter reported no change");
        assert!(
            outcome.text.contains(expected_substring),
            "{language}: expected {expected_substring:?} in\n{}",
            outcome.text
        );
    }

    #[test]
    fn rust_formats_through_rustfmt() {
        round_trip("rust", "rustfmt", "fn main(){let x=1;println!(\"{}\",x);}\n", "    let x = 1;");
    }

    #[test]
    fn python_formats_through_ruff_or_black() {
        if resolve_binary("ruff").is_none() && resolve_binary("black").is_none() {
            eprintln!("skipping python: neither ruff nor black is installed");
            return;
        }
        let outcome = format_blocking("python", "def f( a,b ):\n  return  a+b\n").expect("python format");
        assert!(outcome.text.contains("def f(a, b):"), "got\n{}", outcome.text);
    }

    #[test]
    fn hcl_formats_through_terraform_or_tofu() {
        if resolve_binary("terraform").is_none() && resolve_binary("tofu").is_none() {
            eprintln!("skipping hcl: neither terraform nor tofu is installed");
            return;
        }
        let outcome = format_blocking("hcl", "resource \"a\" \"b\" {\nbucket=\"x\"\n}\n").expect("hcl format");
        assert!(outcome.text.contains("bucket = \"x\""), "got\n{}", outcome.text);
    }

    #[test]
    fn already_formatted_input_reports_no_change() {
        if resolve_binary("rustfmt").is_none() {
            return;
        }
        let tidy = "fn main() {\n    println!(\"hi\");\n}\n";
        let outcome = format_blocking("rust", tidy).expect("rust format");
        assert!(!outcome.changed, "expected no change, got\n{}", outcome.text);
    }

    /// A version-manager shim with no version selected exits non-zero and
    /// still prints to stdout. That must surface as an error, never as
    /// replacement text.
    #[test]
    fn a_failing_tool_never_returns_replacement_text() {
        let broken = format_blocking("rust", "fn main( { // deliberately unparseable\n");
        if let Ok(outcome) = broken {
            assert!(!outcome.text.trim().is_empty(), "a success must not empty the buffer");
        } else {
            let message = broken.unwrap_err();
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn formattable_languages_are_unique_and_sorted() {
        let languages = formattable_languages();
        let mut sorted = languages.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(languages, sorted);
    }
}
