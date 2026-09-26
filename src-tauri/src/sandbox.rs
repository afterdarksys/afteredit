//! macOS Seatbelt confinement for configured tasks.
//!
//! The profile is built here from the project path and a network flag. A task
//! cannot supply the profile text. This is not applied to the interactive
//! terminal, and it is not a general shell.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Copy)]
pub(crate) enum Network {
    Allow,
    Deny,
    Localhost,
}

pub(crate) fn launch(program: &str, root: &Path, network: Network) -> Result<(Command, bool), String> {
    launch_with(program, root, network, &[])
}

pub(crate) fn launch_with(program: &str, root: &Path, network: Network, extra_writes: &[PathBuf]) -> Result<(Command, bool), String> {
    if program.is_empty() || program.starts_with('-') {
        return Err("Task command is invalid.".into());
    }
    #[cfg(target_os = "macos")]
    {
        if !Path::new("/usr/bin/sandbox-exec").is_file() {
            return Err("macOS sandbox-exec is required before a task can run.".into());
        }
        let profile = profile_with(root, network, extra_writes)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.arg("-p").arg(profile).arg(program);
        return Ok((command, true));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, network, extra_writes);
        Ok((Command::new(program), false))
    }
}

fn quote_path(path: &Path) -> Result<String, String> {
    let text = path.to_string_lossy();
    if text.is_empty() || text.chars().any(|c| matches!(c, '"' | '\\' | '\n' | '\r' | '\0')) {
        return Err("A sandbox path contains quotes or control characters.".into());
    }
    Ok(format!("\"{text}\""))
}

fn subpath(path: &Path) -> Result<String, String> {
    Ok(format!("(subpath {})", quote_path(path)?))
}

fn literal(path: &Path) -> Result<String, String> {
    Ok(format!("(literal {})", quote_path(path)?))
}

/// Write roots are the project, temp, and toolchain caches. Cache rules do not
/// include directories that are on the task PATH, so a task cannot plant a
/// later command. Secret locations stay unreadable even when a parent is readable.
pub(crate) fn profile(root: &Path, network: Network) -> Result<String, String> {
    profile_with(root, network, &[])
}

pub(crate) fn profile_with(root: &Path, network: Network, extra_writes: &[PathBuf]) -> Result<String, String> {
    let root = root.canonicalize().map_err(|e| format!("Cannot sandbox the project: {e}"))?;
    let mut write = vec![subpath(&root)?];
    for candidate in ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] {
        let literal = subpath(Path::new(candidate))?;
        if !write.contains(&literal) { write.push(literal); }
        if let Ok(path) = Path::new(candidate).canonicalize() {
            let rule = subpath(&path)?;
            if !write.contains(&rule) { write.push(rule); }
        }
    }
    let mut secret = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let home = home.canonicalize().unwrap_or(home);
        for relative in [
            ".ssh",
            ".aws",
            ".gnupg",
            ".kube",
            ".docker",
            ".config/gh",
            ".config/gcloud",
            "Library/Keychains",
        ] {
            secret.push(subpath(&home.join(relative))?);
        }
        for relative in [
            ".git-credentials",
            ".cargo/credentials",
            ".cargo/credentials.toml",
            ".npmrc",
            ".netrc",
        ] {
            secret.push(literal(&home.join(relative))?);
        }
        for relative in [
            ".cargo/registry",
            ".cargo/git",
            ".npm",
            ".cache",
            "go/pkg",
            "Library/Caches",
            "Library/Developer",
            ".gradle",
            ".m2",
        ] {
            write.push(subpath(&home.join(relative))?);
        }
    }
    for extra in extra_writes {
        write.push(subpath(extra)?);
    }
    let mut text = String::from(
        "(version 1)\n(deny default)\n(allow process*)\n(allow signal)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow mach-register)\n(allow ipc-posix*)\n(allow system-socket)\n(allow file-ioctl)\n(allow file-read*)\n",
    );
    if !secret.is_empty() {
        text.push_str("(deny file-read*\n");
        for rule in &secret {
            text.push(' ');
            text.push_str(rule);
            text.push('\n');
        }
        text.push_str(")\n(deny file-write*\n");
        for rule in &secret {
            text.push(' ');
            text.push_str(rule);
            text.push('\n');
        }
        text.push_str(")\n");
    }
    text.push_str("(allow file-write*\n");
    for rule in &write {
        text.push(' ');
        text.push_str(rule);
        text.push('\n');
    }
    text.push_str(")\n(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n");
    match network {
        Network::Allow => text.push_str("(allow network-outbound)\n(allow network-bind (local ip \"localhost:*\"))\n(allow network-bind (local unix-socket))\n(allow network-inbound (local ip \"localhost:*\"))\n"),
        Network::Localhost => text.push_str("(allow network-outbound (remote ip \"localhost:*\"))\n(allow network-bind (local ip \"localhost:*\"))\n(allow network-bind (local unix-socket))\n(allow network-inbound (local ip \"localhost:*\"))\n"),
        Network::Deny => {}
    }
    Ok(text)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn network_policy_is_a_profile_rule() {
        let root = std::env::temp_dir();
        let open = profile(&root, Network::Allow).unwrap();
        let closed = profile(&root, Network::Deny).unwrap();
        let local = profile(&root, Network::Localhost).unwrap();
        assert!(open.contains("(allow network-outbound)\n"));
        assert!(!closed.contains("network-outbound"));
        assert!(local.contains("(allow network-outbound (remote ip \"localhost:*\"))"));
        assert!(!local.contains("(allow network-outbound)\n"));
        assert!(closed.contains(".ssh"));
        assert!(closed.contains(".cargo/registry"));
        assert!(!closed.contains(".cargo/bin"));
        assert!(!closed.contains(".local/bin"));
    }

    #[test]
    fn writes_stay_in_the_project_and_secrets_stay_unreadable() {
        let home = PathBuf::from(std::env::var_os("HOME").expect("home"));
        let root = home.join(format!("afteredit-sandbox-project-{}", std::process::id()));
        let outside = home.join(format!("afteredit-sandbox-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
        std::fs::create_dir_all(&root).unwrap();
        let (mut cmd, sandboxed) = launch("/bin/sh", &root, Network::Deny).unwrap();
        assert!(sandboxed);
        let script = format!(
            "echo in > '{}'/inside.txt; echo out > '{}'",
            root.display(),
            outside.display()
        );
        cmd.args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd.output().unwrap();
        let wrote_inside = root.join("inside.txt").is_file();
        let leaked = outside.exists();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
        assert!(wrote_inside, "{}", String::from_utf8_lossy(&output.stderr));
        assert!(!leaked, "sandbox allowed a write outside the project");

        std::fs::create_dir_all(&root).unwrap();
        let (mut cmd, _) = launch("/bin/ls", &root, Network::Deny).unwrap();
        cmd.arg(home.join(".ssh"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let output = cmd.output().unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let err = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{err}");
        assert!(err.contains("Operation not permitted"), "{err}");
    }
}
