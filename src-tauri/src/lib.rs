mod ai;
mod registry;
mod lsp_installer;
mod pty;
mod tasks;
mod workspace;

use pty::PtyState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(workspace::WorkspaceState::default())
        .manage(tasks::TaskState::default())
        .manage(ai::AiState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::pty_write,
            pty::pty_resize,
            lsp_installer::check_and_install_lsp,
            workspace::choose_path,
            workspace::list_directory,
            workspace::read_file, workspace::workspace_search,
            workspace::save_file,
            workspace::save_as,
            workspace::confirm_discard,
            workspace::project_config,
            workspace::create_config,
            workspace::task_directory,
            tasks::run_task,
            tasks::cancel_task,
            registry::registry_search, registry::registry_download,
            ai::ask_ai
        ])
        .build(tauri::generate_context!())
        .expect("error while building AfterEdit")
        .run(|app, event| {
            // Without this the shell outlives the window as an orphan.
            if let RunEvent::Exit = event {
                app.state::<PtyState>().shutdown();
                app.state::<tasks::TaskState>().shutdown();
            }
        });
}
