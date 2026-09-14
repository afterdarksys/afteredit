# AfterEdit shared CLI prototype

The prototype provides a headless workspace service, a plain terminal editor, an optional full-screen terminal editor, and a GUI **Shared workspace** panel. All three clients address the same versioned buffers through the same service API.

## Try it

```sh
npm run cli:build
./bin/afteredit --help
./bin/afteredit .
./bin/afteredit README.md --plain
./bin/afteredit README.md --tui
```

The repository launcher uses the locally built CLI. Add this repository's `bin` directory to PATH to use `afteredit` elsewhere. It prefers the debug binary when both builds exist. The regular desktop executable also accepts these commands; starting it without arguments opens the GUI, and `--gui` explicitly opens the GUI.

Opening a local workspace automatically starts or joins its service. To keep a server in the foreground:

```sh
./bin/afteredit --server --workspace /absolute/project
```

In the desktop GUI, open a project, choose **Shared workspace** in the navigation or command palette, and select **Start or join current workspace**. Open the same file from the CLI and this panel. The panel shows the socket endpoint for explicitly connecting another client:

```sh
afteredit --connect /path/shown/by/gui.sock
afteredit --connect /path/shown/by/gui.sock buffer list
afteredit --workspace /absolute/project edit README.md --wait
```

`--wait` returns after the open buffer advances to a saved revision. Ctrl-C cancels the wait. The service remains running when a client exits. `afteredit --workspace /absolute/project stop` stops it; dirty buffers require `stop --force`, which retains recovery data.

## Plain editor: the accessible default

Plain mode uses ordinary line input and readable output, without cursor repainting, ANSI escape sequences, alternate screens, or mode switching. It works with a terminal screen reader or piped commands. Type `help` at any prompt.

| Command | Action |
| --- | --- |
| `files`, `buffers`, `open PATH`, `new PATH` | Browse files, switch shared buffers, create an empty file |
| `show`, `show 20` | Read numbered lines (up to 200 per whole-buffer display), or one line |
| `append TEXT`, `replace 3 TEXT`, `insert 3 TEXT`, `delete 3` | Edit lines; replacement preserves existing newline style |
| `find TEXT`, `search TEXT` | Search this buffer or the workspace, including shared drafts |
| `save`, `undo`, `redo`, `diff`, `status`, `refresh` | Save, review, navigate shared history, or fetch another client's revision |
| `diagnostics`, `symbols QUERY` | Inspect a connected language service |
| `run TASK` | Review a configured task plan |
| `rpc METHOD JSON` | Access an explicitly named service capability |
| `quit` | Leave shared drafts on the service |

Each edit is immediately published to the shared draft; `save` writes it to disk. An edit based on an old revision fails with a conflict. `refresh` fetches the current shared version. Previously published text remains in the bounded undo history.

The GUI uses a standard labeled textarea, native buttons, polite status messages and an explicit conflict region. **Publish draft** shares text; **Save shared file** also saves to disk. Conflicts preserve local text and display the remote revision; **Download draft copy** exports local work before replacing it. Navigation keeps the panel mounted, and unpublished GUI text participates in the desktop close confirmation.

This is an accessibility-oriented prototype, not a claim of completed VoiceOver, NVDA or braille-device acceptance testing. Those user evaluations are still needed.

## Optional visual editor

`--tui` is deliberately opt-in. Type normally; arrows move the cursor; Backspace deletes; Ctrl-S saves; Ctrl-Q publishes the current draft and exits. Ctrl-Z and Ctrl-Y undo/redo shared revisions. Ctrl-P opens discoverable commands:

- `help`, `refresh`, `undo`, `redo`
- `find TEXT`, `line N`, `diagnostics`, `symbols QUERY`
- `export PATH` writes a new private local recovery copy without overwriting an existing file.
- `leave without publishing` explicitly exits without publishing local changes. Use export first when a conflict or disconnected server prevents publication.

This first visual surface has basic rendering: advanced selection, syntax coloring, wide-character layout, horizontal scrolling, mouse editing and fine-grained undo grouping remain future work. Plain mode is the recommended screen-reader surface.

## Tasks, language services and debugging

The service reads the workspace root's `.afteredit.json` and reuses AfterEdit's native task, language-server and debug-adapter engines. Connecting never starts project commands automatically.

