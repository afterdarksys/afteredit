import { invoke } from '@tauri-apps/api/core';

export type Challenge = { action: string; expected: string; reason: string };
export type TaskResult = { code: number; output: string };
type Task = { command: string; args?: string[]; cwd?: string };

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

export async function runTask(root: string, cwd: string, task: Task): Promise<TaskResult> {
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

  return invoke<TaskResult>('run_task', { root, cwd, task, confirmation });
}
