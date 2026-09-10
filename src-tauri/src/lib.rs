mod menu;
mod apple;
mod ai;
mod ai_stream;
mod dap;
mod lsp;
mod registry;
mod formatter;
mod lsp_installer;
mod pty;
mod toolpath;
mod tasks;
mod workspace;
mod session;
mod process;
mod git;
mod toolchain;

use pty::PtyState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| { menu::install(app)?; Ok(()) })
        .manage(PtyState::default())
        .manage(workspace::WorkspaceState::default())
        .manage(tasks::TaskState::default())
        .manage(ai::AiState::default())
        .manage(dap::DapState::default())
        .manage(lsp::LspState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            menu::update_menu,
            pty::spawn_pty,
            pty::pty_write,
            pty::pty_resize,
            lsp_installer::check_and_install_lsp,
            toolchain::inspect_tools,
            apple::apple_toolchain, apple::apple_projects, apple::apple_query, apple::apple_open,
            git::git_status, git::git_diff, git::git_stage, git::git_review_staged, git::git_commit,
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
            ai::ask_ai, ai::cancel_ai
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
