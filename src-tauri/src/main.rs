// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The installed pre-commit hook runs this binary as a scanner. Answer
    // before any window exists: git is waiting on the exit code.
    if let Some(code) = afteredit_lib::precommit_cli() {
        std::process::exit(code);
    }
    let args:Vec<String>=std::env::args().skip(1).collect();
    if !args.is_empty() && args[0]!="--gui" {std::process::exit(afteredit_lib::service::cli::main(args));}
    afteredit_lib::run()
}
