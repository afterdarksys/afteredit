mod ai;
mod dap;
mod lsp;
mod registry;
mod lsp_installer;
mod pty;
mod tasks;
mod workspace;
mod session;
mod process;
mod git;

use pty::PtyState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(workspace::WorkspaceState::default())
        .manage(tasks::TaskState::default())
        .manage(ai::AiState::default())
        .manage(dap::DapState::default())
        .manage(lsp::LspState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::pty_write,
            pty::pty_resize,
            lsp_installer::check_and_install_lsp,
            git::git_status, git::git_diff,
            session::restore_session, session::save_session,
            workspace::choose_path,
            workspace::list_directory,
            workspace::read_file, workspace::project_file_path, workspace::workspace_search,
            workspace::save_file,
            workspace::save_as,
            workspace::confirm_discard,
            workspace::project_config,
            workspace::create_config,
            workspace::task_directory,
            tasks::run_task,
            tasks::cancel_task,
            registry::registry_search, registry::registry_download,
            lsp::lsp_start,lsp::lsp_request,lsp::lsp_notify,lsp::lsp_stop,
            dap::dap_start,dap::dap_request,dap::dap_stop,
            ai::ask_ai
        ])
        .build(tauri::generate_context!())
        .expect("error while building AfterEdit")
        .run(|app, event| {
            // Without this the shell outlives the window as an orphan.
            if let RunEvent::Exit = event {
                app.state::<PtyState>().shutdown();
                app.state::<tasks::TaskState>().shutdown();
                app.state::<lsp::LspState>().shutdown();
                app.state::<dap::DapState>().shutdown();
            }
        });
}
