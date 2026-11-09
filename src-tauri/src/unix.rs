//! Unix and OS-shaped project commands.
//!
//! Threats: probes, man, and pkg-config use a fixed argv and no shell.
//! The project scan reads regular files inside an opened root and skips
//! symlinks. Make targets are names parsed from the file. The reviewed task
//! is `make -C dir target`. This does not sandbox the build the user then
//! runs, and opening the panel never runs these commands.
//!
//! `lldb-dap` is not executed: it waits on stdin for a debug session.
//! `./configure` is not a task. The task runner treats a relative command as
//! a file in the app's working directory, not as a script in the project.

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Command,
    time::Duration,
};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    name: String,
    available: bool,
    detail: String,
}

const VERSION_PROBES: &[(&str, &str, &[&str])] = &[
    ("clang", "clang", &["--version"]),
    ("clang++", "clang++", &["--version"]),
    ("clangd", "clangd", &["--version"]),
    ("lldb", "lldb", &["--version"]),
    ("make", "make", &["--version"]),
    ("cmake", "cmake", &["--version"]),
    ("ninja", "ninja", &["--version"]),
    ("meson", "meson", &["--version"]),
    ("pkg-config", "pkg-config", &["--version"]),
    ("bear", "bear", &["--version"]),
    ("rustc", "rustc", &["--version"]),
    ("cargo", "cargo", &["--version"]),
    ("go", "go", &["version"]),
    ("zig", "zig", &["version"]),
    ("qemu-system-x86_64", "qemu-system-x86_64", &["--version"]),
];

const PRESENT_ONLY: &[(&str, &str)] = &[("lldb-dap", "lldb-dap")];

fn tool_command(program: &str) -> Result<Command, String> {
    let path = crate::toolpath::resolve_binary(program)
        .ok_or_else(|| format!("{program} is not installed."))?;
    let mut command = Command::new(&path);
    command.current_dir(std::env::temp_dir());
    if let Ok(path) = std::env::join_paths(crate::toolpath::search_dirs()) {
        command.env("PATH", path);
    }
    Ok(command)
}

fn version_check(name: &str, program: &str, args: &[&str]) -> ToolCheck {
    let mut command = match tool_command(program) {
        Ok(command) => command,
        Err(detail) => {
            return ToolCheck {
                name: name.into(),
                available: false,
                detail,
            }
        }
    };
    command.args(args);
    match crate::process::run(command, Duration::from_secs(5)) {
        Ok(output) if output.code == 0 => {
            let text = if output.stdout.trim().is_empty() {
                output.stderr.trim()
            } else {
                output.stdout.trim()
            };
            ToolCheck {
                name: name.into(),
                available: true,
                detail: text.chars().take(500).collect(),
            }
        }
        Ok(output) => ToolCheck {
            name: name.into(),
            available: false,
            detail: format!(
                "Version check failed: {}",
                output.stderr.chars().take(500).collect::<String>()
            ),
        },
        Err(detail) => ToolCheck {
            name: name.into(),
            available: false,
            detail,
        },
    }
}

fn present_check(name: &str, program: &str) -> ToolCheck {
    match crate::toolpath::resolve_binary(program) {
        Some(path) => ToolCheck {
            name: name.into(),
            available: true,
            detail: format!(
                "Found at {}. Not executed, because {program} waits for a debug session.",
                path.display()
            ),
        },
        None => ToolCheck {
            name: name.into(),
            available: false,
            detail: format!("{program} was not found. Not executed."),
        },
    }
}

fn toolchain() -> Vec<ToolCheck> {
    let mut checks: Vec<ToolCheck> = VERSION_PROBES
        .iter()
        .map(|(name, program, args)| version_check(name, program, args))
        .collect();
    checks.extend(PRESENT_ONLY.iter().map(|(name, program)| present_check(name, program)));
    checks
}

