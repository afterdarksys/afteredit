# Changelog

## Unreleased

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
