// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The installed pre-commit hook runs this binary as a scanner. Answer
    // before any window exists: git is waiting on the exit code.
    if let Some(code) = afteredit_lib::precommit_cli() {
        std::process::exit(code);
    }
    afteredit_lib::run()
}
