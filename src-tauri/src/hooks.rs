//! A real `.git/hooks/pre-commit`, running the same secret scan the editor does.
//!
//! Threats: closes the gap left by the editor's own commit gate. A commit made
//! from the terminal, another editor, a script or an IDE never touches
//! AfterEdit's commit command, so until now it was scanned by nothing. This
//! installs git's own gate, which every one of those paths goes through.
//!
//! Does NOT protect against: `git commit --no-verify` (deliberate -- a gate
//! with no visible escape hatch gets deleted instead of bypassed), secrets
//! already in history, commits made before the hook was installed, `core.hooksPath`
//! being repointed afterwards, or a `--no-verify` push. It is a guard rail,
//! not a guarantee.
//!
//! No secret material is ever handled here: the hook runs the same scanner as
//! the commit command, which reports a rule id and a location and nothing else.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::secrets;

/// Identifies a hook as ours, so a reinstall can upgrade it in place while a
/// hook somebody else wrote is never silently overwritten. Version it: a later
/// script shape still needs to recognise this one.
pub const MARKER: &str = "# afteredit-precommit v1";

/// The argument that turns the app binary into the scanner the hook calls.
pub const SCAN_FLAG: &str = "--precommit-scan";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// A pre-commit hook exists at `path`.
    pub present: bool,
    /// ...and it is ours, so installing over it is an upgrade, not a clobber.
    pub ours: bool,
    pub path: String,
    /// Set when `core.hooksPath` redirects hooks away from `.git/hooks`;
    /// installing into the default directory would do nothing.
    pub hooks_path_override: Option<String>,
    /// Whether gitleaks is available, which decides how much the hook covers.
    pub gitleaks: bool,
}

/// Wrap a path for `sh` so spaces, quotes and `$` in it cannot become code.
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The hook script. Kept small and dependency-free on purpose: it has to keep
/// working on a machine where AfterEdit is not running, and be readable by
/// whoever finds it in `.git/hooks` a year from now.
pub fn hook_script(binary: &Path) -> String {
    let quoted = shell_quote(&binary.to_string_lossy());
    format!(
        r#"#!/bin/sh
{MARKER}
# Installed by AfterEdit. Scans the staged changes for credentials before they
# can reach git history. Delete this file to uninstall.
#
# To commit without this check: git commit --no-verify

set -u

BIN={quoted}

# Preferred: AfterEdit's own scanner, so the terminal and the editor apply the
# same rules and the same allowlist.
if [ -x "$BIN" ]; then
  "$BIN" {SCAN_FLAG}
  exit $?
fi

# AfterEdit was moved or uninstalled. Fall back to gitleaks directly rather
# than letting the gate quietly disappear.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --staged --redact --no-banner . || exit 1
  exit 0
fi

# Nothing can scan. Fail closed: an unscanned commit is the thing this hook
# exists to prevent.
echo "pre-commit: AfterEdit's secret scan could not run." >&2
echo "  $BIN is missing, and gitleaks is not on PATH." >&2
echo "  Reinstall AfterEdit, install gitleaks, or delete this hook." >&2
echo "  To commit anyway: git commit --no-verify" >&2
exit 1
"#
    )
}

/// Where this repository actually runs hooks from. `core.hooksPath` wins when
/// it is set; writing to `.git/hooks` in that case installs a file git will
/// never run, which is worse than not installing at all.
pub fn hooks_dir(root: &Path) -> Result<(PathBuf, Option<String>), String> {
    let configured = crate::git::git(root, &["config", "--get", "core.hooksPath"])?;
    if configured.code == 0 {
        let value = configured.stdout.trim().to_string();
        if !value.is_empty() {
            let path = PathBuf::from(&value);
            let path = if path.is_absolute() { path } else { root.join(path) };
            return Ok((path, Some(value)));
        }
    }
    let output = crate::git::git(root, &["rev-parse", "--git-path", "hooks"])?;
    if output.code != 0 {
        return Err("Could not locate this repository's hooks directory.".into());
    }
    let path = PathBuf::from(output.stdout.trim_end());
    Ok((if path.is_absolute() { path } else { root.join(path) }, None))
}

fn is_ours(path: &Path) -> bool {
    std::fs::read_to_string(path).map(|text| text.contains(MARKER)).unwrap_or(false)
}

pub fn status(root: &Path) -> Result<HookStatus, String> {
    let (dir, hooks_path_override) = hooks_dir(root)?;
    let path = dir.join("pre-commit");
    Ok(HookStatus {
        present: path.exists(),
        ours: is_ours(&path),
        path: path.to_string_lossy().into_owned(),
        hooks_path_override,
        gitleaks: crate::toolpath::resolve_binary("gitleaks").is_some(),
    })
}

