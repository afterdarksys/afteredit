# Monitoring and debugging

Build workflows → Run monitor tracks commands across workflows, agents, Apple
development and infrastructure. It shows live output, elapsed time, exit code,
and separate cancellation, timeout and spawn-error outcomes. Each native run
has a unique ID. Cancel this run targets that ID; timeout and cancellation retain
the output tail. The backend runs one task at a time.

The newest 20 completed invocations across projects stay in memory for the app
session. Output is bounded to 200,000 bytes in the native runner. Terminal shell
commands are separate. Clear completed runs only clears the selected project's
completed entries.

## Structured tests

Choose the **Node structured tests** or **Go structured tests** build preset, or
configure a named task in `.afteredit.json`:

```json
{
  "tasks": {
    "test": {
      "command": "node",
      "args": ["--test", "tests/*.test.mjs"],
      "testReporter": "node",
      "debugConfiguration": "node-tests"
    },
    "go-test": {
      "command": "go",
      "args": ["test", "-json", "./..."],
      "testReporter": "go"
    }
  },
  "debug": {
    "node-tests": {
      "adapter": { "port": 4711 },
      "request": "launch",
      "configuration": {
        "type": "pwa-node",
        "runtimeExecutable": "node",
        "runtimeArgs": "${testArgs}",
        "cwd": "${workspaceFolder}",
        "console": "internalConsole"
      }
    }
  }
}
```

The Node task must invoke Node directly with `--test`, without another
`--test-reporter` option. The native runner supplies the bundled reporter as a
data URL; it does not install a file in your project. Loader options such as
`--import` remain supported. This integration was exercised with Node 22.22.0; other versions need their
own reporter compatibility check.

Go tasks must emit `go test -json` output. Expand a run to see individual cases,
durations, failure messages and assertion expected/actual values where reported.
Source links are offered only for paths inside the selected project and still
pass through native file authorization. Go JSON does not provide source locations
in every event; cases without a source location cannot open a source-linked debug
launch. A suite entry is separate from its leaf cases.

Each run also accepts **Import JUnit XML**. Imports are local, read-only reports;
they do not identify an executable task and therefore do not enable automatic
reruns. Reports are limited to 5,000 cases; streamed retained case data and JUnit
input are bounded to 2 MiB. Malformed/truncated streamed reports remain incomplete.
Command exit status is shown independently from reported test outcomes.

## Reruns, repetition and failed-test debugging

A completed named workflow task offers **Review rerun / repeat**. A failed
structured case offers **Review test rerun** and **Review test debug launch**.
These actions resolve the current task configuration, display command arguments,
and preserve the existing trust and saved-buffer requirements. Runs from panels
without a named workflow mapping must be repeated from their originating panel.

Reruns execute dependencies first. Select 1–10 attempts to look for inconsistent
outcomes; each attempt remains linked to the original run, with status and
duration. A failed prerequisite stops the sequence. Cancellation, timeout or
launch error also stops it. Configuration or trust changes prevent subsequent
attempts. Switching away stops scheduling further attempts; an already-started
command continues and remains cancellable from Run monitor.

Repeated-run results are descriptive observations, not a statistical flakiness
score. They do not establish performance regressions across different source
revisions, machines or toolchains.

Node case selection preserves supported loader arguments, replaces positional
file selectors with the selected source file, and supplies an escaped full-name
filter. Use `--option=value` for other valued Node options. Go selection supplies
an escaped `-run` expression and `-count=1` to avoid cached test outcomes; remove
an existing Go `-run` filter before selecting a case.

For debugging, set `debugConfiguration` to a named launch configuration. Its
configuration must contain `${testArgs}`, `${testName}`, or `${testFile}`.
`${testArgs}` expands as an argument array; the other two expand as strings.
The Node example requires an installed, already-running js-debug DAP server on
localhost port 4711. AfterEdit does not install or start that server. Attach
configurations cannot reproduce a failed test automatically.

