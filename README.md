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
Projects, open file paths and the active tab are restored from a native session
file on restart. Saved paths are reauthorized by the backend; missing paths and
retargeted symlinks are skipped. File contents are reread from disk: unsaved disk
buffer edits are not persisted. Restoration is bounded to 100 files, 20 projects
and 16 MiB of text. Scratch and personal preferences persist separately.

The active disk file is checked every three seconds and when the app regains focus.
Clean buffers reload external changes. Dirty buffers retain your edits and show
the current disk version for review. Choose Reload to discard your edits, Keep my
edits to accept the reviewed disk version as the save baseline, or Save as to make
a separate file. Saves still reject later external changes. This is active-file
polling, not a recursive filesystem watcher.

The application shell loads separately from Monaco. Import/render failures show
an error and recovery editor instead of clearing the workbench; preferences are
validated on load. Flex sizing provides an editor height in both terminal layouts.
A failed workbench import or a 20-second startup timeout opens a plain-text
recovery editor. Add `?safe=1` to the app URL to bypass the workbench, extensions,
and session restoration while preserving preferences. Recovery edits the local
scratch buffer. Browser regression tests deliberately block workbench/editor
imports and verify recovery remains usable.
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
content blocks. Chat can stream OpenAI-compatible or Anthropic SSE responses; JSON responses
remain supported. Stop response cancels the native in-flight request and keeps
partial output. Stream errors or missing completion markers are reported explicitly.
Agent actions are parsed only after a complete response; Stop run also cancels its
current provider request. Usage reservations remain charged after cancellation.

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

An **experimental VS Code web-extension editor** is available under Extensions.
It uses pinned `@codingame/monaco-vscode-api` services and the VS Code web-worker
extension host in a separate editor frame. The regular editor remains the default.

Search Open VSX and select **Install / update**, or import a `.vsix`. Themes and
snippets continue to work in the regular editor. Packages with a `browser` entry
can be imported disabled; choose **Enable and trust code**, then **Open experimental
VS Code editor**. Use its command selector to activate an extension command. Updating,
disabling or removing a package recreates the compatibility frame when opened.
There is no background update service. Package data uses local browser storage;
large installs can exceed its quota and will fail with an explicit message.

| Extension capability | Prototype support |
| --- | --- |
| Themes and snippets | Existing regular editor integration |
| Browser entry, commands, configuration, language registration, keybindings | Experimental VS Code runtime |
| Formatters/completion providers registered through the web API | Formatter registration and edits tested with the browser fixture; other providers need extension-specific verification |
| Desktop Node entry only, dependencies, proposed APIs | Rejected |
| Debuggers, TextMate grammar packages, webviews and other contribution types | Rejected |

The compatibility editor shares the active buffer with AfterEdit; Save and Cmd/Ctrl+S
use existing native conflict checks. It exposes no native project filesystem or task
bridge, and only the current document model. It supplies the selected project as workspace
identity, without granting native filesystem access. Extension settings can be
edited as JSON/JSONC under Extensions, and changes made through the VS Code global
configuration API persist across restarts. Standard keybindings and basic editor
preferences apply there; Vim/Emacs, native LSP connections and existing themes remain
in the regular editor. Full workspace filesystem APIs remain outside this prototype. Use the standard editor to return without discarding the buffer.

Browser extensions execute code: enable only trusted packages. A web worker is not
a general security sandbox. The native CSP permits `unsafe-eval` because VS Code's
worker loads CommonJS extension bundles with `new Function`; data/blob reads are permitted for registered package resources. Extension files
use data URLs compatible with the worker iframe policy. Native IPC APIs are not supplied to the
extension API. Remote network availability depends on the host's CSP.

