# Changelog

## Unreleased

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