#[tauri::command]
pub async fn unix_toolchain() -> Result<Vec<ToolCheck>, String> {
    tauri::async_runtime::spawn_blocking(toolchain)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MakefileFacts {
    path: String,
    targets: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnixProject {
    cmake: Vec<String>,
    makefiles: Vec<MakefileFacts>,
    meson: Vec<String>,
    autotools: Vec<String>,
    kernel: Vec<String>,
    compile_commands: Vec<String>,
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

fn relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(suffix) if suffix.as_os_str().is_empty() => ".".into(),
        Ok(suffix) => suffix.to_string_lossy().replace('\\', "/"),
        Err(_) => ".".into(),
    }
}

fn target_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() && name.len() <= 64 => chars.all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '+' | '-')
        }),
        _ => false,
    }
}

fn parse_targets(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(['\t', '#', '.']) {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        if line.as_bytes().get(colon + 1) == Some(&b'=') {
            continue;
        }
        let left = &line[..colon];
        if left.contains(['=', '%', '$']) {
            continue;
        }
        for name in left.split_whitespace() {
            if !target_name(name) || names.iter().any(|seen| seen == name) {
                continue;
            }
            names.push(name.to_string());
            if names.len() == 60 {
                return names;
            }
        }
    }
    names
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "Pods",
    "build",
    "DerivedData",
    "target",
    ".git",
    "out",
    "dist",
    "vendor",
    ".build",
];

fn descend(name: &str, depth: usize) -> bool {
    depth < 2
        && !name.starts_with('.')
        && !name.ends_with(".app")
        && !SKIP_DIRS.contains(&name)
}

fn read_targets(root: &Path, rel: &str) -> Vec<String> {
    let path = root.join(rel);
    let Ok(meta) = path.symlink_metadata() else {
        return Vec::new();
    };
    if !meta.file_type().is_file() || meta.len() > 256 * 1024 {
        return Vec::new();
    }
    std::fs::read_to_string(path)
        .map(|text| parse_targets(&text))
        .unwrap_or_default()
}

fn compile_commands(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for rel in [
        "compile_commands.json",
        "build/compile_commands.json",
        "out/compile_commands.json",
    ] {
        let path = root.join(rel);
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.starts_with(root) {
            found.push(rel.to_string());
        }
    }
    found
}

fn scan(root: &Path) -> Result<UnixProject, String> {
    fn walk(
        root: &Path,
        path: &Path,
        depth: usize,
        count: &mut usize,
        project: &mut UnixProject,
        makefiles: &mut Vec<String>,
    ) -> Result<(), String> {
        let mut has_makefile = false;
        let mut has_kconfig = false;
        let mut has_arch = false;
        let mut children = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            *count += 1;
            if *count > 5000 {
                return Err("Project scan exceeds 5,000 entries. Open a narrower folder.".into());
            }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = entry.path();
            if kind.is_file() {
                match name.as_str() {
                    "CMakeLists.txt" => push_unique(&mut project.cmake, relative(root, path)),
                    "Makefile" | "GNUmakefile" | "BSDmakefile" => {
                        makefiles.push(relative(root, &child));
                        if name == "Makefile" {
                            has_makefile = true;
                        }
                    }
                    "meson.build" => push_unique(&mut project.meson, relative(root, path)),
                    "configure.ac" | "configure" => {
                        push_unique(&mut project.autotools, relative(root, path))
                    }
                    "Kconfig" => has_kconfig = true,
                    _ => {}
                }
            } else if kind.is_dir() {
                if name == "arch" {
                    has_arch = true;
                }
                if descend(&name, depth) {
                    children.push(child);
                }
            }
        }
        if has_makefile && has_kconfig && has_arch {
            push_unique(&mut project.kernel, relative(root, path));
        }
        for child in children {
            walk(root, &child, depth + 1, count, project, makefiles)?;
        }
        Ok(())
    }
    let mut project = UnixProject {
        cmake: Vec::new(),
        makefiles: Vec::new(),
        meson: Vec::new(),
        autotools: Vec::new(),
        kernel: Vec::new(),
        compile_commands: compile_commands(root),
    };
    let mut makefiles = Vec::new();
    walk(root, root, 0, &mut 0, &mut project, &mut makefiles)?;
    makefiles.sort_by(|a, b| a.matches('/').count().cmp(&b.matches('/').count()).then(a.cmp(b)));
    project.makefiles = makefiles
        .into_iter()
        .take(8)
        .map(|path| MakefileFacts {
            targets: read_targets(root, &path),
            path,
        })
        .collect();
    for list in [
        &mut project.cmake,
        &mut project.meson,
        &mut project.autotools,
        &mut project.kernel,
    ] {
        list.sort();
    }
    Ok(project)
}

