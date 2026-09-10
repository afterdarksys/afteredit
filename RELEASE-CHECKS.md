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
