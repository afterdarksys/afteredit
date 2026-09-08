mod lsp_installer;
mod pty;

use pty::PtyState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::pty_write,
            pty::pty_resize,
            lsp_installer::check_and_install_lsp
        ])
        .build(tauri::generate_context!())
        .expect("error while building AfterEdit")
        .run(|app, event| {
            // Without this the shell outlives the window as an orphan.
            if let RunEvent::Exit = event {
                app.state::<PtyState>().shutdown();
            }
        });
}
