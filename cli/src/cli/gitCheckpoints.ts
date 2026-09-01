// Автокоммит шагов агентов + /undo (spec_git_checkpoints, ARCHITECTURE §10/§11). child_process
// git, не libgit2 (constraint) — целевая аудитория точно имеет git в PATH.
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

// Не коммитить (задача B.11): /freeagent/ и privacy-исключения — общий источник истины
// (privacyRules.ts, PR-7), список не дублируется здесь.
export function isCheckpointable(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  if (segments.some((seg) => PROTECTED_DIR_NAMES.includes(seg))) return false;
  const base = segments[segments.length - 1] ?? '';
  return !matchesSecretPattern(base);
}

export type CheckpointOutcome = { hash: string } | { error: string };

// "pre-task" — коммит-маркер, ВСЕГДА пустой (--allow-empty --only, без pathspec): реальный
// эмпирический тест подтвердил, что --only с пустым pathspec игнорирует staged-изменения
// пользователя целиком, оставляя их staged как были. Если бы вместо --only мы дали голый
// --allow-empty, любые staged-изменения пользователя утекли бы в наш коммит — это и есть та
// самая неприкосновенность истории (задача B.9), проверено экспериментально, не предположено.
export async function preTaskCheckpoint(cwd: string, taskId: string, runGitFn: GitRunner = runGit): Promise<CheckpointOutcome> {
  try {
    await runGitFn(['commit', '--allow-empty', '--only', '-m', `freeagent: pre-task ${taskId}`], cwd);
    const { stdout } = await runGitFn(['rev-parse', 'HEAD'], cwd);
    return { hash: stdout.trim() };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

// "done" — коммит реального содержимого шага. Явный `git add -- <files>` (никогда `git add .`),
// затем `git commit --only -- <files>` — pathspec на commit тоже, двойная гарантия: даже если
// у пользователя было что-то ещё staged, коммит захватывает СТРОГО files этого шага (задача
// B.9/B.10). --allow-empty гарантирует, что коммит #2 существует всегда, даже если все files
// шага оказались non-checkpointable (privacy/служебные) — "два коммита на task" не нарушается.
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

// /undo → git revert, никогда git reset (история пользователя неприкосновенна, задача B.12).
// Конфликт → стоп, вернуть детали как есть — НЕ git revert --abort (это тоже было бы
// автоматическим решением) и НЕ пытаться разрешить самим. Репозиторий остаётся в состоянии
// конфликтующего revert, пользователь решает сам обычными git-командами.
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

// /undo — исход виден пользователю через /log (self-NOTIFY, тот же принцип, что
// planViolationNotify/unverifiedNotify: to:'cli', не тратит контекст оркестратора на решение,
// которое ему не принимать).
export function undoOutcomeNotify(taskId: string, ok: boolean, detail: string): BusMessage {
  const payload: NotifyPayload = { event: ok ? 'UNDO_DONE' : 'UNDO_FAILED', details: `task ${taskId}: ${detail}` };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

export async function isGitRepo(cwd: string, runGitFn: GitRunner = runGit): Promise<boolean> {
  return runGitFn(['rev-parse', '--is-inside-work-tree'], cwd)
    .then(() => true)
    .catch(() => false);
}
