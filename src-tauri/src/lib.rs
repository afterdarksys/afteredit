use std::sync::{Arc, Mutex};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{Emitter, State, Window};

struct AppState {
    // This will hold the PTY writer eventually
}

#[tauri::command]
fn spawn_pty(window: Window) -> Result<(), String> {
    // Set up the native PTY system
    let pty_system = native_pty_system();

    // Create a new PTY with a given size
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Prepare the command to run (e.g., zsh or bash)
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.env("TERM", "xterm-256color");

    // Spawn the shell into the PTY
    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Here we would typically spawn a thread to read from `pair.master`
    // and emit the bytes as Tauri events to `xterm.js` on the frontend.
    // window.emit("pty_read", byte_array).unwrap();

    Ok(())
}

mod lsp_installer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {})
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            lsp_installer::check_and_install_lsp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
