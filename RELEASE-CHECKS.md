# Release checks

## 2026-09-26 save-safety verification

This pass fixes the four save-safety findings and adds seven production-browser
regressions in `tests/save-safety.spec.ts`. Native mocks now explicitly handle
draft storage, worktree lists and task challenges; unknown commands reject.

Verified on macOS 15.7.4 (24G508):

- `npm test`: 173 passed.
- `npm run test:release -- --workers=2`: 21 passed, including all seven new
  save-safety tests. Uses Chromium with mocked native IPC.
- `npm run test:a11y -- --workers=2`: 27 passed, 4 timed out waiting for initial
  editor readiness while a release build was also running. All four passed on
  `--workers=1 --last-failed` with unchanged assertions. This covers keyboard
  focus, preferences, screen-reader editor mode, Git/menu workflows, shared
  buffers, debug controls and startup recovery in Chromium. Native VoiceOver
  remains unverified; concurrent build load makes dev-server startup tests flaky.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 167 passed, 5 opt-in tests
  ignored. Run outside the workspace sandbox because loopback sockets and
  nested `sandbox-exec` otherwise fail for environmental reasons.
- The opt-in `lldb_breakpoint_stack_variables_and_step` test passed using real
  Xcode LLDB: source breakpoint, threads, stack, local variables, watch, step,
  continue and termination. This verifies the native adapter, not its GUI.
- `./build.sh release`: passed; produced the optimized standalone macOS app.
  Installed `/Applications/AfterEdit.app` from source revision `ba7cfb8` (version
  remains 0.1.0). A recursive comparison matched the built and installed bundles.
  Installed executable SHA-256:
  `6245d416342c62552c89c3cfe65b4ccd34a5d8ee4106e7ac5f412a12a03a020f`.
- `scripts/test-cli.py` with `AFTEREDIT_TEST_BINARY` pointing to that installed
  executable: passed private IPC, version conflicts, shared-buffer recovery,
  real disk conflict/saves, task execution/cancellation, plain editing, wait,
  PTY/TUI editing, file creation, delayed IPC frames and automatic service startup.
- `scripts/test-cli-tools.py` against the same installed executable: passed real
  clangd symbols and LLDB launch, breakpoint, threads, stack, scopes and variables.

Native observation remains limited: both `AXIsProcessTrusted()` and
`CGPreflightScreenCaptureAccess()` returned false for this session. Do not count
process liveness, CLI checks or browser fixtures as evidence of native rendering
or VoiceOver behavior. Outstanding hands-on checks after installing this build:

- [ ] Native window renders correctly, including the previously reported blank window.
- [ ] Open/edit/save/reopen a disposable file in the main editor.
- [ ] Restart and confirm session and dirty-buffer recovery in the main editor.
- [ ] Exercise stale formatting, external disk conflicts and terminal continuation.
- [ ] Review/stage/commit a disposable Git change through the native UI.
- [ ] Run `printf 'AfterEdit shell check\\n'` in the native terminal.
- [ ] Launch, break and step using the native debugger panel.
- [ ] Keyboard navigation and VoiceOver in the native webview.

The CLI integration scripts also accept `AFTEREDIT_TEST_BINARY`, so the installed
app's executable can be tested without substituting a development binary:

```sh
AFTEREDIT_TEST_BINARY=/Applications/AfterEdit.app/Contents/MacOS/afteredit python3 scripts/test-cli.py
AFTEREDIT_TEST_BINARY=/Applications/AfterEdit.app/Contents/MacOS/afteredit python3 scripts/test-cli-tools.py
```

Those scripts use disposable workspaces for shared-buffer editing, real disk
saves, recovery, task execution/cancellation, a PTY/TUI, clangd and LLDB. They do
not exercise the main editor's webview or its independent buffer state.

## Repeatable checks

Run `npm run test:release` for production-bundle startup, recovery, restored file
editing/saving, Git review gating, AI cancellation and terminal focus. The native
IPC boundary is mocked in these browser tests; they do not validate the OS webview,
real disk writes or a live shell. Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select an
installed Chromium.

Build the native macOS application with `npm run tauri build -- --bundles app`.
The bundle is `src-tauri/target/release/bundle/macos/AfterEdit.app`. A successful
build alone does not establish that the native workbench renders or is accessible.

For a hands-on native smoke check, open the bundle, open a temporary project,
edit/save/reopen a file, restart and confirm session restoration, review/stage/commit
a disposable Git change, and run `printf 'AfterEdit shell check\n'` in the terminal.
Repeat startup in recovery mode if normal startup fails. Record the OS version,
bundle commit, observed result and any startup error; do not use a development
server as evidence that packaged startup works.

## Debugger

`cargo test --manifest-path src-tauri/Cargo.toml lldb_breakpoint_stack_variables_and_step -- --ignored --nocapture`
passed on this macOS host on 2026-09-10: launch, source breakpoint, threads, stack,
local value `42`, watch evaluation, step over, continue and normal termination.
The earlier launch timeout did not recur. This opt-in test requires Xcode LLDB and
permission to debug a temporary local C program; it is not a native UI test.
Startup cancellation and adapter-close regressions are covered by frontend tests.

## AI transport

`cargo test --manifest-path src-tauri/Cargo.toml ai::` exercises real loopback
HTTP requests with OpenAI-compatible and Anthropic-shaped fixtures. It checks
request authentication/token fields, SSE text delivery, JSON fallback, HTTP errors,
malformed/incomplete responses, and socket closure on cancellation. No paid API
keys are used. These checks validate transport behavior, not provider availability
or model quality; ledger reservation tests run alongside them.

## Infrastructure

`npm run test:infrastructure` runs temporary local fixtures. Terraform and OpenTofu
must reject a missing variable with source diagnostics. Ansible must accept the
valid playbook and reject malformed YAML with its filename. Optional TFLint and
ansible-lint checks require JSON diagnostics and a recognized exit status; an
installed tool with a failing version check fails the suite. Ansibug is probed
for its installed module version only, not a live attach session.

On 2026-09-10 Terraform, OpenTofu and both Ansible syntax cases passed. TFLint,
ansible-lint and Ansibug were absent and explicitly skipped. The process-runner
tests cover stderr isolation, missing versus failing executables, output bounds
and timeout termination. They run as part of `npm test`.

## Native observation limits

This pass ran on macOS 15.7.4 (24G508). Both
`AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()` returned false.
A launched process is therefore only a startup/liveness observation in this
session; native rendering, file/Git/terminal interactions and VoiceOver remain
hands-on checks. The original affected-installation blank-window report is not
confirmed resolved.

The final macOS `.app` bundle built successfully and its packaged executable
remained running more than 30 seconds after launch. The app was left open for
visual inspection. This does not establish that its webview rendered correctly.
