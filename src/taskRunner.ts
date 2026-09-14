import {listen} from '@tauri-apps/api/event';
import type {Task as WorkflowTask} from './workflows';
import { invoke } from '@tauri-apps/api/core';
import { runMonitor } from './runMonitor';

export type Challenge = { action: string; expected: string; reason: string };
export type TaskResult = { code: number; output: string; status?: "succeeded"|"failed"|"cancelled"|"timedOut"|"spawnError"|"error"; runId?:number; durationMs?:number; error?:string; sequence?:number; outputTruncated?:boolean; stdout?:string; stdoutTruncated?:boolean };
type Task = Omit<WorkflowTask,'args'> & {args?:string[]};

/**
 * Every task goes through here so the production gate cannot be bypassed by
 * calling a panel's own runner. Rust decides whether a challenge is needed and
 * re-verifies the answer, so this is a prompt, not the check itself.
 */
let confirmer: ((challenge: Challenge) => Promise<string | null>) | null = null;

/** Installed once by App; panels never wire up their own dialog. */
export function setTaskConfirmer(ask: (challenge: Challenge) => Promise<string | null>): void {
  confirmer = ask;
}

export async function runTask(root: string, cwd: string, task: Task, metadata: {taskName?:string;parentId?:number;canStart?:()=>boolean} = {}): Promise<TaskResult> {
  const challenge = await invoke<Challenge | null>('task_challenge', {
    root: root || null,
    command: task.command,
    args: task.args ?? [],
  });

  let confirmation: string | null = null;
  if (challenge) {
    // No confirmer installed means no way to answer; refusing is the only safe
    // outcome, and Rust would refuse anyway.
    confirmation = confirmer ? await confirmer(challenge) : null;
    if (confirmation === null) {
      throw new Error(`Cancelled: ${challenge.action} targets ${challenge.expected}`);
    }
  }

  if(metadata.canStart&&!metadata.canStart())throw new Error('Run cancelled before launch');
  const id = runMonitor.start(root, cwd, task.command, task.args ?? [], {taskName:metadata.taskName,parentId:metadata.parentId,reporter:task.testReporter});
  const requestId=crypto.randomUUID();
  let off=()=>{};
  const started = performance.now();
  try {
    off=await listen<any>('task:event',({payload})=>{if(payload.requestId===requestId)runMonitor.event(id,payload);});
    if(metadata.canStart&&!metadata.canStart())throw new Error('Run cancelled before launch');
    const result = await invoke<TaskResult>('run_task', { root, cwd, task:{...task,args:task.args??[]}, confirmation, requestId });
    runMonitor.finish(id, result.durationMs ?? performance.now() - started, result);
    return result;
  } catch (error) {
    runMonitor.finish(id, performance.now() - started, { error: String(error) });
    throw error;
  } finally { off(); }
}