#[tauri::command]
pub async fn unix_project(
    workspace: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: String,
) -> Result<UnixProject, String> {
    let root = crate::workspace::allowed(&workspace, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || scan(&root))
        .await
        .map_err(|e| e.to_string())?
}

fn page_name(page: &str) -> bool {
    let mut chars = page.chars();
    match chars.next() {
        Some(first)
            if first.is_ascii_alphanumeric()
                && page.len() <= 64
                && !page.contains("..")
                && chars.all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '@' | '+' | '-')
                }) =>
        {
            true
        }
        _ => false,
    }
}

fn man_argv(page: &str, section: &str) -> Result<Vec<String>, String> {
    if !page_name(page) {
        return Err("Choose a man page name.".into());
    }
    if !section.is_empty() && (section.len() != 1 || !section.chars().all(|c| matches!(c, '1'..='9')))
    {
        return Err("Manual section must be 1–9, or empty.".into());
    }
    let mut args = vec!["-P".into(), "cat".into()];
    if !section.is_empty() {
        args.push(section.into());
    }
    args.push(page.into());
    Ok(args)
}

fn truncate_text(text: &str) -> String {
    let mut end = text.len();
    let mut count = 0;
    for (index, _) in text.char_indices() {
        if count == 200_000 {
            end = index;
            break;
        }
        count += 1;
    }
    if end < text.len() {
        format!("{}\n… truncated", &text[..end])
    } else {
        text.to_string()
    }
}