```sh
afteredit --workspace /project run test                 # review resolved dependency plan
afteredit --workspace /project run test --approve       # run that current plan
afteredit --workspace /project runs                    # output, status, exit code, service run ID
afteredit --workspace /project cancel 2                # cancel service run 2

afteredit --workspace /project language typescript --approve
afteredit --workspace /project diagnostics
afteredit --workspace /project symbols Parser

afteredit --workspace /project debug start native --approve
afteredit --workspace /project debug threads
afteredit --workspace /project debug request stackTrace '{"threadId":1}'
afteredit --workspace /project debug request scopes '{"frameId":1}'
afteredit --workspace /project debug request variables '{"variablesReference":1}'
afteredit --workspace /project debug stop
```

Use IDs returned by your actual adapter, rather than assuming the example IDs. `debug.request` supports breakpoints, stepping, evaluation and optional inspection operations such as memory, disassembly and reverse execution when the adapter supports them. `events` exposes bounded task/LSP/DAP activity with sequence cursors. `task.list` retains the last 20 runs. Supported test reporters stream their structured output through the task engine.

The GUI's **Workspace capabilities and commands** section discovers available methods, accepts JSON parameters, previews the exact request and executes it. This provides GUI access to the same search, Git, task, language and debugging operations. Existing dedicated GUI monitoring/debugger panels continue to manage their own sessions; they do not yet subscribe to this service.

Task execution requires the exact approval value from `task.plan`; a changed configuration invalidates an older approval. Commands run with their arguments without an implicit shell. Root-level task dependencies and `${project}`/`${workspaceFolder}` expansion are supported. `${file}` is rejected because a shared session has no single active file. Existing production-context challenges require `--confirm CONTEXT`. Tasks and debug launches require saved shared buffers. Git staging requires `--approve` and a saved shared buffer.

Language operations return protocol data; workspace edits from rename/formatting are not automatically applied. One language server and one debug session can run per workspace service. Stop the workspace service to replace its language server.

## API and SSH

```sh
afteredit --workspace /project capabilities --json
afteredit --workspace /project rpc events '{"after":0}' --json
afteredit --workspace /project buffer open README.md --json
afteredit --workspace /project buffer set README.md --revision 1 --text 'new text' --json
afteredit --workspace /project buffer save README.md --revision 2 --json
```

Local IPC uses one newline-delimited JSON request per Unix-socket connection:

```json
{"method":"buffer.get","params":{"path":"README.md"}}
```

Replies are `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. `capabilities` enumerates protocol version 1, supported methods, root, limits and language/debug connection state. Mutating existing buffers requires their current `version`. The service rejects stale versions and checks the original disk content before saving.

Remote transport is implemented through SSH, requiring an installed `afteredit` command on the remote PATH:

```sh
afteredit --connect ssh://my-server/absolute/project --plain
```

The GUI accepts the same endpoint. SSH uses existing key authentication and known-host configuration, with batch mode and connection/keepalive timeouts. Set up authentication separately; the GUI does not prompt for SSH credentials. The SSH gateway forwards protocol messages through `afteredit --stdio`, keeping the workspace and tool processes remote. This transport has not yet been validated against a real remote host.

## Prototype boundaries and recovery

- Local sockets and visual terminal mode currently support macOS/Linux. Windows named-pipe support is not implemented.
- GUI Files/Monaco tabs still own separate drafts. Use **Shared workspace** for shared editing; disk conflict detection protects saves between surfaces.
- Socket directories are private (0700), sockets are 0600, and filesystem operations are confined to the selected root. Project processes still execute with the current user's permissions.
- A buffer is limited to 1 MiB of UTF-8 text, with at most 20 open buffers. Each undo/redo stack is bounded to 20 revisions and 2 MiB. Recovery is capped at 16 MiB per workspace; hitting the cap rejects edits rather than silently dropping recovery.
- Recovery is stored alongside the socket in a private temporary directory. It survives service restarts, including unsaved text and undo history, but is not a permanent backup: operating-system cleanup may remove it. Save important work or export a recovery copy. A removed file or invalid recovery document may prevent restoration; retain the recovery JSON for manual recovery.
- Event history is bounded to 300 entries; oversized events are summarized. Search is capped at 10,000 entries/200 hits. JSON frames are limited to 8 MiB.
- Shared history records published whole-buffer revisions. Full collaborative merging, multi-cursor editing, extension hosting, plugin parity and automatic GUI-session migration are not part of this first prototype.

## Verification

```sh
npm run cli:build
npm run test:cli
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm test
npm run build
npm run test:a11y -- tests/shared-workspace.spec.ts
python3 scripts/test-cli-tools.py # optional macOS/Xcode clangd + LLDB integration
```

The process test covers real private IPC, two-client version conflicts, restart recovery, external disk conflicts, task execution/cancellation, plain editing, `--wait`, full-screen editing in a pseudo-terminal and file creation. The GUI browser test covers publication, incoming conflicts, draft export, keyboard save and retention across navigation.