Microsoft Marketplace is not configured: Microsoft's published FAQ excludes
alternative editors from accessing it without separate authorization. Open VSX is
our registry; individual extension licensing and API compatibility still apply.
See [Microsoft's FAQ](https://code.visualstudio.com/docs/supporting/faq),
[Open VSX](https://open-vsx.org/), and the
[runtime project](https://github.com/CodinGame/monaco-vscode-api).

To build validation packages, run `node scripts/build-extension-fixtures.mjs`.
Import `/tmp/afteredit-extension-fixtures/web.vsix`, enable it, open a plain-text
buffer in the experimental editor, and run **Test extension activation**. The
expected result is “VS Code extension activated successfully”. Run **Test formatter:
uppercase buffer** to verify provider registration, model access and buffer edits,
then save and return to the standard editor. The `desktop.vsix` and `debugger.vsix`
fixtures must be rejected. Run the real-extension browser checks with `npm run test:extensions`. Unit tests cover
package validation and persistence; successful bundling is not an activation test.

Bundled tokenizers cover many languages, with additional TOML, Makefile, Groovy and
Rego definitions. Monaco supplies JS/TS, JSON, CSS and HTML worker services.
Other languages can connect installed LSP servers through Language Services.
Diagnostics, completion, hover, definition and document formatting are supported
when advertised by the server. Refactoring/code actions are not yet supported. The native Run and debug panel provides DAP debugging independently of executable extension support. Monaco's in-file find remains available. Remote development and desktop extension
hosting are future work.

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
tokens and rename/code actions remain unsupported by the LSP client. Native DAP
debugging is provided separately by Run and debug. Disconnected
servers can be removed and reconnected in the Language Services panel.

Settings detects build manifests in the current explorer directory, including mixed
language projects. Presets configure commands; toolchain installation/version selection
remains the responsibility of the project's existing build tools.


## Editing assistance

The regular Monaco editor pairs braces, brackets, parentheses and quotes according
to language rules. Preferences now expose auto-closing, surrounding selections,
auto-indent and Tab completion controls. Two-space indentation is the default; Detect indentation can adopt an existing file’s indentation.
For visual double spacing, set line height explicitly (for example 28 px with a
14 px font); this changes rendering, not file contents.

Bash snippets expand `if`, `for`, `while` and `case` into complete blocks. With Shell
block completion enabled, Enter at the end of a completed header inserts `fi`,
`done` or `esac`, with the cursor on an indented body line. It avoids adding a
terminator already present below. This is conservative header matching, not a
complete shell parser. Automatic Enter expansion is disabled in Vim mode; snippets
remain available. These built-ins apply to the regular editor, not the experimental
extension frame.

## Native Run and debug

Open a project, save its files, then use Run and debug. Choose or edit an adapter
configuration, review it, and check Trust and run before Start. AfterEdit supports
one native DAP session at a time, either a launched stdio adapter or an existing
adapter listening on a localhost TCP port. Install adapters separately.

The panel includes gutter/line breakpoints, conditional and hit-count breakpoints,
logpoints, exception-filter IDs, continue/pause/step controls, thread selection,
call stacks, scopes, expandable variables, variable editing when supported, and
expression evaluation with one watched expression refreshed on each pause. Variable
and stack references are discarded on resume. Views page the first 100 stack frames
and first 200 variables; variable trees expand to eight levels. Breakpoints refer
to saved line numbers: recheck them after structural source edits.

Adapter capabilities gate optional operations. Launch configuration waits for the
adapter's initialized event before breakpoints/configurationDone, without waiting
for a launch response that may itself depend on configurationDone. Stop disconnects
and closes our adapter; attach requests leave the target running where the adapter
supports that behavior. Reverse requests including runInTerminal are not implemented.
Use internalConsole or an existing target/adapter. Memory views, disassembly,
reverse debugging, multi-session orchestration and debugger-extension installation
are not included.

Project/directory `.afteredit.json` can define named `debug` configurations:

```json
{
  "debug": {
    "native": {
      "adapter": { "command": "xcrun", "args": ["lldb-dap"] },
      "request": "launch",
      "configuration": {
        "program": "${workspaceFolder}/build/program",
        "cwd": "${workspaceFolder}",
        "stopOnEntry": true
      }
    }
  }
}
```

`${workspaceFolder}` and `${file}` expand recursively as literal values. Local
configuration can also be saved per project in the panel. Go/Delve and js-debug
presets connect to existing localhost DAP servers; they do not start those servers.

The LLDB integration test is opt-in:
`cargo test --manifest-path src-tauri/Cargo.toml lldb_breakpoint_stack_variables_and_step -- --ignored`.
It builds a local C fixture and checks a breakpoint, stack, variable, expression,
step and exit. Native launch verification can require macOS developer debugging
permission. UI interactions still require manual testing in the packaged app.

## Terraform, OpenTofu and Ansible

Infrastructure is a built-in workbench page. It recognizes Terraform/OpenTofu
configuration, variable and state filenames and Ansible playbook/role conventions.
HCL and Ansible block snippets ship with the editor. Ansible uses the bundled YAML
tokenizer with a distinct language ID; generic YAML files retain YAML mode.

Select a tool and action, review the exact command/dependency list, and enable trust
before running. No command runs when merely opening the page. Built-ins include:

- Terraform/OpenTofu: format, format-check, backend-disabled init plus JSON
  validation, TFLint, plan/trace-plan, existing plan JSON and native CLI tests.
- Ansible: syntax check, offline ansible-lint SARIF, check/diff, list-tasks and an
  Ansibug listener for debugging.

Terraform/OpenTofu validation JSON, TFLint JSON and ansible-lint SARIF map to clickable
Problems entries and editor markers. Editing clears inline markers; the Problems
list represents the last disk check. Checks require saved project buffers.
Tool output remains visible when diagnostics have no source location or parsing
fails. CLI tools, providers, lint rules, language servers and Ansible collections
are external dependencies; bundling their workflow does not install them.

Creating a scoped configuration from these presets also includes terraform-ls,
tofu-ls or ansible-language-server settings. Connect that server explicitly under
Language services. HCL tokenization maps to the appropriate Terraform/OpenTofu LSP
language ID. `.tf` projects may be either Terraform or OpenTofu, so detection offers
both rather than selecting an engine automatically.

Terraform/OpenTofu debugging uses trace logs and plan inspection; declarative
configuration has no DAP source stepping. Provider source can be debugged separately
with Go tooling. Plans and trace logs can contain sensitive data. Trace/plan actions
use your configured backend; validation initialization explicitly disables it.

For Ansible task stepping, install Ansibug in a Python environment containing
Ansible. Start `debug-listen` from Infrastructure (localhost port 4712), then use
Run and debug's Ansible attach preset. The listener remains running when switching
views; stop it from Infrastructure. Use matching Python executable paths in the
workflow and adapter when virtual environments are involved. Ansibug launch requires
runInTerminal, so this version uses its supported attach flow. Ansible check mode
follows each module's check-mode behavior and is not a universal no-side-effects
sandbox. No remote playbook or infrastructure apply is run by the test suite.

`node scripts/test-infrastructure.mjs` checks real Terraform/OpenTofu diagnostics
against a provider-free invalid fixture and Ansible syntax against a localhost
playbook. The unit suite separately covers SARIF/TFLint parsing and path confinement.

References: [DAP lifecycle](https://microsoft.github.io/debug-adapter-protocol/overview),
[Ansibug attach](https://jborean93.github.io/ansibug/),
[OpenTofu validation](https://opentofu.org/docs/cli/commands/validate/),
[OpenTofu language server](https://github.com/opentofu/tofu-ls),
[Ansible lint formats](https://docs.ansible.com/projects/lint/usage/).


### Verification status (2026-09-10)

Before the workbench batch, 54 frontend tests and 10 native unit tests passed,
and the frontend production build passed. Live Terraform and OpenTofu validation returned the expected source-linked
errors from provider-free fixtures; a localhost Ansible playbook passed syntax
checking. TFLint, ansible-lint and Ansibug are not installed here, so their integrations
have parser/preset coverage but no live tool run.

The release-hardening pass subsequently passed the live LLDB launch test on this
host: source breakpoint, stack, variable value, expression evaluation, stepping
and normal termination. No developer-mode setting was changed during that pass.
The packaged debugger and infrastructure UI still need hands-on verification.
See [release checks](RELEASE-CHECKS.md) for current commands and evidence.

## Accessibility

Settings → Accessibility provides whole-app zoom, workbench contrast,
screen-reader support, reduced motion, large cursors and optional sound cues.
F6 / Shift+F6 cycles workbench regions. Commands supports keyboard filtering and
focus restoration. The editor exposes diagnostics and indentation reporting;
the terminal offers static output review; AI edits have sequential text review.

See [the accessibility guide](ACCESSIBILITY.md) for controls, limitations,
automated checks and the native screen-reader validation checklist.

## Source control

Select a repository's top-level folder and open Source control. Refresh shows the
branch and individual staged/working-tree states, including untracked files and
renames. Review working or staged diffs; untracked contents can be opened in the
editor. Diff helpers and external text conversions are disabled. Output is bounded
to 2 MB and Git commands time out after 30 seconds.

Stage/unstage operates on one listed file (including the source of a rename).
Save open buffers before staging. Enter a commit message, review all staged changes,
then Commit reviewed changes. The backend checks the reviewed tree and commits
a separate index snapshot, preserving concurrent staging and working-tree edits.
Normal Git hooks still run. Conflicts, identity/signing problems and hook failures
are shown in the panel. Push, pull, merge, history and branch switching are not
included in this batch.

## Infrastructure tool checks

Check installed tools shows executable paths and version results for Terraform,
OpenTofu, TFLint, Ansible, ansible-lint and Ansibug. Each action checks its required
tools before running; missing or unusable tools are reported without installing
software. Version checks run outside the project and have five-second timeouts.
Ansibug is checked in the python3 environment selected by the application's PATH.

The infrastructure smoke script exercises installed tools and explicitly reports
optional missing tools as skipped. A successful module check alone does not verify
a complete Ansibug debug session.

## Workbench batch verification

The automated checks include native temporary-repository Git operations, session
permission restoration, external-file conflict reconciliation, split SSE decoding,
and cancellation. Browser tests cover startup recovery, file conflicts, Git review
gating and partial-response cancellation with a mock native backend. The production
extension suite imports a real VSIX and exercises activation, formatting,
keybindings, configuration persistence and workspace identity.

Run `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`,
`npm run test:a11y`, and `npm run test:extensions`. The extension suite builds
production assets before testing to avoid development-server dependency reloads.
The existing opt-in LLDB and clangd tests remain separate. Native desktop UI,
VoiceOver/NVDA and paid provider endpoints still require hands-on verification;
the original affected-installation white-screen report is not independently
confirmed resolved.

Batch results: **58 frontend unit tests, 19 native tests, 11 workbench browser tests
and 3 production extension tests passed**. The production build passed. Two existing
native integration tests were skipped by default. Live Terraform/OpenTofu validation
and Ansible syntax checks passed; TFLint, ansible-lint and Ansibug were unavailable.


Release-hardening results: **63 frontend/process tests, 22 native tests, 12
workbench browser tests and 5 production smoke tests passed**. The live LLDB
integration test passed separately. AI tests now use local HTTP servers to verify
both provider protocols and cancellation closing a connection. Run
`npm run test:release` and `npm run test:infrastructure` for the added release
checks. Native screen-reader verification remains open because this automation
session lacks macOS Accessibility access. See [RELEASE-CHECKS.md](RELEASE-CHECKS.md).

## Apple development

The Apple development page supports Swift/SourceKit setup, Xcode project and
scheme/target/destination selection, reviewed builds/tests with diagnostics and
result bundles, simulator and connected-device commands, LLDB configuration,
signing overrides, archive/export, and Xcode designer handoffs. SwiftUI Canvas
and Interface Builder run in Xcode. See [Apple development](APPLE-DEVELOPMENT.md)
for setup, verification commands and the remaining live-validation limits.
