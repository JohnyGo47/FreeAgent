// Auto-commit agent steps + /undo (spec_git_checkpoints, ARCHITECTURE §10/§11). child_process
// git, not libgit2 (constraint) - the target audience definitely has git in PATH.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTECTED_DIR_NAMES, matchesSecretPattern } from '../fs/privacyRules.ts';
import type { BusMessage, NotifyPayload } from '../../../shared/bus-types/index.ts';

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export const runGit: GitRunner = (args, cwd) => execFileAsync('git', args, { cwd });

export interface CheckpointEntry {
  task_id: string;
  files: string[];
  pre_task_commit: string;
  done_commit?: string;
  summary?: string;
  ts: string;
}

export function checkpointsPath(freeagentDir: string): string {
  return join(freeagentDir, 'checkpoints.json');
}

export async function loadCheckpoints(freeagentDir: string): Promise<CheckpointEntry[]> {
  const raw = await readFile(checkpointsPath(freeagentDir), 'utf8').catch(() => null);
  if (raw === null || raw.trim().length === 0) return [];
  return JSON.parse(raw) as CheckpointEntry[];
}

export async function saveCheckpoints(freeagentDir: string, entries: CheckpointEntry[]): Promise<void> {
  await writeFile(checkpointsPath(freeagentDir), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

// Don't commit (task B.11): /freeagent/ and privacy exceptions are a common source of truth
// (privacyRules.ts, PR-7), the list is not duplicated here.
export function isCheckpointable(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  if (segments.some((seg) => PROTECTED_DIR_NAMES.includes(seg))) return false;
  const base = segments[segments.length - 1] ?? '';
  return !matchesSecretPattern(base);
}

export type CheckpointOutcome = { hash: string } | { error: string };

// "pre-task" - commit marker, ALWAYS empty (--allow-empty --only, without pathspec): real
// empirical test confirmed that --only with empty pathspec ignores staged changes
// the entire user, leaving them staged as they were. If instead of --only we gave naked
// --allow-empty, any staged user changes would flow into our commit - this is what
// the very integrity of history (problem B.9), verified experimentally, not assumed.
export async function preTaskCheckpoint(cwd: string, taskId: string, runGitFn: GitRunner = runGit): Promise<CheckpointOutcome> {
  try {
    await runGitFn(['commit', '--allow-empty', '--only', '-m', `freeagent: pre-task ${taskId}`], cwd);
    const { stdout } = await runGitFn(['rev-parse', 'HEAD'], cwd);
    return { hash: stdout.trim() };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

// "done" - commits the actual contents of the step. Explicit `git add -- <files>` (never `git add .`),
// then `git commit --only -- <files>` - pathspec on commit too, double guarantee: even if
// the user had something else staged, the commit captures STRICTLY the files of this step (task
//B.9/B.10). --allow-empty ensures that commit #2 always exists, even if all files
// the steps turned out to be non-checkpointable (privacy/service) - “two commits per task” is not violated.
export async function doneCheckpoint(cwd: string, taskId: string, files: string[], summary: string, runGitFn: GitRunner = runGit): Promise<CheckpointOutcome> {
  const toAdd = files.filter(isCheckpointable);
  try {
    if (toAdd.length > 0) {
      await runGitFn(['add', '--', ...toAdd], cwd);
    }
    const pathspec = toAdd.length > 0 ? ['--', ...toAdd] : [];
    await runGitFn(['commit', '--allow-empty', '--only', '-m', `freeagent: ${taskId} — ${summary}`, ...pathspec], cwd);
    const { stdout } = await runGitFn(['rev-parse', 'HEAD'], cwd);
    return { hash: stdout.trim() };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

export type RevertOutcome = { ok: true } | { ok: false; conflict: boolean; detail: string };

// /undo → git revert, never git reset (user history is inviolable, task B.12).
// Conflict → stop, return the details as is - NOT git revert --abort (that would also be
// automatic solution) and DO NOT try to resolve it yourself. The repository remains in the state
// conflicting revert, the user decides himself using regular git commands.
export async function undoCheckpoint(cwd: string, entry: CheckpointEntry, runGitFn: GitRunner = runGit): Promise<RevertOutcome> {
  if (!entry.done_commit) return { ok: false, conflict: false, detail: 'no done commit recorded for this task' };
  try {
    await runGitFn(['revert', '--no-edit', entry.done_commit], cwd);
    return { ok: true };
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err);
    const conflict = /conflict/i.test(detail);
    return { ok: false, conflict, detail };
  }
}

// /undo - the outcome is visible to the user via /log (self-NOTIFY, the same principle as
// planViolationNotify/unverifiedNotify: to:'cli', does not waste the orchestrator context on the decision,
// which he should not accept).
export function undoOutcomeNotify(taskId: string, ok: boolean, detail: string): BusMessage {
  const payload: NotifyPayload = { event: ok ? 'UNDO_DONE' : 'UNDO_FAILED', details: `task ${taskId}: ${detail}` };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

export async function isGitRepo(cwd: string, runGitFn: GitRunner = runGit): Promise<boolean> {
  return runGitFn(['rev-parse', '--is-inside-work-tree'], cwd)
    .then(() => true)
    .catch(() => false);
}
