# Afteredit: missing and incomplete capabilities

Reviewed: **2026-09-25**. Scope: the current Afteredit source tree compared with official Cursor and Google Antigravity documentation available on this date.

**Main finding:** Afteredit already offers a substantial native developer workbench. Its largest competitive gaps are AI-assisted editing, agent context and tooling, durable agent sessions, browser verification, and the breadth of its extension runtime. Rebuilding terminals, debugging, basic Git, or language services from scratch would duplicate capabilities already present.

This is a source and documentation review, not a hands-on benchmark of the three applications. “Missing” means no implementation was found in the reviewed application code; “partial” means a related capability exists but does not cover the described workflow. Competitor features may depend on product surface, plan, platform, or rollout. Priorities below are recommendations for a developer-focused editor, not measured customer demand.

Cursor's **classic IDE**, **Agents Window**, **CLI**, and **cloud service** are distinct surfaces. Google similarly distinguishes **Antigravity IDE**, **Antigravity 2.0**, and **Antigravity CLI**. Features from the broader product families are identified below rather than assumed to exist in every editor window. See [Cursor's Agents Window](https://cursor.com/docs/agent/agents-window) and [Antigravity 2.0 overview](https://www.antigravity.google/docs/overview).

## What Afteredit already offers

These capabilities should not be placed on a missing-features backlog without identifying the narrower limitation.

| Area | Present in the repository | Local evidence |
| --- | --- | --- |
| Native editing | Tauri/React/Monaco, real files, multiple project roots, separate buffers, atomic saves, external-change checks, session restoration and startup recovery | [App](src/App.tsx), [workspace](src-tauri/src/workspace.rs), [session](src-tauri/src/session.rs), [recovery](src/StartupRecovery.tsx) |
| Editing preferences | Themes, snippets, indentation and shell assistance, Vim/Emacs keymaps, command palette and accessibility preferences | [editor](src/CodeEditor.tsx), [preferences](src/preferences.ts), [editing assistance](src/smartEditing.ts), [accessibility guide](ACCESSIBILITY.md) |
| Language intelligence | Diagnostics, completion, hover, definitions, references, document/workspace symbols, signature help, rename, code actions and formatting; selected language-server installation paths | [LSP client](src/lspClient.ts), [symbols](src/symbols.ts), [workspace edits](src/workspaceEdit.ts), [installer](src-tauri/src/lsp_installer.rs) |
| Terminal and automation | Real PTY, configured tasks, dependencies, named workflows, trust review, cancellation, run history and structured test results | [terminal](src/TerminalPanel.tsx), [workflows](src/workflows.ts), [task engine](src-tauri/src/tasks.rs), [run monitor](src/RunMonitorPanel.tsx) |
| Debugging | Native DAP, breakpoints, stack/variables, watches, evaluation, memory/disassembly and adapter-dependent reverse operations | [debug panel](src/DebugPanel.tsx), [DAP backend](src-tauri/src/dap.rs), [debugging guide](MONITORING-DEBUGGING.md) |
| AI | BYOK OpenAI-compatible/Anthropic requests, chat streaming/cancellation, local usage caps, reviewed agent file edits/tasks and investigation probes | [AI panel](src/AiPanel.tsx), [agent panel](src/AgentPanel.tsx), [action protocol](src/agent.ts), [AI backend](src-tauri/src/ai.rs) |
| Git and recovery | Status, staged/working diffs, per-file stage/unstage, reviewed commits, secret scanning, pre-commit hook installation and local file history | [Git](src/GitPanel.tsx), [Git backend](src-tauri/src/git.rs), [hooks](src-tauri/src/hooks.rs), [history](src/HistoryPanel.tsx) |
| Extensions | Open VSX/VSIX themes and snippets, plus an experimental browser-extension runtime | [extensions](src/ExtensionsPanel.tsx), [web extension validation](src/webExtensions.ts), [compatibility editor](src/CompatibilityEditor.tsx) |
| Specialized tools | HTTP requests, Terraform/OpenTofu/Ansible workflows, policy evaluation, Apple build/test/device workflows and developer utilities | [HTTP](src/HttpPanel.tsx), [infrastructure](src/InfrastructurePanel.tsx), [policy](src/PolicySection.tsx), [Apple development](APPLE-DEVELOPMENT.md), [tools](src/ToolsPanel.tsx) |
| CLI and shared workspace | Headless workspace service, plain/TUI clients, versioned shared buffers, RPC operations and CLI SSH transport | [CLI guide](CLI-PROTOTYPE.md), [CLI implementation](src-tauri/src/service/cli.rs), [transport](src-tauri/src/service/transport.rs), [shared GUI](src/SharedWorkspacePanel.tsx) |

“Present” records source implementation, not a claim that every integration has been verified in a packaged release.

## Priority 1: core AI editing and agent gaps

These have the most direct impact on whether someone can use Afteredit as an everyday AI coding editor.

### 1. Predictive AI completion and next-edit suggestions — missing

- **Competitor reference:** Cursor Tab predicts multiline and cross-file edits; Antigravity IDE provides Supercomplete, Tab-to-Jump and Tab-to-Import. [Cursor Tab](https://cursor.com/help/ai-features/tab), [Antigravity Tab](https://www.antigravity.google/docs/ide/tab/).
- **Afteredit today:** Monaco/LSP completion, snippets and shell block completion exist. No model-backed inline completion provider was found in [CodeEditor](src/CodeEditor.tsx) or [smartEditing](src/smartEditing.ts).
- **Missing deliverable:** Low-latency ghost text, accept/reject controls, cancellation of stale requests, multiline edit previews and optional next-edit navigation. Existing snippet Tab completion should remain distinguishable from AI suggestions.

### 2. Selection-scoped inline AI editing — missing

- **Competitor reference:** Cursor supports prompting against selected code directly in the editor. [Inline edit](https://cursor.com/help/ai-features/inline-edit).
- **Afteredit today:** AI runs from a separate page; edits are reviewed as exact-text replacement proposals. [AI panel](src/AiPanel.tsx), [change review](src/ChangeReview.tsx).
- **Missing deliverable:** Select code, invoke an inline prompt, preview the proposed change, accept or reject it and undo it without leaving the editor.

### 3. Agent-accessible project discovery and search — missing

- **Competitor reference:** Cursor documents automatic local indexed search and an exploration subagent. Its current search documentation says it does **not** use stored codebase embeddings for this feature; a vector database is not a prerequisite for parity. [Cursor search](https://cursor.com/docs/agent/tools/search).
- **Afteredit today:** Users can search text and LSP symbols, but the [agent action protocol](src/agent.ts) cannot list directories, search files or query symbols. It reads files only when it already has a relative path. [Project search](src/SearchPanel.tsx).
- **Missing deliverable:** Agent tools for file discovery, text/symbol search and bounded relevant-context retrieval, with file exclusions and visible source references.

### 4. Rich context selection and multimodal input — partial

- **Competitor reference:** Cursor's Design Mode supplies selected page elements and visual annotations as context; Antigravity's browser tools capture screenshots. [Design Mode](https://cursor.com/docs/agent/design-mode), [Antigravity browser](https://www.antigravity.google/docs/ide/browser/).
- **Afteredit today:** The [AI panel](src/AiPanel.tsx) offers an active-file checkbox and project instructions; agent reads provide additional text. No attachment/context picker or image-input workflow was found.
- **Missing deliverable:** Explicit selection of files, ranges, diagnostics and terminal output, followed by screenshot/image input and web/document context. Show what will be sent and retain existing secret scanning.

### 5. Persistent, resumable AI conversations — missing

- **Competitor reference:** Antigravity CLI supports workspace-scoped conversation history, resume and conversation forks. [Managing conversations](https://www.antigravity.google/docs/cli/conversations/).
- **Afteredit today:** Prompt, answer, run log and agent transcript live in React state/refs. The AI page is conditionally mounted. Saved editor sessions and workflow history do not persist AI conversations. [AI state](src/AiPanel.tsx), [agent state](src/AgentPanel.tsx), [view lifecycle](src/App.tsx).
- **Missing deliverable:** Per-project conversation history, recoverable interrupted runs, resume, search/export and optional conversation branching. Explicitly control whether code-bearing transcripts are stored.

### 6. MCP client and tool management — partial

- **Competitor reference:** Both products expose MCP integration. [Cursor MCP](https://cursor.com/docs/mcp), [Antigravity MCP](https://www.antigravity.google/docs/mcp/).
- **Afteredit today:** Stdio servers are configured only in the project-root `.afteredit.json` `mcp.servers` object. Connecting one lists its tools. `call_mcp` is always reviewed, and the model cannot choose the command. Loader and `GIT_*` environment variables are refused. Results that look like secrets are withheld, and the call is journaled without its contents. [MCP client](src-tauri/src/mcp.rs), [agent action](src/agent.ts).
- **Missing deliverable:** HTTP transport, authentication, cancelling an in-flight call, resources, prompts, and a broader tool-management surface.

### 7. Broader agent file operations and a complete edit/test loop — partial

- **Competitor reference:** Antigravity 2.0 agents can perform file read/write operations and execute commands. [Antigravity overview](https://www.antigravity.google/docs/overview).
- **Afteredit today:** The agent can replace a unique nonempty string in an existing file and request a named task. It has no create/delete/rename action or general shell action; approved edits land in unsaved buffers. [Actions](src/agent.ts), [approval loop](src/AgentPanel.tsx).
- **Missing deliverable:** Reviewed file creation/moves/deletions, coordinated multi-file edit sets, an explicit save-and-test handoff and reliable failure feedback. General shell execution is an optional expansion that should depend on execution isolation, not simply removing approvals.

### 8. First-class planning and progress artifacts — partial

- **Competitor reference:** Cursor has reviewable Plan Mode; Antigravity exposes structured plans, walkthroughs, diagrams and other artifacts. [Cursor planning](https://cursor.com/docs/agent/plan-mode), [Antigravity artifacts](https://www.antigravity.google/docs/artifacts/).
- **Afteredit today:** `propose_plan` is edited in the agent review before it is accepted. `update_plan` records evidence for one step. Finish names steps that are still open. [Plan parsing](src/loop.ts), [agent panel](src/AgentPanel.tsx).
- **Missing deliverable:** A saved plan document, diagrams, and a separate walkthrough artifact. The in-run plan is the tracked list.

### 9. Agent change sets and run-level rollback — partial

- **Competitor reference:** Cursor's Agents Window includes an integrated changes/commit/PR view; Antigravity presents code diffs within its artifact workflow. [Agents Window](https://cursor.com/docs/agent/agents-window), [Artifacts](https://www.antigravity.google/docs/artifacts/).
- **Afteredit today:** Exact replacement review, Git diffs, editor undo and per-file local history exist. There is no unified agent-run change set or transaction spanning all touched files. [Change review](src/ChangeReview.tsx), [local history](src/HistoryPanel.tsx).
- **Missing deliverable:** Per-run changed-file list, hunk-level review and coordinated restore to the run's starting state while protecting unrelated user edits. Transactional rollback is a recommended Afteredit design, not an assertion that both competitors implement identical semantics.

### 10. Portable agent rules, skills, plugins and lifecycle hooks — partial

- **Competitor reference:** Cursor exposes scoped rules, skills, plugins and hooks; Antigravity documents skills and agent lifecycle hooks. [Cursor customization](https://cursor.com/docs/customize-cursor), [Antigravity skills](https://www.antigravity.google/docs/skills/), [Antigravity hooks](https://www.antigravity.google/docs/hooks/).
- **Afteredit today:** `AGENTS.md` at the project root is sent first. `.afteredit.json` instructions follow it and override it. A skill is `.afteredit/skills/<name>/SKILL.md`, chosen in the assistant or with `/name` in the agent goal. Task rules and the Git pre-commit hook stay separate and are not sent. [Guidance](src/guidance.ts), [workflow configuration](src/workflows.ts), [Git hooks](src-tauri/src/hooks.rs).
- **Missing deliverable:** Plugins, approved pre/post-tool lifecycle hooks, and slash commands beyond selecting one skill for the run.

### 11. Parallel agents and isolated workspaces — partial

- **Competitor reference:** Cursor offers parallel agents across environments; Antigravity IDE documents parallel agents across workspaces and Antigravity also supports custom subagents. [Cursor Agents Window](https://cursor.com/docs/agent/agents-window), [Antigravity IDE](https://www.antigravity.google/docs/ide/overview/), [Custom subagents](https://www.antigravity.google/docs/subagents/).
- **Afteredit today:** A reviewed `propose_worktree` creates a checkout under `.afteredit/worktrees` on branch `afteredit/<name>`. Opening it selects that project. The main checkout's uncommitted edits stay there. [Git worktrees](src-tauri/src/git.rs).
- **Missing deliverable:** Two model loops at once, per-run budgets beyond the existing step cap, and automatic merge of the worktree. One task still runs at a time.

### 12. Browser interaction and visual verification — partial

- **Competitor reference:** Antigravity IDE can operate Chrome and capture screenshots/recordings; Cursor Design Mode connects selected running-page elements to agent edits. [Antigravity browser](https://www.antigravity.google/docs/ide/browser/), [Cursor Design Mode](https://cursor.com/docs/agent/design-mode).
- **Afteredit today:** A reviewed `capture_page` opens one `http://127.0.0.1`, `localhost`, or `[::1]` URL in a fresh browser profile, keeps a screenshot, and stops the process. The browser log is withheld when it looks like a secret. [Capture](src-tauri/src/browser.rs).
- **Missing deliverable:** Clicking, typing, network logs, and element-to-source editing. The capture does not drive the page.

## Priority 2: ecosystem and advanced workflow gaps

| # | Capability and status | Afteredit evidence and concrete gap | Verified competitor reference |
| --- | --- | --- | --- |
| 13 | Broad editor-extension compatibility — **partial** | [Web extension validation](src/webExtensions.ts) rejects Node-only packages, dependencies, proposed APIs and many contributions. The [compatibility editor](src/CompatibilityEditor.tsx) is a separate limited surface. Expand workspace APIs and contribution support; decide explicitly whether to build a desktop extension host. | Cursor's classic IDE has a VS Code extension ecosystem; this does not imply every extension is compatible or licensed for every editor. [Cursor migration guidance](https://docs.cursor.com/en/guides/migration/jetbrains). |
| 14 | Integrated remote GUI development — **partial** | [CLI SSH transport](src-tauri/src/service/transport.rs) exists, but the [GUI backend](src-tauri/src/shared_workspace.rs) rejects remote endpoints. Connect remote buffers, terminal, tasks, LSP and DAP into the main editor as a coherent remote workspace. | Cursor documents its Remote SSH integration. [Remote connections](https://cursor.com/help/troubleshooting/network). |
| 15 | Agent command sandbox and network policy — **partial** | Configured tasks on macOS run under Seatbelt. Writes stay in the project, temp, and toolchain caches. SSH, cloud, kube, GnuPG, and keychain paths stay unreadable. `"network": false` removes network. [Task runner](src-tauri/src/tasks.rs), [sandbox](src-tauri/src/sandbox.rs). Still missing: the same confinement on Linux and Windows, sandboxing the interactive terminal, and any general agent shell. Do not add that shell by skipping the sandbox. | Antigravity 2.0/CLI document filesystem and network restrictions for agent shell execution. [Terminal Sandbox](https://www.antigravity.google/docs/sandbox/). |
| 16 | Dedicated AI code review — **partial** | `review_diff` returns the current unstaged and staged diff and withholds it when it looks like a secret. `report_findings` is a reviewed list of path, line, and summary that opens the file. Findings are not edits. [Diff](src-tauri/src/git.rs), [findings](src/loop.ts). Still missing: a hosted pull-request reviewer. | Cursor offers local Agent Review and hosted Bugbot PR review. [Agent Review](https://cursor.com/docs/agent/agent-review), [Bugbot](https://cursor.com/docs/bugbot). |
| 17 | Agent CLI and SDK — **partial** | Afteredit has a real [workspace CLI](src-tauri/src/service/cli.rs), including tasks and debugging. It lacks a headless AI task runner with conversation resume, tool events and machine-readable agent results. Build on the service instead of creating another unrelated CLI. | Cursor ships an agent CLI; Antigravity also provides CLI and SDK surfaces. [Cursor CLI](https://cursor.com/docs/cli/overview), [Antigravity documentation](https://www.antigravity.google/docs/overview). |
| 18 | Hosted/background agents — **missing** | The local workspace service can outlive a client, but no hosted AI worker provisioning, durable agent queue or remote execution environment was found. [Workspace service](src-tauri/src/service/mod.rs). This is a separate infrastructure product decision. | Cursor Cloud Agents run in isolated remote development environments and continue without the local machine staying connected. [Cloud Agents](https://cursor.com/docs/cloud-agent). |
| 19 | Scheduled and event-triggered AI work — **partial** | [Workflows](src/workflows.ts) support save/manual rules and reviewed configured tasks. Missing scheduled agent runs and issue/PR/webhook-triggered work. | Cursor Automations supports time/event triggers and configured agent tools. [Automations](https://cursor.com/docs/cloud-agent/automations). |
| 20 | Integrated PR and issue handoff — **missing** | [Git backend](src-tauri/src/git.rs) supports local status/diffs/staging/commits. No built-in PR lifecycle or issue assignment integration was found; terminal tools are an external workaround. | Cursor's Agents Window includes PR management; cloud agents integrate with source-control and work-tracking entry points. [Agents Window](https://cursor.com/docs/agent/agents-window), [Cloud Agents](https://cursor.com/docs/cloud-agent). |
| 21 | Team administration and centrally distributed agent policy — **missing** | Local trust and preferences exist; [shared workspace](src/SharedWorkspacePanel.tsx) is a local service client, not an organization identity/admin system. Add this only if team deployments are a target. | Cursor documents team MCP distribution and enterprise allowlists; Antigravity documents enterprise deployment through Google Cloud. [Cursor MCP administration](https://cursor.com/docs/mcp), [Antigravity enterprise](https://www.antigravity.google/docs/enterprise/). |

## Additional editor gaps found in Afteredit

These are source-grounded usability and completeness findings. They are **not** a claim that every item was individually tested in both competing products. They should be considered alongside AI parity because daily editing friction can outweigh advanced agent features.

| # | Gap | Current boundary and suggested addition | Priority |
| --- | --- | --- | --- |
| 22 | Project search and replace | [SearchPanel](src/SearchPanel.tsx) supports literal case-sensitive text search and LSP symbols. Add regex, case/whole-word controls, include/exclude globs, replace previews and reviewed multi-file replacement. The existing backend also bounds results and traversal. | High |
| 23 | Explorer file management | [App](src/App.tsx) browses one directory at a time and supports open/add-folder/save-as. Add a tree plus explicit create-folder, rename/move and delete workflows. Save As and the CLI's new-file support already cover some creation needs. | High |
| 24 | Editor splits and persistent AI sidebar | [App](src/App.tsx) hosts one active editor surface; its side-by-side layout concerns the terminal. AI is a separate conditional page. Add independent editor groups and an AI sidebar that can remain visible while editing. | High |
| 25 | Full local Git workflow | [Git backend](src-tauri/src/git.rs) lacks dedicated fetch/pull/push, branch management, history, stash, hunk staging and merge-conflict resolution UI. Existing terminal Git remains available. | High |
| 26 | Remaining LSP coverage | Rename, references and code actions already exist. [LSP client](src/lspClient.ts) still lacks registered semantic-token, inlay-hint and call/type-hierarchy providers. [Workspace edit handling](src/workspaceEdit.ts) explicitly rejects create/rename/delete file operations. Add capability-gated support rather than advertising generic “refactoring missing.” | Medium |
| 27 | Recursive change tracking and main-editor dirty-buffer recovery | The main editor polls the active file and restores saved file paths. Add recursive filesystem notifications and recovery of unsaved main-editor disk buffers. The [shared service](CLI-PROTOTYPE.md) already has separate recovery behavior; do not describe all recovery as absent. [Session backend](src-tauri/src/session.rs), [App](src/App.tsx). | High |
| 28 | Richer terminal/debug session management | The current workbench provides a PTY and one native DAP session. Add terminal tabs/splits and concurrent debug sessions; implement DAP `runInTerminal` for adapters that require it. [Terminal](src/TerminalPanel.tsx), [DAP](src-tauri/src/dap.rs), [debug limitations](README.md#native-run-and-debug). | Medium |
| 29 | Unify main editor and shared-service workflows | The shared GUI/CLI use versioned service buffers, while dedicated editor, monitoring and debugging panels retain their own sessions. Connect these surfaces so a shared session is a complete workbench experience. [CLI architecture and limits](CLI-PROTOTYPE.md), [SharedWorkspacePanel](src/SharedWorkspacePanel.tsx). | Medium |

## Documentation and validation gaps

These affect the accuracy of Afteredit's offer even before new features are built.

1. **Correct stale feature descriptions.** [README](README.md) says rename/code actions are unsupported, while [lspClient](src/lspClient.ts) implements them. It describes an old CLI sketch, while [CLI-PROTOTYPE](CLI-PROTOTYPE.md) and the service code describe a working prototype. Its blanket remote-development statement needs to distinguish CLI SSH from missing GUI remote integration. Extension sections also need to distinguish data-only support from the experimental executable web runtime.
2. **Publish one capability matrix.** Separate standard editor, experimental extension editor, shared GUI, plain CLI, TUI and SSH. State which features share buffers/session state and which do not.
3. **Close the recorded release-verification gaps.** [RELEASE-CHECKS](RELEASE-CHECKS.md) explicitly distinguishes mocked browser checks from packaged-app evidence and records outstanding native rendering/accessibility checks. The [README](README.md) also records limits on live-provider/full-agent validation. This review did not rerun or resolve those checks.
4. **Validate completion quality, not just transport.** Before advertising AI parity, measure representative repo tasks, failed edits, useful completions, context selection, cancellation and recovery. Existing protocol tests do not establish model usefulness.

## Suggested implementation order

1. **Make the current offer accurate:** update the capability matrix and close the existing packaged-release validation items.
2. **Strengthen the everyday editor:** search/replace, file management, splits/sidebar and recovery; extend Git where users currently need the terminal.
3. **Build durable AI foundations:** persistent sessions, agent search/context tools, coordinated changes and rollback. These are prerequisites for trustworthy longer runs.
4. **Add immediate AI editing value:** inline selection edits and predictive completion, with explicit latency and quality targets.
5. **Open the tool ecosystem:** reviewed stdio MCP, portable instructions/skills, and a macOS Seatbelt sandbox for configured tasks are in. A general agent shell stays closed. Linux and Windows still need an equivalent sandbox.
6. **Add verification and orchestration:** an editable in-run plan, diff findings, a localhost page capture, and isolated worktrees are in. Two concurrent model loops, click-through browser control, and a hosted pull-request reviewer are not.
7. **Choose larger product bets deliberately:** desktop extension hosting, full remote GUI development, hosted agents and enterprise administration. These are substantial ongoing commitments, not small parity checkboxes.

Afteredit's existing BYOK controls, reviewed mutations, accessibility work, infrastructure tooling and Apple workflows provide a useful product direction. The gaps above can be closed while retaining those strengths; copying the competitors' entire hosted-service footprint is optional.