**Open reviewed debug configuration** opens Run and debug with the prepared
configuration and trust cleared. Review it, save modified files, trust the adapter
and target, and click Start. Prerequisite compilation for native targets remains
a reviewed build workflow before debugging. After the session, return to the
original run and rerun the selected test to verify the fix. A debugger exit is
never treated as a passing test result.

## Timeline, watches and snapshots

The debugger timeline shows the last 500 events and requests, elapsed session
time, request duration, pending requests and adapter errors. It resets on a new
launch. Late replies from previous sessions do not update the new journal.

Add up to 20 watch expressions. **Refresh watches and capture snapshot** evaluates
them for the selected paused frame and stores an immutable observation. Automatic
refresh on each pause is opt-in because an expression may execute target code.
Individual evaluations have a 2.5-second UI deadline and the batch has an
8-second scheduling budget; late values are discarded after resume/frame changes.
The underlying adapter request may continue until its native timeout.

Choose Before snapshot and After snapshot to see changed watch values and
captured variables. A snapshot includes only fetched values, its thread/frame
identity and a SHA-256 fingerprint of the current source file on disk. Comparison
requires matching context and source fingerprint. This fingerprint does not
prove the executable was built from that source. Missing/unreadable source is
explicitly non-comparable. Up to 40 snapshots fit within a 2 MiB session budget;
large variable captures are marked truncated. Values are bounded display strings,
not deep object equality or a recording of all program memory.

## Advanced inspection

All optional controls follow the adapter's advertised capabilities:

- **Exception investigation:** request exception details for the paused thread.
- **Data breakpoints:** load variables, then choose Break on write. Verification
  and adapter messages are shown; Clear data breakpoints removes the set.
- **Memory:** read 1–4,096 bytes from a supplied adapter memory reference, shown
  as hexadecimal and base64 with address/unreadable-byte information.
- **Disassembly:** request at most 100 instructions from an instruction reference.
- **Reverse execution:** Step back and Reverse continue are enabled only for
  adapters advertising backward stepping. Snapshot comparison itself does not
  reverse the target process.

Unsupported operations are disabled; a rejected operation shows the adapter
error. No debugger extension installation or multi-session orchestration is
included.

## Diagnostic export

Select sections under Diagnostic export, prepare the JSON preview, remove any
fields you do not want to share, and download the reviewed JSON. Debug sessions
can export timeline, snapshots, output and capabilities; runs can export command
metadata, reports and output. Nothing is uploaded automatically. Environment
values are not included as command metadata, but selected output/values can
contain sensitive application data. Exports are bounded to 2 MiB.

Protocol references: [Node custom reporters](https://nodejs.org/api/test.html#custom-reporters),
[Go test JSON](https://pkg.go.dev/cmd/test2json),
[DAP capabilities and requests](https://raw.githubusercontent.com/microsoft/debug-adapter-protocol/main/debugAdapterProtocol.json).

## Verification (2026-09-14)

- Frontend: **153 tests passed**, including real Node reporter execution and
  nested-test selection, stale watch replies, capability gates, streamed report
  ordering, timeout output, project filtering and revoked rerun permission.
- Native: **119 tests passed, 5 optional tests ignored** outside the sandbox.
  After the final stdout/result changes, all **6 task-runner tests passed** again,
  including execution of the bundled Node reporter through the real process runner.
- Real LLDB integration: **passed** launch, breakpoint, stack, variables,
  expression evaluation, stepping and exit against a temporary C fixture.
- Browser regression: **22 passed, 1 editor-readiness timeout** on the full run.
  The timed-out case and both new feature flows passed on a targeted rerun.
  Browser native/DAP behavior is mocked; the new flows cover failure details,
  rerun review, debug handoff, watch comparisons and optional inspection controls.
- Final feature browser run: **2 passed**, including the reviewed diagnostic JSON
  download. The final production build and whitespace checks passed.

The startup timeout remains an intermittent finding. Existing bundle-size and
browser-external dependency warnings remain. Packaged native UI, screen readers,
actual js-debug test reproduction, and optional inspection commands against every
supported adapter still need environment-specific verification. Optional UI
capabilities are covered with a scripted adapter; the live LLDB test covers the
core debugger flow. No cloud service or paid provider was used.
