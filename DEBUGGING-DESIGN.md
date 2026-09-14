# Test monitoring and debugging design

Status: the six roadmap feature groups are implemented. See
[monitoring and debugging](MONITORING-DEBUGGING.md) for shipped behavior, setup,
limits and verification. The sections below preserve the original design;
acceptance criteria that require packaged native observation remain manual checks.
Date: 2026-09-14.

AfterEdit should make a failed test the starting point for an investigation:
see what ran, inspect the failure, reproduce it under the debugger, compare
state, and verify the fix against the same test selection.

## Implemented first slice

Build workflows now includes a Run monitor backed by the shared `runTask`
wrapper. It covers workflow, agent, Apple and infrastructure commands after
their existing review gates. It shows invocation status, elapsed time, exit
code, working directory, literal command arguments and completed output.
History is filtered by project, survives panel changes, and keeps the newest
20 completed invocations across projects in memory. Active invocations survive
clearing. No environment values are copied into the monitor.

A complete, consistent Node TAP footer produces reported pass/fail/cancelled/
skipped/todo counts. Process exit status remains independent of reported test
counts. Unknown formats stay as output. These are reports from the command;
the monitor does not verify their truth or aggregate multiple test processes.

Limits: this is invocation monitoring, not individual test discovery. Timing
includes the native call's setup and cleanup. Logs appear on completion; live
logs remain in the originating panels. Output retains at most 200,000
characters, subject to the backend's existing 200,000-byte bound. Native errors
do not return captured output. The current native response cannot reliably
distinguish a cancelled process from another signal exit. History disappears
on reload; terminal commands are outside this runner.

## Product flow

```text
Build workflows → Run monitor
  node --test       failed       3.2 s       exit 1
    17 passed · 1 failed · 2 skipped
    Command / output

Planned test details:
  checkout › expired session
    Assertion diff / source / previous attempts
    [Review rerun] [Review debug launch]

Run and debug
  Timeline: launched → breakpoint → step → exception
  Watches: session.valid   true → false
  Snapshot: checkout.ts:84 / request 8 / paused thread
  [Compare with previous pause] [Review diagnostic export]
```

Status uses text and icons rather than color alone. Opening a past run never
executes anything. Refreshing live duration must not repeatedly announce the
entire log to a screen reader. A historical snapshot visibly names its pause
and source revision; it cannot be edited as though it were live state.

## Feature priorities

| Priority | Feature | User outcome | Release acceptance |
| --- | --- | --- | --- |
| P1 | Structured test explorer | See failing cases, assertion diffs, locations and durations while a suite runs | Stable case IDs; partial output and process crashes remain incomplete; nested suites count once |
| P1 | Debugger timeline | Understand the events leading to a stop and why an adapter hangs | Ordered session events with request latency; old-session replies never appear in a new session |
| P1 | Multiple watches and pause comparison | Identify exactly which inspected values changed | Compare compatible frames, show missing/truncated values explicitly, discard stale replies |
| P2 | Debug a failed test | Reproduce one failure with its arguments and debugger preset | Preview generated configuration and test selector; save/trust gates; unsupported runners explain the missing mapping |
| P2 | Exception investigation | See exception details, stack and related output together | Capability-gated exception requests, actionable unsupported states, source navigation |
| P2 | Break when a value changes | Find the write that corrupts state | Capability-gated data breakpoint discovery and verification; no promise of hardware watchpoints on every adapter |
| P2 | Repeated-run comparison | Recognize inconsistent outcomes and performance regressions | Explicit repeated runs with attempt limits; compare matching revision/configuration/toolchain only |
| P3 | Reviewed diagnostic bundle | Share a reproducible failure with a teammate | Local preview, field removal, bounded export, no automatic upload or included environment values |
| P3 | Memory, disassembly and reverse controls | Investigate low-level behavior where supported | Adapter capability checks, bounded reads, explicit unavailable states |

## Structured test runs

Extend `src-tauri/src/tasks.rs` with native run IDs and sequenced events:

```ts
type RunEvent = {
  runId: string;
  sequence: number;
  elapsedMs: number;
  kind: 'started' | 'output' | 'test' | 'finished';
  payload: unknown; // discriminated, validated schema in implementation
};
```

Have the native runner allocate the ID before execution and associate every
stdout/stderr chunk and final outcome with it. Preserve stream identity,
decode split UTF-8 incrementally, and subscribe before starting a process.
Expose `cancelled`, `timedOut`, `spawnError`, and process exit separately.
Return the bounded output tail even after timeout. Cancellation targets a
run ID and does not mark completion until the process tree has stopped.
Publish a final event after both output readers have drained.

The existing untagged `task:output` broadcast cannot safely correlate output
to individual runs or panels. Add IDs before introducing global live logs.
Keep the current one-process backend limit initially; reject a second launch
explicitly instead of inventing a queue.

Add reporter adapters behind one normalized model:
`TestCase { id, parentId, name, file?, line?, status, durationMs?, attempts }`.
Case identity includes runner, project-relative file and full test hierarchy.
The runner exit outcome and report completeness are separate fields.

