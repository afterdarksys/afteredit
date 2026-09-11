//! Language-server discovery and (consented) installation.
//!
//! Two things to keep in mind here:
//!
//! 1. Installing software is a privileged, user-visible act. This module never
//!    installs anything without an explicit OS confirmation dialog, and the
//!    package name is only ever read from `SUPPORTED` below -- never from the
//!    webview. The frontend can pick a language key, nothing more.
//! 2. Tool lookup goes through `toolpath`, not `which`: a GUI process does
//!    not inherit the login shell's PATH, so `which brew` fails on most Macs.

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::toolpath::{resolve_binary, tail};

const EVENT_PROGRESS: &str = "lsp:progress";

/// How a language server gets onto the machine.
#[derive(Clone, Copy)]
enum Source {
    Brew(&'static str),
    Npm(&'static str),
    /// Cannot be installed for the user; say what to do instead.
    Manual(&'static str),
}

/// (language key, the binary the client actually spawns, how to get it).
///
/// The binary column must stay in step with `serverPresets` in
/// src/languageServices.ts -- installing something the client never launches
/// is worse than installing nothing. `presets_and_installers_agree` enforces it.
const SUPPORTED: &[(&str, &str, Source)] = &[
    ("rust", "rust-analyzer", Source::Brew("rust-analyzer")),
    ("go", "gopls", Source::Brew("gopls")),
    ("python", "pyright-langserver", Source::Npm("pyright")),
    ("typescript", "typescript-language-server", Source::Brew("typescript-language-server")),
    ("javascript", "typescript-language-server", Source::Brew("typescript-language-server")),
    ("shell", "bash-language-server", Source::Brew("bash-language-server")),
    ("hcl", "terraform-ls", Source::Brew("hashicorp/tap/terraform-ls")),
    ("ansible", "ansible-language-server", Source::Npm("@ansible/ansible-language-server")),
    ("c", "clangd", Source::Brew("llvm")),
    ("cpp", "clangd", Source::Brew("llvm")),
    ("java", "jdtls", Source::Brew("jdtls")),
    ("php", "intelephense", Source::Npm("intelephense")),
    ("perl", "perlnavigator", Source::Npm("perlnavigator")),
    ("html", "vscode-html-language-server", Source::Npm("vscode-langservers-extracted")),
    ("css", "vscode-css-language-server", Source::Npm("vscode-langservers-extracted")),
    ("swift", "xcrun", Source::Manual("SourceKit-LSP ships with Xcode. Install Xcode from the App Store, then `xcode-select --install`.")),
    ("objective-c", "xcrun", Source::Manual("SourceKit-LSP ships with Xcode. Install Xcode from the App Store, then `xcode-select --install`.")),
    ("groovy", "java", Source::Manual("Install a JDK (`brew install openjdk`) and put groovy-language-server.jar on the classpath.")),
];

fn confirm_install(app: &AppHandle, binary: &str, command: &str) -> bool {
    app.dialog()
        .message(format!(
            "{binary} is not installed.\n\n\
             AfterEdit can install it by running:\n\n    {command}\n\n\
             This downloads and installs software on your machine."
        ))
        .title("Install language server?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".to_string(),
            "Not now".to_string(),
        ))
        .blocking_show()
}

/// Run an install, surfacing the tool's own reason on failure -- a bundled app
/// has no visible stdout, so inherited output would be lost.
fn run_install(app: &AppHandle, tool: &Path, args: &[&str], label: &str) -> Result<(), String> {
    let _ = app.emit(EVENT_PROGRESS, format!("Installing {label}..."));

    let output = Command::new(tool)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {}: {e}", tool.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(format!(
            "installing {label} failed ({}):\n{}",
            output.status,
            tail(&detail, 600)
        ));
    }
    Ok(())
}

fn no_package_manager(binary: &str, formula: &str) -> String {
    // MacPorts needs root, and escalating privileges out of a GUI app is a
    // design decision of its own. Rather than run `port install` without sudo
    // (which always fails), hand the user the command that works.
    if let Some(port) = resolve_binary("port") {
        format!(
            "{binary} is not installed and Homebrew was not found.\n\
             MacPorts is available, but its installs need root. Run:\n\n    sudo {} install {formula}",
            port.display()
        )
    } else {
        format!(
            "{binary} is not installed and Homebrew was not found.\n\
             Install Homebrew from https://brew.sh, or install '{formula}' yourself."
        )
    }
}

