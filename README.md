# AfterEdit

A native developer workbench using Tauri 2, React, Monaco and a real PTY.

## Run

```sh
npm ci
npm run tauri dev
```

`./build.sh` builds a standalone debug app in one command (both frontend and
native stages). On macOS, open `src-tauri/target/debug/bundle/macos/AfterEdit.app`.
`./build.sh release` builds the optimized app; neither needs a running dev server.

`npm run dev` is a browser preview: scratch editing and developer tools work,
while files, tasks, AI and the shell require the desktop application.

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build --debug --bundles app
```

## Editing and startup

Open individual UTF-8 text files or add multiple project folders. The explorer
lists real directories, tabs retain separate buffers, and Cmd/Ctrl+S saves.
Save As creates a new file from any buffer. Existing targets must be opened and
edited using Save. Files larger than 8 MiB and binary content are rejected.
Symlink entries are hidden; backend access resolves paths against selected roots.

Saves use a temporary sibling file and rename, preserve permissions, and reject
externally changed content. Native close prompts when files have unsaved edits.
Disk buffers are session-only; the scratch buffer and UI preferences persist.
Reopen a disk file after restarting. Use Reload from disk to explicitly discard a buffer and read external changes;
there is no live filesystem watcher yet.

The application shell loads separately from Monaco. Import/render failures show
an error and recovery editor instead of clearing the workbench; preferences are
validated on load. Flex sizing provides an editor height in both terminal layouts.
These changes address identified startup failure paths. The reported white screen
still needs visual confirmation on the affected installation.

## Project, repository and directory workflows

Select a repository root as a project. AfterEdit reads `.afteredit.json` from that
root through the active file's directory. It does not read outside the selected
root. Multiple project roots can be added to the same session.

- Editor options and task names merge from parent to child.
- Rules and AI instructions replace the parent value when present.
- Task dependencies are validated for missing names and cycles.
- Task working directories are relative to the selected project root.
- Configurations reload when saved inside AfterEdit. Use Reload for external edits.

Settings can create a configuration in the selected directory from presets for
Cargo, Go, CMake, Make, Maven, Gradle, npm, pnpm, Yarn, Bun, Composer, Python,
uv, Perl and Bash. HTML/CSS applications use their project's web build tool.
Toolchains must already be installed. Supply an absolute executable path or `PATH`
in `env` if launching from Finder does not expose your toolchain. Projects may use
any executable/arguments, including container CLIs and agent CLIs; versions and
package-manager environments are managed by those tools.

Example `.afteredit.json`:

```json
{
  "editor": { "fontSize": 14, "tabSize": 4, "wordWrap": "off" },
  "tasks": {
    "build": { "command": "cargo", "args": ["build"], "cwd": "backend" },
    "test": { "command": "cargo", "args": ["test"], "cwd": "backend", "dependsOn": ["build"] },
    "web": { "command": "npm", "args": ["run", "build"], "cwd": "frontend" }
  },
  "rules": [
    { "event": "save", "pattern": "backend/**/*.rs", "tasks": ["test"] }
  ],
  "instructions": "Explain proposed changes and suggest tests before editing."
}
```

Build Workflows shows commands for review. Trust the current scope and click Run.
Tasks execute without shell interpolation, in dependency order, stopping on failure.
Use an explicit shell executable when a task needs shell syntax. Output streams to
the task log (last 200,000 characters); Stop kills the process group on Unix and
process tree on Windows. Tasks time out after 15 minutes. Use the terminal for
interactive tasks and long-lived development servers.

Rules accept `save` or `manual`, with `*`, `**`, and `?` path globs. Save rules queue
matching tasks for an explicit Run action. Opening a repository never runs its
commands. Trust resets when the project scope/configuration changes.

## BYOK and agents

The AI panel sends requests through the native HTTP client to a user-configured
OpenAI-compatible Chat Completions or Anthropic Messages endpoint. Enter an endpoint, model ID and key;
keys stay in memory and are never written to preferences or project files.
Remote endpoints require HTTPS; local HTTP is supported. Redirects are disabled.
OpenAI-compatible endpoints can use `max_tokens` or `max_completion_tokens` and
return `choices[0].message.content`. Anthropic uses its Messages protocol and text
content blocks. Requests are non-streaming.

The active file is included only when explicitly selected. Effective project
instructions are displayed and included. Requests have a 120-second timeout,
256 KB input limit and 2 MB response limit.

Daily request caps and reservation-unit caps are enforced before sending and stored
in the native app-data directory (`ai-usage.json`, with a cross-process lock).
A unit reservation is input UTF-8 bytes + max output tokens + 1,024. Reservations
remain charged on failures/timeouts and reset on the next UTC day. They are local
app usage controls, not exact token counts or provider dollar-budget guarantees.
Users can change their caps. No paid provider calls are made by the test suite.

Agent runs loop through model requests and tool observations with separate step
and reservation caps, enforced together with daily caps before each request.
The model can read existing project files, propose unique exact-text replacements,
and request named configured tasks. Reads require approval unless enabled for the
run; edits and tasks always require review. Task environment values are not sent
as model task metadata. File reads remain within the selected project root.
Approved edits update unsaved buffers; use Save all modified project files before
approving a build. Saves retain external-change checks. Stop prevents subsequent
actions and cancels a running task; an in-flight model request may finish and
retains its reservation. Keys and provider settings are captured for each run.

This is a reviewed agent workflow, without arbitrary shell tools or unattended
edits. Interactive agent CLIs can also run in the terminal; their billing and limits
are separate. Provider calls and the complete agent UI have not been live-tested.

## Extensions and language services

Executable VS Code extensions **do not run in this build**. Monaco is an
editor component, not the VS Code extension host. A compatible host, API layer,
lifecycle management and extension testing are required before exposing installs.
Open VSX search and import are available for declarative themes and snippets. Microsoft Marketplace use
also has product restrictions; no Marketplace API is configured.

See the [Monaco FAQ](https://github.com/microsoft/monaco-editor#faq) and
[VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq).

Bundled tokenizers cover many languages, with additional TOML, Makefile, Groovy and
Rego definitions. Monaco supplies JS/TS, JSON, CSS and HTML worker services.
Other languages can connect installed LSP servers through Language Services.
Diagnostics, completion, hover, definition and document formatting are supported
when advertised by the server. Refactoring/code actions and debugging are not yet supported. Git/search/debug sidebar
placeholders and the simulated AI status have been removed. Monaco's in-file
find remains available. Integrated Git, DAP, remote development,
and extension hosting are future work.

The CLI interceptor in `src-tauri/afteredit-cli.sh` is still a sketch. Do not install
it as `$EDITOR` yet.

## Personal preferences and legacy keymaps

Settings now includes searchable editor preferences and JSON import/export. Personal
settings sit beneath root/directory overrides. Preferences include font family,
size and ligatures, line height, indentation, wrapping, relative line numbers,
minimap, whitespace, cursor style/blinking, folding, bracket colors, sticky scroll,
smooth scrolling and save cleanup. Built-in light/dark and high-contrast themes
are available. Choose `standard`, `vim` or `emacs` under keymap.

Vim uses monaco-vim (normal/insert/visual modes, motions, search, :w); Emacs uses
monaco-emacs (navigation, mark, kill/yank, C-x C-s). Adapters load only when selected
and dispose on mode/view changes. These are editor keymaps, not embedded Vim/Emacs
runtimes: vimrc, Emacs Lisp and arbitrary editor plugins are not supported.
The Commands button provides access even when a legacy binding takes a shortcut.


### Supported extension contributions and project search

Extensions can import local VSIX files or search/download from Open VSX. Supported
packages contain only theme/snippet contributions, with no executable entry point
or extension dependencies. Enable/disable/remove controls persist locally. Snippets
use Monaco's snippet insertion; theme UI colors and simple token scopes are mapped,
while TextMate grammar fidelity and theme `include` files are not yet supported.
Import limits: 20 MiB compressed, 2 MiB per JSON file, 10 MiB total selected JSON.
Contribution paths cannot escape the archive's extension directory. Imported files
are parsed as data and are never executed or extracted onto the filesystem.

Project search is literal/case-sensitive, bounded to 200 matches, 20,000 entries
and three seconds. It skips symlinks, generated/vendor directories, binary content
and files over 1 MiB. Results open the matching line. Extension data is stored in
local application preferences; a storage-capacity error is shown if it cannot fit.

### Named workflows and task tuning

Add `"workflows": { "ci": ["test", "web"] }` to name a pipeline. Dependencies run
once in order and failures stop the pipeline. Rules can set `enabled: false` or
`exclude: ["vendor/**", "**/generated/**"]`. Tasks accept `timeoutSeconds` (1–3600;
default 900). Arguments, working directories and environment values may reference
`${project}`, `${file}`, `${relativeFile}`, and `${fileDir}`. Substitution preserves
literal argument boundaries; shell interpretation occurs only if you explicitly
configure a shell command. File variables require an active disk file.
The workbench records the last 30 workflow outcomes, filtered by project.


### Native language services

Language Services connects up to eight installed stdio LSP servers, with project
root, executable, arguments, environment and initialization options. Common server
presets cover Rust, Go, C/C++, Java, Python, PHP, Perl, Groovy, Bash, JS/TS, HTML and
CSS. Java/Groovy may require installation-specific paths and arguments. Connections
are explicit; opening a project never executes its configured server automatically.

Example: `"languageServers": { "go": { "command": "gopls", "args": ["serve"] } }`.
Personal toolchain bin directories are searched for GUI launches. Servers must use
UTF-16 positions. The client sends open/change/save/close notifications, handles
full or incremental synchronization, and exposes advertised diagnostics, completion,
hover, definitions and formatting through Monaco. Arbitrary server workspace edits
and executable completion commands are not applied. Dynamic registration, semantic
tokens, rename/code actions and DAP debugging remain unsupported. Disconnected
servers can be removed and reconnected in the Language Services panel.

Settings detects build manifests in the current explorer directory, including mixed
language projects. Presets configure commands; toolchain installation/version selection
remains the responsibility of the project's existing build tools.
