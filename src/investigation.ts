import {failedTestDebug} from './testReproduction';
import type {DebugConfig} from './debugging';
import type {WatchValue,PauseSnapshot} from './debugInspection';
import type {MonitoredRun} from './runMonitor';
import type {Task} from './workflows';

export type DebugEvidence = {
  phase: string;
  stopReason: string;
  frame?: {name?: string; source?: {path?: string; name?: string}; line?: number};
  thread?: number;
  watches: string[];
  values: WatchValue[];
  snapshots: PauseSnapshot[];
  exception?: string;
};

const bound = (value: string | undefined, limit = 2000) => value === undefined ? undefined : value.slice(0, limit);

function projectRun(runs: MonitoredRun[], root: string, runId: number): MonitoredRun {
  const run = runs.find(item => item.id === runId && item.root === root);
  if (!run) throw new Error('No monitored run with that id in this project');
  return run;
}

function failedCases(run: MonitoredRun) {
  return (run.report?.cases ?? []).filter(test => !test.suite && test.status === 'failed').slice(0, 30).map(test => ({
    id: test.id,
    name: test.fullName,
    file: test.file,
    line: test.line,
    message: bound(test.message),
    expected: bound(test.expected),
    actual: bound(test.actual),
    stack: bound(test.stack, 1000),
  }));
}

export function formatInspectRun(runs: MonitoredRun[], root: string, runId?: number): string {
  const mine = runs.filter(run => run.root === root);
  if (runId === undefined) {
    if (!mine.length) return 'No monitored runs for this project in this app session.';
    return mine.map(run => {
      const tests = run.tests ? `${run.tests.passed}/${run.tests.total} passed · ${run.tests.failed} failed` : run.report ? `${run.report.cases.filter(test => !test.suite && test.status === 'failed').length} failed cases` : 'no structured report';
      return `run ${run.id} · ${run.status}${run.code !== undefined ? ` · exit ${run.code}` : ''} · ${((run.durationMs ?? 0) / 1000).toFixed(1)}s · ${run.command} · task ${run.taskName ?? 'none'} · ${tests}`;
    }).join('\n');
  }
  const run = projectRun(runs, root, runId);
  return JSON.stringify({
    id: run.id,
    nativeId: run.nativeId,
    status: run.status,
    code: run.code,
    durationMs: run.durationMs,
    cwd: run.cwd,
    command: run.command,
    args: run.args,
    taskName: run.taskName,
    error: bound(run.error, 4000),
    tests: run.tests,
    reportComplete: run.report?.complete,
    reportError: run.report?.error,
    failed: failedCases(run),
    outputOmitted: true,
  }, null, 2).slice(0, 60000);
}

export function prepareFailedTestLaunch(runs: MonitoredRun[], root: string, tasks: Record<string, Task>, configs: Record<string, DebugConfig>, runId: number, testId: string): {config: DebugConfig; origin: string; preview: string} {
  const run = projectRun(runs, root, runId);
  if (run.status === 'running') throw new Error('Wait for the run to finish before preparing a debug launch');
  if (!run.taskName || !tasks[run.taskName]) throw new Error('This run has no current named workflow task');
  const test = run.report?.cases.find(item => item.id === testId);
  if (!test) throw new Error('That test id is not in this run report');
  if (test.suite || test.status !== 'failed') throw new Error('Select a failed individual test case');
  const config = failedTestDebug(tasks[run.taskName], test, configs, root);
  const origin = `Run ${run.id}: ${run.taskName} / ${test.fullName}`;
  const preview = JSON.stringify({origin, adapterNotStarted: true, trustCleared: true, configuration: config}, null, 2).slice(0, 60000);
  return {config, origin, preview};
}

export function formatInspectDebug(evidence: DebugEvidence): string {
  return JSON.stringify({
    phase: evidence.phase,
    stopReason: bound(evidence.stopReason, 1000) ?? '',
    location: evidence.frame ? `${evidence.frame.source?.path ?? evidence.frame.source?.name ?? 'Unknown source'}:${evidence.frame.line ?? '?'}` : undefined,
    thread: evidence.thread,
    watches: evidence.watches,
    capturedWatchValues: evidence.values.map(value => ({expression: value.expression, value: bound(value.value), type: value.type, error: value.error})),
    snapshots: evidence.snapshots.map(snapshot => ({
      id: snapshot.id,
      location: snapshot.location,
      time: snapshot.time,
      truncated: snapshot.truncated,
      values: snapshot.values.map(value => ({expression: value.expression, value: bound(value.value), type: value.type, error: value.error})),
    })),
    exception: bound(evidence.exception, 4000),
    adapterNotControlled: true,
    variablesOmitted: true,
  }, null, 2).slice(0, 60000);
}