Start with a Node custom reporter and a provider-free fixture in this repo.
Node exposes structured test events and custom reporters; use its documented
reporter interface instead of parsing decorative console output. Pin the
supported Node version and test nested cases, skips, cancellation and failures.
[Node reporter documentation](https://nodejs.org/api/test.html#test-reporters).

Follow with Go JSON and imported JUnit reports, each with format-specific
fixtures and explicit supported versions. Bound individual lines, report size,
case count and retained log bytes. An incomplete report is never silently
converted into an all-passed run. Match source paths through existing workspace
authorization; log text never grants access to a file.

Rerun actions refer to an approved task and runner-specific selector generator.
They reconstruct literal argv from the current configuration, show changes
from the recorded run, and use `runTask`. Do not execute a command copied from
logs. Repeated runs are opt-in, bounded, cancellable and retain every attempt;
one intermittent success does not erase a failure.

## Debugger timeline and snapshots

Add a bounded journal at the shared DAP request/event boundary. Record session
generation, sequence, elapsed time, command/event name, completion status,
thread ID, pause ID and source location. Record request metadata by default;
raw payload collection is an explicit diagnostic mode with a size limit.
Show slow/outstanding requests and startup stages, including initialization
and configuration completion.

Every pause has a new inspection epoch. `useDebugger` already uses generations
and epochs; extend these guards to all timeline/snapshot writes and to watch
responses. Snapshot only values actually fetched during that pause. Store
plain immutable strings and source metadata, never live variable references.
Start with 50 pauses and a 2 MiB session budget, marking evicted/truncated data.

Compare watches using expression, thread, frame identity and source revision.
Show old/new strings and type changes; do not infer object equality from a
formatted string. A recursive stack frame must include its frame position in
the comparison key. A different thread/frame is labelled incompatible until
the user selects a matching snapshot. Missing, out-of-scope and error results
are distinct from an empty value.

Replace the panel's single `watch` string with a list of expressions and
per-expression states. Refresh sequentially with a bounded total time budget.
Users explicitly enable evaluation on pause; evaluating expressions can invoke
target-language behavior. A slow expression must not prevent Stop, stepping or
other watches from rendering. Resuming invalidates pending evaluations.

Timeline playback means browsing captured observations. Actual backward
execution is a separate adapter feature. DAP defines optional capabilities for
data breakpoints, exception details, memory, disassembly and stepping back;
check negotiated capabilities and honor session-scoped references.
[DAP schema](https://raw.githubusercontent.com/microsoft/debug-adapter-protocol/main/debugAdapterProtocol.json).

## Failure-to-debug handoff

A test adapter optionally supplies a launch mapping to a named debug
configuration. Preserve project, cwd, test selector, source revision and
toolchain identity. Display changes since the test ran. Existing save and
adapter-trust gates remain in force. Native test runners may need a compiled
test executable; compiling it is a separately reviewed configured task.
Attach-only adapters need a selected running target and cannot be presented
as an automatic reproduction path.

When the session ends, offer a reviewed rerun of the original selection.
Link the new attempt to its parent run. A debugger exit is not evidence that
the test passed; only the subsequent test result closes that loop.

## Implementation sequence and validation

1. **Native run lifecycle:** IDs, output sequencing, explicit completion
   reasons, timeout output and run-specific cancellation. Test fast exit,
   split Unicode, overlapping launch attempts, descendants and late events.
2. **Structured Node tests:** normalized cases, source links, live counts and
   completeness. Exercise passing/failing/nested/skipped/crashed fixtures
   through the real native runner and verify the rendered panel.
3. **Timeline and watches:** session journal, multiple watches, immutable
   snapshots and comparison. Script an adapter that delays replies across
   pause/resume/restart, and verify no stale values appear.
4. **Reproduction:** one Node and one LLDB fixture from failure through reviewed
   debug launch to rerun. Require an actual supported adapter integration run.
5. **Advanced inspection and export:** capability fixtures, bounded allocation,
   export preview and keyboard/screen-reader checks in the packaged app.

Keep each step shippable. No cloud service or telemetry collection is required.
The first two steps establish reliable evidence; the next two make that
evidence useful during an investigation.

## Verification of the initial slice

Run on 2026-09-14 in the development workspace:

| Check | Result |
| --- | --- |
| `npm test` before changes | 134 passed |
| `npm test` after changes | 140 passed; includes monitor lifecycle, retention, report parsing, runner integration, approval refusal and rendered controls |
| `npm run build` | Passed; existing large-chunk and browser-external dependency warnings remain |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 114 passed, 5 optional tests ignored |
| Browser suite with installed Chromium | 19 passed, 2 editor-readiness timeouts on the first parallel run |
| Single-worker targeted browser rerun | 3 passed: both timed-out cases plus the extended Apple-to-monitor flow |
| Opt-in LLDB breakpoint/stack/variables/step test | Passed outside the sandbox; sandboxed target launch failed |
| `git diff --check` | Passed |

Browser tests use mocked native commands. The new browser assertions verify
completed Apple command output, panel-switch retention and clearing. Their logs
also contain native-harness errors for unrelated formatter/editor-bridge APIs;
passing assertions do not establish an error-free browser console. The two
initial timeouts remain a parallel-startup reliability finding. Native packaged
UI and assistive-technology verification were not performed in this run.
