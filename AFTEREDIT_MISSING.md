# AfterEdit: remaining work and capability boundaries

Updated: **2026-09-26**. This is a source-based backlog for the current repository,
not a benchmark or a claim of full Xcode, VS Code, Cursor, or Antigravity parity.
The earlier comparison mixed implemented features with missing ones. This document
now separates what exists from the narrower work that remains. Release evidence
and hands-on checks are tracked in [RELEASE-CHECKS.md](RELEASE-CHECKS.md).

## Current reliability work

- The four save-safety review findings are addressed in [App.tsx](src/App.tsx):
  stale formatting cannot replace newer typing; a failed save keeps a terminal
  edit request pending; continuation saves the requested file even after a tab
  switch; watcher reads use the baseline captured before the asynchronous read.
- [Save-safety regressions](tests/save-safety.spec.ts) cover those cases plus
  retry, abort after failure, formatted-save failure, and typing during a write.
  These tests use real browser/editor code with a mocked native IPC boundary.
- The shared [native browser fixture](tests/nativeHarness.ts) explicitly handles
  drafts, worktree lists, terminal operations, and task challenges. Unknown
  commands reject instead of returning a misleading null result.
- Native rendering, editor/Git/terminal interactions, restart behavior, and
  VoiceOver still require observed packaged-app results. See the release checklist.

## Implemented capabilities, with their limits

| Area | Implemented | Remaining boundary | Evidence |
| --- | --- | --- | --- |
| Everyday editing | Project tree; folder creation, rename/move/delete; separate buffers; editor split; persistent AI sidebar | Independent editor groups/layout persistence and broader multi-window workflows | [App](src/App.tsx), [tree](src/FileTree.tsx) |
| Search and replace | Regex, case/whole-word options, include/exclude globs, reviewed multi-file replacement | Search remains bounded; it is not an indexed semantic retrieval system | [search](src/SearchPanel.tsx), [workspace](src-tauri/src/workspace.rs) |
| Recovery and disk changes | Atomic conflict-checked saves, recursive project polling, active-file polling, saved sessions and secret-scanned dirty-buffer drafts | Polling is not native filesystem notification; main editor and shared service have separate buffers | [session](src-tauri/src/session.rs), [watcher](src-tauri/src/workspace.rs) |
| Local Git | Status/diffs, file and hunk staging, reviewed commits, branch create/switch, fetch, fast-forward pull, reviewed push, isolated worktrees | No history graph, stash UI or dedicated merge editor; push requires an existing upstream | [Git UI](src/GitPanel.tsx), [backend](src-tauri/src/git.rs) |
| AI editing | Optional single-line ghost text; selection prompt, preview, accept/reject and undo | Multiline/cross-file prediction and next-edit navigation; representative quality/latency evaluation | [editor](src/CodeEditor.tsx), [AI binding](src/editorAi.ts) |
| Agent discovery | Directory listing, text search, file reads and workspace symbol queries | Better relevance ranking, context retrieval and richer source selection; symbols need a capable connected LSP | [agent](src/AgentPanel.tsx), [protocol](src/agent.ts) |
| AI context/history | Explicit open-file selection, visible context preview, bounded per-project local conversation history | History display is not resumable agent execution; no image attachments, conversation forks or searchable session management | [assistant](src/AiPanel.tsx) |
| Agent edits and rollback | Reviewed exact replacements in existing files, unsaved buffer changes, save-before-task handoff, guarded run rollback | No create/move/delete agent actions, transaction across disk files, durable checkpoints or hunk-level run review | [agent](src/AgentPanel.tsx), [rollback](src/agent.ts), [App](src/App.tsx) |
| Plans and review | Editable in-run plan, evidence per step, diff inspection and reviewed file/line findings | Saved plan/walkthrough artifacts and hosted PR review | [plans](src/loop.ts), [agent](src/AgentPanel.tsx) |
| Guidance and MCP | Root AGENTS.md, scoped project instructions, selectable SKILL.md files, reviewed stdio MCP tools | Nested rules, plugins/lifecycle hooks; MCP HTTP/auth, resources, prompts, cancellation and broader tool management | [guidance](src/guidance.ts), [MCP](src-tauri/src/mcp.rs) |
| Browser verification | Reviewed localhost screenshot capture in a fresh browser profile | Clicking, typing, network inspection, recordings and element-to-source editing | [capture](src-tauri/src/browser.rs) |
| Isolation | Reviewed worktree creation and macOS task sandbox with optional network restriction | Concurrent agent loops, automatic integration, Linux/Windows confinement; terminal is not sandboxed | [sandbox](src-tauri/src/sandbox.rs), [Git](src-tauri/src/git.rs) |

