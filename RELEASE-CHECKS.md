# Release checks

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
