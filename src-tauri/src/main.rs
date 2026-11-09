// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The installed pre-commit hook runs this binary as a scanner. Answer
    // before any window exists: git is waiting on the exit code.
    if let Some(code) = afteredit_lib::precommit_cli() {
        std::process::exit(code);
    }
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("cli") {
        args.remove(0);
        std::process::exit(afteredit_lib::service::cli::main(args));
    }
    afteredit_lib::run()
}
