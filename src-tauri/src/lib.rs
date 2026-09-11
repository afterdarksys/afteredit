mod menu;
mod apple;
mod ai;
mod ai_stream;
mod dap;
mod lsp;
mod registry;
mod context;
mod editor_bridge;
mod formatter;
mod lsp_installer;
mod policy;
mod secrets;
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
        .setup(|app| {
            menu::install(app)?;
            // A failed bridge is not fatal: the terminal just falls back to vi.
            if let Err(e) = editor_bridge::start(&app.handle().clone()) {
                eprintln!("editor bridge unavailable: {e}");
            }
            Ok(())
        })
        .manage(PtyState::default())
        .manage(editor_bridge::EditorBridge::default())
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
 context::active_context,
 editor_bridge::editor_release,
 policy::policy_discover,policy::policy_evaluate,
 secrets::scan_buffer_secrets,
 formatter::format_source,formatter::list_formatters,formatter::formattable_languages,
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
                app.state::<editor_bridge::EditorBridge>().shutdown();
                app.state::<tasks::TaskState>().shutdown();
                app.state::<lsp::LspState>().shutdown();
                app.state::<dap::DapState>().shutdown();
            }
        });
}

#[cfg(test)]
mod registration_tests {
    /// Every `#[tauri::command]` has to appear in `generate_handler!` or the
    /// frontend's `invoke()` fails at runtime while every unit test still
    /// passes -- which is exactly how the formatter commands once shipped
    /// unregistered. Unit tests call the inner function directly, so nothing
    /// else catches this.
    #[test]
    fn every_command_is_registered() {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").expect("generate_handler! block");
        let end = start + lib[start..].find(']').expect("end of handler list");
        let handler = &lib[start..end];

        let modules: [(&str, &str); 18] = [
            ("ai.rs", include_str!("ai.rs")),
            ("apple.rs", include_str!("apple.rs")),
            ("dap.rs", include_str!("dap.rs")),
            ("context.rs", include_str!("context.rs")),
            ("editor_bridge.rs", include_str!("editor_bridge.rs")),
            ("formatter.rs", include_str!("formatter.rs")),
            ("git.rs", include_str!("git.rs")),
            ("lsp.rs", include_str!("lsp.rs")),
            ("lsp_installer.rs", include_str!("lsp_installer.rs")),
            ("menu.rs", include_str!("menu.rs")),
            ("policy.rs", include_str!("policy.rs")),
            ("secrets.rs", include_str!("secrets.rs")),
            ("pty.rs", include_str!("pty.rs")),
            ("registry.rs", include_str!("registry.rs")),
            ("session.rs", include_str!("session.rs")),
            ("tasks.rs", include_str!("tasks.rs")),
            ("toolchain.rs", include_str!("toolchain.rs")),
            ("workspace.rs", include_str!("workspace.rs")),
        ];

        let mut checked = 0;
        for (file, source) in modules {
            let lines: Vec<&str> = source.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if line.trim() != "#[tauri::command]" {
                    continue;
                }
                // Doc comments and further attributes may sit between the
                // attribute and the signature.
                let signature = lines[index + 1..]
                    .iter()
                    .find(|candidate| candidate.contains("fn "))
                    .unwrap_or_else(|| panic!("{file}: #[tauri::command] with no fn after it"));
                let name = signature
                    .split("fn ")
                    .nth(1)
                    .and_then(|rest| rest.split(['(', '<', ' ']).next())
                    .unwrap_or_default()
                    .trim();
                assert!(
                    handler.contains(name),
                    "{file}: command `{name}` is missing from generate_handler!",
                );
                checked += 1;
            }
        }
        assert!(checked > 20, "expected to find many commands, found {checked}");
    }
}