/// Blocking. Must not run on the main thread: the dialog blocks, and so does
/// a package install.
fn ensure_installed(app: &AppHandle, binary: &str, source: Source) -> Result<String, String> {
    if let Some(path) = resolve_binary(binary) {
        return Ok(format!("{binary} is ready ({})", path.display()));
    }

    match source {
        // Nothing to install: say what to do instead rather than pretending.
        Source::Manual(advice) => Err(format!("{binary} is not installed. {advice}")),

        Source::Brew(formula) => {
            let Some(brew) = resolve_binary("brew") else {
                return Err(no_package_manager(binary, formula));
            };
            let command = format!("{} install {formula}", brew.display());
            if !confirm_install(app, binary, &command) {
                return Err(format!("Installation of {binary} was declined."));
            }
            run_install(app, &brew, &["install", formula], formula)?;
            confirm_present(app, binary)
        }

        Source::Npm(package) => {
            let Some(npm) = resolve_binary("npm") else {
                return Err(format!(
                    "{binary} is not installed and npm was not found.\n\
                     Install Node.js, or install '{package}' yourself."
                ));
            };
            let command = format!("{} install -g {package}", npm.display());
            if !confirm_install(app, binary, &command) {
                return Err(format!("Installation of {binary} was declined."));
            }
            run_install(app, &npm, &["install", "-g", package], package)?;
            confirm_present(app, binary)
        }
    }
}

/// The installer said it worked; make sure the binary is actually reachable.
fn confirm_present(app: &AppHandle, binary: &str) -> Result<String, String> {
    let path = resolve_binary(binary).ok_or_else(|| {
        format!("the installer reported success but {binary} is still not on any known path")
    })?;
    let _ = app.emit(EVENT_PROGRESS, format!("{binary} installed."));
    Ok(format!("{binary} is ready ({})", path.display()))
}

#[tauri::command]
pub async fn check_and_install_lsp(app: AppHandle, language: String) -> Result<String, String> {
    let (binary, source) = SUPPORTED
        .iter()
        .find(|(key, _, _)| *key == language)
        .map(|(_, binary, source)| (*binary, *source))
        .ok_or_else(|| format!("no language server is configured for '{language}'"))?;

    // Off the main thread: the confirmation dialog blocks, and so does install.
    tauri::async_runtime::spawn_blocking(move || ensure_installed(&app, binary, source))
        .await
        .map_err(|e| format!("language server install task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every language the client can start a server for must have an install
    /// path, and the binary we install must be the one the client actually
    /// spawns. This drifted once already: the preset launched
    /// `pyright-langserver` while the installer fetched `pylsp`, so "install
    /// the Python server" installed something that was never run.
    #[test]
    fn presets_and_installers_agree() {
        let presets = include_str!("../../src/languageServices.ts");
        let block = presets
            .split_once("serverPresets")
            .and_then(|(_, rest)| rest.split_once("export function"))
            .map(|(block, _)| block)
            .expect("serverPresets block");

        let entry = regex::Regex::new(r"'?([A-Za-z-]+)'?\s*:\s*\{command:'([^']+)'")
            .expect("valid pattern");

        let mut seen = 0;
        for capture in entry.captures_iter(block) {
            let language = capture.get(1).map_or("", |m| m.as_str());
            let command = capture.get(2).map_or("", |m| m.as_str());
            // Presets may name an absolute path (/usr/bin/xcrun).
            let binary = command.rsplit('/').next().unwrap_or(command);

            let installed = SUPPORTED
                .iter()
                .find(|(key, _, _)| *key == language)
                .unwrap_or_else(|| panic!("no install path for preset language '{language}'"));

            assert_eq!(
                installed.1, binary,
                "language '{language}': the client spawns `{binary}` but the installer provides `{}`",
                installed.1,
            );
            seen += 1;
        }
        assert!(seen >= 15, "only parsed {seen} presets; the pattern probably broke");
    }

    #[test]
    fn every_entry_names_a_binary_and_a_source() {
        for (language, binary, source) in SUPPORTED {
            assert!(!language.is_empty() && !binary.is_empty());
            match source {
                Source::Brew(f) | Source::Npm(f) => assert!(!f.is_empty(), "{language} has an empty package"),
                // Manual entries exist to give advice, so they must give some.
                Source::Manual(advice) => assert!(advice.len() > 20, "{language} advice is too thin"),
            }
        }
    }

    #[test]
    fn an_unknown_language_is_reported_not_panicked() {
        assert!(SUPPORTED.iter().all(|(key, _, _)| *key != "cobol"));
    }
}
