# Changelog

## Unreleased

### Save safety and release validation

- Format-on-save refuses stale formatter results and preserves edits made during
  the disk write. A failed save leaves the unformatted buffer intact.
- Terminal **Save & continue** saves the requested file, regardless of the active
  tab, and keeps the request available for retry or abort when saving fails or
  newer edits remain. Failed release requests also remain pending.
- Watcher reads compare against their original save baseline, so a delayed read
  cannot revert a newer save.
- Production browser regressions cover save races and terminal continuation.
  Native browser mocks now provide draft responses and reject unknown commands.
- The remaining-work document separates implemented features from their limits
  and tracks native hands-on verification separately from automated checks.
- The build script supports macOS Bash's empty-array behavior and correctly
  forwards debug and bundle options through npm to Tauri.

### Project guidance and reviewed MCP

- `AGENTS.md` is sent before `.afteredit.json` instructions. Skills live in
  `.afteredit/skills/<name>/SKILL.md` and are selected from the assistant or
  with `/name` in the goal. They are text. Task rules and the Git hook are not
  included.
- MCP servers start only from `mcp.servers` in `.afteredit.json`. Each tool
  call is reviewed. The model cannot choose the command. Tool results that
  look like secrets are withheld. This is not an operating-system sandbox and
  not a general shell.

### Plans, review, local pages, and isolated checkouts

- An agent run can propose a plan. The plan is edited before it is accepted.
  A later step records short evidence, and finish names any step still open.
- `review_diff` reads the current diff and withholds it when it looks like a
  secret. Findings are a reviewed list linked to a file and line. They do not
  edit the file.
- `capture_page` opens one `http://127.0.0.1`, `localhost`, or `[::1]` page in
  a fresh browser profile, keeps the screenshot, and stops the browser. It
  does not click or type.
- `propose_worktree` creates an isolated checkout under
  `.afteredit/worktrees`. Opening it selects that project. One task still
  runs at a time.

### Task sandbox

- On macOS, configured tasks run under Seatbelt. Writes stay in the project,
  temporary directories, and toolchain caches. Credential files stay
  unreadable. `"network": false` removes network access. The terminal is not
  sandboxed, and the agent still has no general shell.

### Everyday editor, Git, and the agent loop

- Project search supports case, whole word, regular expressions, include and
  exclude globs, and a reviewed multi-file replace that skips unsaved buffers
  and files that changed after the preview.
- The explorer is a project tree with create-folder, rename, move, and delete.
  The project root and symlinks are left unchanged. The editor can split, and
  the AI assistant stays mounted in a sidebar.
- Unsaved disk edits are restored from application drafts when the file still
  matches the edit's baseline. Secret-looking or unscanned drafts are withheld.
  The open project is polled every two seconds.
- Git can fetch, fast-forward pull, switch or create branches, stage one hunk,
  and push only the reviewed commits ahead of an existing upstream. Push does
  not force and does not set a new upstream.
- The agent can list directories, search text, and search symbols. The
  assistant shows what will be sent. Per-project conversation history withholds
  secret-looking turns. A run's edits roll back only while the buffer still
  matches what the run wrote.
- Selection edit accepts through the editor undo stack. Ghost text is off until
  enabled and stays out of the way while the snippet list is open.

### Investigation probes

- The reviewed agent can **inspect** this project's Run monitor rows and
  already-captured debugger watches or snapshots, and **propose** the existing
  failed-test debug configuration. That prepares Run and debug with trust
  cleared; it does not start the adapter or step the process. Command output
  and live variable dumps stay out of the observation. Observations are
  secret-scanned before they return to the model.

### Operator gates

- Destructive production commands in **tasks and the terminal** require typing
  the current context name. Both use the same confirmation dialog. Tab or arrow
  keys desync the terminal reconstruction and skip the overlay rather than
  false-positive.
- Terraform/OpenTofu **apply** runs `apply -input=false -no-color plan.out`
  against the saved plan. The action stays disabled until the last policy
  evaluation for the project has zero errors; the native runner re-checks.
  Projects with no `.rego` files are not blocked. The production-name confirm
  still applies when the target looks like production.
- An append-only **operator journal** under app data (directory mode 0700, 500
  entries) records production confirms, applies, git commits and agent edits.
  It never stores file contents, environment values or secret material. The
  current project's recent entries appear on the Run monitor.
- Secret scan now **blocks** model send and agent edit approval, **skips**
  local-history snapshots that match, and **redacts** diagnostic export. A scan
  that cannot complete fails closed on those paths. `.env` is still snapshotted
  when it does not contain a known credential shape.

### Confinement

- Policy evaluation, local history and context probes stay inside the selected
  project.
- The shared-workspace GUI only talks to a Unix socket this window started
  (`ssh://` from the webview is refused). Socket names use a stable hash.
- Task, LSP and DAP environment cannot override `PATH`, loader variables or
  `GIT_*`.
- `$EDITOR` requests outside the project are not auto-granted; open the file
  first.
- Monaco stays mounted when switching Git, HTTP, AI and similar pages so
  unsaved buffers and diagnostics survive.