/// Install the hook. Refuses to destroy somebody else's work: an existing hook
/// that is not ours stops the install unless `replace` is explicitly set, and
/// even then it is copied aside first.
pub fn install(root: &Path, binary: &Path, replace: bool) -> Result<String, String> {
    let (dir, _) = hooks_dir(root)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join("pre-commit");

    let mut note = String::new();
    if path.exists() && !is_ours(&path) {
        if !replace {
            return Err(format!(
                "{} already exists and was not written by AfterEdit.\nReview it first, then install again to replace it — the existing hook is kept as a backup.",
                path.display()
            ));
        }
        let backup = backup_path(&dir);
        std::fs::rename(&path, &backup)
            .map_err(|e| format!("could not back up the existing hook: {e}"))?;
        note = format!(" The previous hook was kept at {}.", backup.display());
    }

    // Write beside the target and rename: a half-written hook is a hook git
    // will still try to run.
    let temporary = dir.join(format!("pre-commit.afteredit-{}", std::process::id()));
    std::fs::write(&temporary, hook_script(binary))
        .map_err(|e| format!("could not write the hook: {e}"))?;
    if let Err(e) = make_executable(&temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(e);
    }
    std::fs::rename(&temporary, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("could not install the hook: {e}")
    })?;

    Ok(format!("Pre-commit secret scan installed at {}.{note}", path.display()))
}