## Capability matrix

These surfaces do not all share the same buffers or execution sessions.

| Surface | Files and buffers | Tools and execution | Main limitations |
| --- | --- | --- | --- |
| Standard desktop editor | Native local projects, unsaved editor buffers, session/draft recovery | PTY, tasks, native LSP/DAP, Git, BYOK AI, Apple and infrastructure workflows | Local workspace; separate from shared-service buffers |
| Experimental extension editor | Active editor buffer only | Trusted browser extensions, supported commands/settings/providers | No native project filesystem, task bridge or desktop Node extension host |
| Shared GUI | Local service's versioned buffers, shared with CLI/TUI | Service RPC explorer for Git/tasks/LSP/DAP | Dedicated main-editor panels keep their own sessions; remote endpoints rejected |
| Plain CLI / TUI | Shared-service buffers and recovery | Local service commands, reviewed tasks/Git, LSP/DAP | Not a headless AI agent; one service language server and debug session |
| CLI over SSH | Remote workspace service through SSH | Service operations on the remote host | Does not turn the main GUI into a remote workspace |

See [README](README.md), [extension validation](src/webExtensions.ts),
[shared GUI](src/SharedWorkspacePanel.tsx), and [CLI guide](CLI-PROTOTYPE.md).

## Prioritized remaining backlog

### Release verification first

1. Observe the installed app rendering, then edit/save/reopen a disposable file.
2. Restart and check session/draft recovery; verify stale-disk conflict handling.
3. Review/stage/commit a disposable Git change and use the real terminal.
4. Exercise debugger launch/breakpoint/step in the GUI, keyboard navigation and
   VoiceOver. Backend LLDB and browser accessibility tests are supporting evidence,
   not substitutes for these observations.
5. Exercise BYOK chat, selection edits, ghost text and a complete reviewed
   edit/save/test/rollback run with a live provider; measure useful results,
   failures, latency, cancellation and recovery. Protocol fixtures do not measure
   model quality or provider availability.

### Everyday editor and durable agents

- Add LSP semantic tokens, inlay hints, call/type hierarchy and reviewed workspace
  create/rename/delete operations. Rename and code actions already exist.
- Add terminal tabs/splits, concurrent debug sessions and DAP runInTerminal.
- Extend Git with history, stash and merge-conflict editing.
- Unify main-editor and shared-service workflows without silently replacing
  unrelated unsaved buffers.
- Persist resumable agent runs, plans, approvals and change checkpoints; add
  coordinated file operations and review of each run's changes.
- Extend context selection to ranges, diagnostics, terminal output and images;
  improve retrieval and predictive editing beyond single-line completions.
- Broaden MCP management, portable guidance, browser interaction and isolated
  parallel work, while preserving reviewed mutations and secret scanning.

### Larger product decisions

- Expand web-extension APIs/contributions or build a desktop extension host.
- Integrate remote GUI files, terminals, tasks, language services and debugging.
- Provide equivalent task confinement on Linux and Windows before broadening
  unattended execution.
- Add a headless AI CLI/SDK, PR/issue integration, scheduled/event-triggered work,
  hosted agents and team administration only as explicit product commitments.

Feature implementation is distinct from release validation. Do not reopen the
implemented items above as wholly missing, or mark a hands-on check complete solely
because an app process starts or a mocked browser test passes.