#[tauri::command]
pub async fn unix_man(page: String, section: String) -> Result<String, String> {
    let args = man_argv(page.trim(), section.trim())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = tool_command("man")?;
        command.args(&args);
        command.env("MANPAGER", "cat");
        command.env("PAGER", "cat");
        let output = crate::process::run(command, Duration::from_secs(20))?;
        if output.code != 0 {
            let detail = if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            };
            return Err(format!("man exited {}: {}", output.code, detail.chars().take(500).collect::<String>()));
        }
        Ok(truncate_text(&output.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pkg_argv(name: &str) -> Result<Vec<String>, String> {
    if !page_name(name) || name.contains(':') || name.contains('@') {
        return Err("Choose one pkg-config package name.".into());
    }
    Ok(vec!["--cflags".into(), "--libs".into(), name.into()])
}

#[tauri::command]
pub async fn unix_pkg_config(name: String) -> Result<Value, String> {
    let args = pkg_argv(name.trim())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = tool_command("pkg-config")?;
        command.args(&args);
        let output = crate::process::run(command, Duration::from_secs(10))?;
        if output.code == 0 {
            return Ok(json!({"found": true, "detail": truncate_text(output.stdout.trim())}));
        }
        if output.code == 1 {
            return Ok(json!({"found": false, "detail": truncate_text(output.stderr.trim())}));
        }
        Err(format!(
            "pkg-config exited {}: {}",
            output.code,
            output.stderr.chars().take(500).collect::<String>()
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makefile_targets_skip_assignments_patterns_recipes_and_directives() {
        let text = "\
all install:\n\
\techo hi\n\
CC := clang\n\
VAR = value\n\
$(NAME):\n\
%.o: %.c\n\
.PHONY: all\n\
foo.bar/baz_1+2-3:\n\
-bad:\n\
";
        assert_eq!(
            parse_targets(text),
            vec!["all", "install", "foo.bar/baz_1+2-3"]
        );
    }

    #[test]
    fn lldb_dap_is_listed_as_present_and_not_versioned() {
        assert!(VERSION_PROBES.iter().all(|probe| probe.0 != "lldb-dap"));
        assert!(PRESENT_ONLY.iter().any(|probe| probe.0 == "lldb-dap"));
        let check = present_check("lldb-dap", "lldb-dap");
        assert!(check.detail.contains("Not executed"));
    }

    #[test]
    fn man_and_pkg_config_reject_escaped_names() {
        assert!(man_argv("../etc/passwd", "").is_err());
        assert!(man_argv("a..b", "").is_err());
        assert!(man_argv("-printf", "").is_err());
        assert!(man_argv("printf", "0").is_err());
        assert!(man_argv("printf", "10").is_err());
        assert_eq!(
            man_argv("printf", "3").unwrap(),
            vec!["-P", "cat", "3", "printf"]
        );
        assert_eq!(man_argv("printf", "").unwrap(), vec!["-P", "cat", "printf"]);
        assert!(pkg_argv("--libs").is_err());
        assert!(pkg_argv("../lib").is_err());
        assert_eq!(
            pkg_argv("libcurl").unwrap(),
            vec!["--cflags", "--libs", "libcurl"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_reads_nearby_facts_and_skips_symlinks_and_generated_trees() {
        let root = std::env::temp_dir().join(format!("afteredit-unix-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("arch")).unwrap();
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("notkernel")).unwrap();
        std::fs::write(root.join("CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n").unwrap();
        std::fs::write(root.join("Makefile"), "all install:\n\techo built\nCC := clang\n").unwrap();
        std::fs::write(root.join("Kconfig"), "config SAMPLE\n").unwrap();
        std::fs::write(root.join("meson.build"), "project('sample')\n").unwrap();
        std::fs::write(root.join("configure.ac"), "AC_INIT\n").unwrap();
        std::fs::write(root.join("a/b/CMakeLists.txt"), "project(nested)\n").unwrap();
        std::fs::write(root.join("a/b/c/CMakeLists.txt"), "project(too-deep)\n").unwrap();
        std::fs::write(root.join("node_modules/CMakeLists.txt"), "project(vendor)\n").unwrap();
        std::fs::write(root.join("sub/Makefile"), "nested:\n\techo nested\n").unwrap();
        std::fs::write(root.join("notkernel/Makefile"), "all:\n").unwrap();
        std::fs::write(root.join("notkernel/Kconfig"), "config NO\n").unwrap();
        std::os::unix::fs::symlink(root.join("arch"), root.join("notkernel/arch")).unwrap();
        std::fs::write(root.join("build/compile_commands.json"), "[]\n").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("compile_commands.json")).unwrap();
        std::os::unix::fs::symlink("/tmp", root.join("escape")).unwrap();
        let root = root.canonicalize().unwrap();
        let project = scan(&root).unwrap();
        assert_eq!(project.cmake, vec![".", "a/b"]);
        assert_eq!(project.meson, vec!["."]);
        assert_eq!(project.autotools, vec!["."]);
        assert_eq!(project.kernel, vec!["."]);
        assert_eq!(project.compile_commands, vec!["build/compile_commands.json"]);
        let makefile = project.makefiles.iter().find(|item| item.path == "Makefile").unwrap();
        assert_eq!(makefile.targets, vec!["all", "install"]);
        assert!(project.makefiles.iter().any(|item| item.path == "sub/Makefile" && item.targets == ["nested"]));
        assert!(project.makefiles.iter().all(|item| !item.path.contains("node_modules")));
        assert!(project.cmake.iter().all(|path| !path.contains("a/b/c") && !path.starts_with('/')));
        std::fs::remove_dir_all(root).unwrap();
    }
}
