# AfterEdit

A native code editor built on Tauri 2, React 19, Monaco and xterm.js, with a
real PTY behind the terminal panel.

## Status

Working:

- **Native PTY terminal.** A real shell (`$SHELL`, falling back to the passwd
  entry) runs in a pty; output streams to xterm, keystrokes stream back, and the
  pty is resized to match the panel. Killed on app exit.
- **Local Monaco.** The editor is bundled, not fetched from a CDN, so the app
  starts offline and runs under a restrictive CSP.
- **Persisted preferences.** Theme, layout, pair-programming toggle, model
  choice and the scratch buffer survive a restart.
- **Consented LSP install.** `check_and_install_lsp` locates a language server
  and, if it is missing, asks before running `brew install`.

Still mocked, and labelled as such in the UI:

- The Search, Git and Debug sidebar panels render nothing.
- "Code With Me" is a status-bar toggle with no model behind it.
- The explorer lists two hardcoded entries; there is no filesystem access yet
  (the Tauri capability set deliberately grants none).
- `src-tauri/afteredit-cli.sh` is a sketch of the `$EDITOR` interceptor. Its IPC
  is not implemented — do not put it on `PATH` yet; a `git commit` routed
  through it would abort with an unedited message.

## Develop

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run build      # typecheck + bundle the frontend
npm run tauri build
```

## Architecture

| Path | Role |
| --- | --- |
| `src-tauri/src/pty.rs` | PTY session: spawn, read thread, write, resize, shutdown |
| `src-tauri/src/lsp_installer.rs` | Language-server discovery and consented install |
| `src/TerminalPanel.tsx` | xterm host, PTY event wiring, resize observer |
| `src/monaco-setup.ts` | Points Monaco at the bundled copy and its workers |
| `src/usePersistedState.ts` | `useState` mirrored to localStorage |

### PTY notes

The session (master fd, writer, child killer) lives in Tauri-managed state, not
in `spawn_pty` locals — dropping the master closes the pty and SIGHUPs the
shell. `spawn_pty` is idempotent so React StrictMode remounts and webview
reloads reattach rather than forking a second shell. Output is base64-encoded
over the event bridge because a read can land mid-UTF-8-sequence; xterm
reassembles the byte stream from a `Uint8Array`.