fn backup_path(dir: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Never overwrite a backup either.
    let mut candidate = dir.join(format!("pre-commit.before-afteredit-{stamp}"));
    let mut extra = 1;
    while candidate.exists() {
        candidate = dir.join(format!("pre-commit.before-afteredit-{stamp}-{extra}"));
        extra += 1;
    }
    candidate
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make the hook executable: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// The scan the hook invokes. Returns the process exit code: 0 lets the commit
/// through, anything else stops it.
pub fn scan_cli(root: &Path) -> i32 {
    match secrets::scan_staged(root) {
        Ok(scan) if scan.findings.is_empty() => 0,
        Ok(scan) => {
            eprintln!("{}", secrets::refusal(&scan));
            eprintln!("To commit anyway: git commit --no-verify");
            1
        }
        // Fail closed: a scan that could not run is not a clean scan.
        Err(e) => {
            eprintln!("pre-commit: the secret scan could not run: {e}");
            eprintln!("To commit anyway: git commit --no-verify");
            2
        }
    }
}

/// Intercepts `--precommit-scan` before any window is created. Returns the exit
/// code to use, or `None` when this is an ordinary app launch.
pub fn cli<I: IntoIterator<Item = String>>(args: I) -> Option<i32> {
    if !args.into_iter().any(|arg| arg == SCAN_FLAG) {
        return None;
    }
    // git runs hooks from the top of the working tree.
    let root = std::env::current_dir().ok()?;
    Some(scan_cli(&root))
}

#[tauri::command]
pub async fn precommit_hook_status(
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: String,
) -> Result<HookStatus, String> {
    let root = crate::git::repository(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || status(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_precommit_hook(
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: String,
    replace: bool,
) -> Result<String, String> {
    let root = crate::git::repository(&state, &root)?;
    let binary = std::env::current_exe().map_err(|e| format!("could not locate AfterEdit: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || install(&root, &binary, replace))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_binary() -> PathBuf {
        crate::toolpath::resolve_binary("git").expect("git")
    }

    fn run_git(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new(git_binary()).current_dir(dir).args(args).output().expect("git ran")
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("afteredit-hook-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "AfterEdit Test"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            assert!(run_git(&dir, &args).status.success(), "git {args:?} failed");
        }
        dir
    }

    /// A stub scanner standing in for the app binary, so the hook's control
    /// flow can be tested against real `git commit`. The decision itself is
    /// covered by `scan_cli_*` below, against the real scanner.
    fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        make_executable(&path).unwrap();
        path
    }

    #[test]
    fn the_script_says_what_it_is_and_how_to_bypass_it() {
        let script = hook_script(Path::new("/Applications/AfterEdit.app/Contents/MacOS/afteredit"));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains(MARKER), "the hook must be recognisable as ours");
        assert!(script.contains(SCAN_FLAG));
        assert!(script.contains("git commit --no-verify"), "the escape hatch must be documented");
        assert!(script.contains("exit 1"), "must fail closed when nothing can scan");
    }

    #[test]
    fn a_hostile_binary_path_cannot_become_shell_code() {
        // Assert by execution, not by pattern: run the generated hook and see
        // whether the injected command actually fires.
        let dir = std::env::temp_dir().join(format!("afteredit-hook-quote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let hook = dir.join("pre-commit");
        std::fs::write(&hook, hook_script(Path::new("/nonexistent/x'; touch ESCAPED; echo '"))).unwrap();

        let output = Command::new("/bin/sh")
            .current_dir(&dir)
            .arg(&hook)
            .env("PATH", "/nonexistent")
            .output()
            .expect("sh ran");
        assert!(!dir.join("ESCAPED").exists(), "the path broke out of its quotes and ran");
        assert!(!output.status.success(), "no scanner was available, so it must refuse");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_writes_an_executable_hook() {
        let dir = repo("install");
        let message = install(&dir, Path::new("/usr/bin/true"), false).unwrap();
        let hook = dir.join(".git/hooks/pre-commit");
        assert!(message.contains("installed"));
        assert!(is_ours(&hook));
        assert!(crate::toolpath::is_executable(&hook), "git will not run a non-executable hook");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_to_clobber_someone_elses_hook() {
        let dir = repo("clobber");
        let hook = dir.join(".git/hooks/pre-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\necho theirs\n").unwrap();

        let refused = install(&dir, Path::new("/usr/bin/true"), false).unwrap_err();
        assert!(refused.contains("already exists"), "{refused}");
        assert_eq!(std::fs::read_to_string(&hook).unwrap(), "#!/bin/sh\necho theirs\n");

        // Explicit replace keeps the original as a backup.
        let message = install(&dir, Path::new("/usr/bin/true"), true).unwrap();
        assert!(is_ours(&hook));
        let backup = message.split("kept at ").nth(1).unwrap().trim_end_matches('.');
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "#!/bin/sh\necho theirs\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reinstalling_our_own_hook_upgrades_it_without_a_backup() {
        let dir = repo("upgrade");
        install(&dir, Path::new("/usr/bin/true"), false).unwrap();
        let message = install(&dir, Path::new("/usr/bin/false"), false).unwrap();
        assert!(!message.contains("kept at"), "an upgrade should not leave backups: {message}");
        let hooks: Vec<_> = std::fs::read_dir(dir.join(".git/hooks"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("pre-commit") && !name.ends_with(".sample"))
            .collect();
        assert_eq!(hooks, vec!["pre-commit".to_string()], "stray files left behind: {hooks:?}");
        assert!(std::fs::read_to_string(dir.join(".git/hooks/pre-commit")).unwrap().contains("/usr/bin/false"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_follows_core_hooks_path() {
        let dir = repo("hookspath");
        run_git(&dir, &["config", "core.hooksPath", "githooks"]);
        let reported = status(&dir).unwrap();
        assert_eq!(reported.hooks_path_override.as_deref(), Some("githooks"));
        install(&dir, Path::new("/usr/bin/true"), false).unwrap();
        assert!(is_ours(&dir.join("githooks/pre-commit")), "installed where git will not look");
        assert!(!dir.join(".git/hooks/pre-commit").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- negative tests: the hook has to actually stop a commit -----------

    #[test]
    fn the_installed_hook_blocks_a_commit_and_no_verify_gets_through() {
        let dir = repo("blocks");
        let scanner = stub(&dir, "refuse.sh", "echo 'Commit blocked: 1 possible secret' >&2\nexit 1");
        install(&dir, &scanner, false).unwrap();

        std::fs::write(dir.join("config.ini"), "key = value\n").unwrap();
        run_git(&dir, &["add", "--", "config.ini"]);

        let refused = run_git(&dir, &["commit", "-m", "add config"]);
        assert!(!refused.status.success(), "the hook did not stop the commit");
        assert!(String::from_utf8_lossy(&refused.stderr).contains("Commit blocked"));
        assert!(!run_git(&dir, &["rev-parse", "HEAD"]).status.success(), "a commit was created");

        let bypassed = run_git(&dir, &["commit", "--no-verify", "-m", "add config"]);
        assert!(bypassed.status.success(), "--no-verify must remain the escape hatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hook_fails_closed_when_nothing_can_scan() {
        let dir = repo("failclosed");
        // A binary that does not exist, and a PATH with no gitleaks on it.
        install(&dir, &dir.join("afteredit-does-not-exist"), false).unwrap();
        std::fs::write(dir.join("app.py"), "print('hi')\n").unwrap();
        run_git(&dir, &["add", "--", "app.py"]);

        let refused = Command::new(git_binary())
            .current_dir(&dir)
            .env("PATH", "/nonexistent")
            .args(["commit", "-m", "add app"])
            .output()
            .expect("git ran");
        assert!(!refused.status.success(), "an unscannable commit must not go through");
        assert!(
            String::from_utf8_lossy(&refused.stderr).contains("could not run"),
            "the refusal must say why: {}",
            String::from_utf8_lossy(&refused.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- the decision itself, against the real scanner --------------------

    #[test]
    fn scan_cli_refuses_a_staged_credential_and_passes_a_clean_tree() {
        let dir = repo("scan");
        std::fs::write(dir.join("config.ini"), "aws_access_key_id = AKIA4NPQ2XZJ7KLMWVR3\n").unwrap();
        run_git(&dir, &["add", "--", "config.ini"]);
        assert_eq!(scan_cli(&dir), 1, "a staged AWS key must stop the commit");

        std::fs::write(dir.join("config.ini"), "aws_access_key_id = ${AWS_ACCESS_KEY_ID}\n").unwrap();
        run_git(&dir, &["add", "--", "config.ini"]);
        assert_eq!(scan_cli(&dir), 0, "a clean tree must commit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_only_fires_for_the_scan_flag() {
        assert_eq!(cli(Vec::<String>::new()), None);
        assert_eq!(cli(vec!["/Applications/AfterEdit".to_string()]), None);
        assert!(cli(vec!["afteredit".into(), SCAN_FLAG.to_string()]).is_some());
    }
}
