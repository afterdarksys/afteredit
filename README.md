# AfterEdit

A native code editor for devops, devsecops and platform engineers, built on
Tauri 2, React 19, Monaco and xterm.js, with a real PTY behind the terminal
panel.

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
- **Language coverage aimed at infrastructure code.** ~85 bundled tokenizers
  plus TOML, Makefile, Groovy (Jenkinsfile) and Rego (Spacelift/OPA/Conftest),
  which Monaco does not ship. Filename rules cover the extensionless and
  variant files Monaco misses: `Makefile`, `Jenkinsfile.release`,
  `Dockerfile.prod`, `.env.staging`, `Vagrantfile`, `CODEOWNERS`, `Caddyfile`.
- **Developer tools panel** (wrench icon, or the command palette): regex
  tester with named groups and infra presets, base64/base64url/base32/hex/URL
  codecs, timestamp conversion, base and bitwise arithmetic at 8-64 bit
  widths, an IPv4/IPv6 subnet calculator, and line-ending analysis and
  conversion for the open buffer.

Still mocked, and labelled as such in the UI:

- The Search, Git and Debug sidebar panels render nothing.
- **No formatting or linting outside the four worker-backed languages.** Monaco
  gives auto-indent everywhere and format/diagnostics for TS/JS, JSON, CSS and
  HTML only. Go, Python, C and Rust get neither. `lsp_installer.rs` installs
  server binaries, but there is no LSP client yet -- nothing spawns them or
  speaks JSON-RPC, so "linter access" is not wired. Shelling out to
  gofmt/rustfmt/black/clang-format on save is the cheap next step; a real LSP
  client is the milestone after.
- No RTF, Word or PDF support. Monaco edits plain text over a string buffer.
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
npm test           # tool unit tests, Node's built-in runner, no extra deps
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
| `src/languages/` | Tokenizers Monaco lacks, plus filename -> language rules |
| `src/tools/` | Pure tool functions (encoding, subnet, dates, regex, numbers) |
| `src/ToolsPanel.tsx` | The developer tools UI |

### PTY notes

The session (master fd, writer, child killer) lives in Tauri-managed state, not
in `spawn_pty` locals — dropping the master closes the pty and SIGHUPs the
shell. `spawn_pty` is idempotent so React StrictMode remounts and webview
reloads reattach rather than forking a second shell. Output is base64-encoded
over the event bridge because a read can land mid-UTF-8-sequence; xterm
reassembles the byte stream from a `Uint8Array`.

### Tests

`npm test` runs on Node 22's built-in test runner with `--experimental-strip-types`,
so there is no test framework to install and it works offline. Coverage is on the
pure logic in `src/tools/`, where the bugs are silent: signed-32-bit subnet
arithmetic, `/31` and `/0` edge cases, RFC 4648 base32 vectors, epoch-unit
disambiguation, and zero-length regex matches. Test files are excluded from
`tsc` because `@types/node` is not a dependency.
