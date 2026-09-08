use std::process::Command;

/// Attempts to install a missing Language Server Protocol (LSP) binary
/// using the host's native package manager (Homebrew or MacPorts on OS X).
pub fn auto_install_lsp(lsp_name: &str, package_name: &str) -> Result<(), String> {
    println!("[LSP Manager] Checking for {}...", lsp_name);

    // 1. Check if the LSP is already installed and in the PATH
    if Command::new("which").arg(lsp_name).output().is_ok_and(|out| out.status.success()) {
        println!("[LSP Manager] {} is already installed.", lsp_name);
        return Ok(());
    }

    println!("[LSP Manager] {} not found. Attempting auto-install...", lsp_name);

    // 2. Detect Package Manager (Brew vs MacPorts)
    let has_brew = Command::new("which").arg("brew").output().is_ok_and(|out| out.status.success());
    let has_port = Command::new("which").arg("port").output().is_ok_and(|out| out.status.success());

    if has_brew {
        println!("[LSP Manager] Detected Homebrew. Running: brew install {}", package_name);
        let status = Command::new("brew")
            .arg("install")
            .arg(package_name)
            .status()
            .map_err(|e| format!("Failed to execute brew: {}", e))?;

        if status.success() {
            println!("[LSP Manager] Successfully installed {} via Homebrew.", lsp_name);
            return Ok(());
        }
    } else if has_port {
        println!("[LSP Manager] Detected MacPorts. Running: sudo port install {}", package_name);
        // Note: MacPorts usually requires sudo for installation, which presents a challenge for GUI apps.
        // We would likely need to prompt the user via polkit or AppleScript osascript for elevated privileges.
        let status = Command::new("port")
            .arg("install")
            .arg(package_name)
            .status()
            .map_err(|e| format!("Failed to execute port: {}", e))?;

        if status.success() {
            println!("[LSP Manager] Successfully installed {} via MacPorts.", lsp_name);
            return Ok(());
        }
    }

    Err(format!(
        "Could not auto-install {}. Please install '{}' manually.",
        lsp_name, package_name
    ))
}

#[tauri::command]
pub fn check_and_install_lsp(language: &str) -> Result<String, String> {
    match language {
        "rust" => {
            auto_install_lsp("rust-analyzer", "rust-analyzer")?;
            Ok("rust-analyzer is ready".into())
        }
        "python" => {
            auto_install_lsp("pylsp", "python-lsp-server")?;
            Ok("pylsp is ready".into())
        }
        "typescript" | "javascript" => {
            // Usually installed via npm, but for native OS X package managers we could use typescript-language-server
            auto_install_lsp("typescript-language-server", "typescript-language-server")?;
            Ok("typescript-language-server is ready".into())
        }
        _ => Err(format!("No auto-install logic defined for language: {}", language)),
    }
}
