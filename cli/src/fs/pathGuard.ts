// Validate the path from the agent - the only entrance to the disk is from here (ARCHITECTURE §11,
// spec_write_path_validation). Levels 1-2 (traversal, protected paths) + level-3 (possession of
// PlanStep.files, PR-8) - all three are here, at one point (spec_plan_execution task C).
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fsError, type FsResult } from './types.ts';
import { PROTECTED_DIR_NAMES, matchesSecretPattern } from './privacyRules.ts';

function isWithin(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r + sep);
}

export type PathCheck = { ok: true; resolved: string } | { ok: false; error: FsResult & { ok: false } };

// Realpath injection (default is real fs.realpath): symlink escape on Windows without
// Developer Mode/admin cannot be created on disk (EPERM), but the logic itself "realpath took away
// root limits -> PATH_ESCAPE" must be checked unconditionally on any platform - the test replaces
// this function without creating a real symlink (spec_write_path_validation Test 8).
export type RealpathFn = (path: string) => Promise<string>;

// Level 1: traversal. Used by all five operations.
export async function resolveInRoot(root: string, relPath: string, realpathFn: RealpathFn = realpath): Promise<PathCheck> {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, error: fsError('BAD_ARGS', 'path is required') as FsResult & { ok: false } };
  }
  if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      error: fsError('PATH_ESCAPE', `path escapes project root: ${relPath}`, 'use a path relative to the project root') as FsResult & {
        ok: false;
      },
    };
  }
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, relPath);
  if (!isWithin(rootResolved, resolved)) {
    return {
      ok: false,
      error: fsError('PATH_ESCAPE', `path escapes project root: ${relPath}`, 'use a path relative to the project root') as FsResult & {
        ok: false;
      },
    };
  }
  // A symlink can lead outside the root even when the lexical path is inside - check that
  // if the path already exists (write to a new file does not have to exist).
  try {
    const real = await realpathFn(resolved);
    const realRoot = await realpathFn(rootResolved);
    if (!isWithin(realRoot, real)) {
      return {
        ok: false,
        error: fsError('PATH_ESCAPE', `path escapes project root via symlink: ${relPath}`, 'use a path relative to the project root') as FsResult & {
          ok: false;
        },
      };
    }
  } catch {
    // path does not exist yet - ok for write/edit to create a new file
  }
  return { ok: true, resolved };
}

// Pattern matching (PR-7), not exact segment comparison: .env.local / *.pem / node_modules
// (of any depth) are now also protected, the list is a common point of truth privacyRules.
function isProtected(root: string, resolved: string): boolean {
  const relFromRoot = resolved.slice(resolve(root).length).replace(/^[\\/]+/, '');
  const segments = relFromRoot.split(/[\\/]/);
  if (segments.some((seg) => PROTECTED_DIR_NAMES.includes(seg))) return true;
  const base = segments[segments.length - 1] ?? '';
  return matchesSecretPattern(base);
}

// Level 1+2+3: only write/edit is used. ownedFiles — files of the current agent step from
// plan_execution; null/undefined means “no plan or yolo” - level-3 is skipped entirely
// (spec_write_path_validation §3, "if the plan is not executed, level 3 is skipped").
export async function validateWritePath(root: string, relPath: string, ownedFiles?: string[] | null): Promise<PathCheck> {
  const base = await resolveInRoot(root, relPath);
  if (!base.ok) return base;
  if (isProtected(root, base.resolved)) {
    return {
      ok: false,
      error: fsError('FORBIDDEN_PATH', `path is protected: ${relPath}`, 'do not touch service paths; write only to task files') as FsResult & {
        ok: false;
      },
    };
  }

  if (ownedFiles) {
    const relFromRoot = relative(resolve(root), base.resolved).split(sep).join('/');
    if (!ownedFiles.includes(relFromRoot)) {
      return {
        ok: false,
        error: fsError(
          'FILE_NOT_OWNED',
          `path is outside the current step's files: ${relPath}`,
          `allowed files for this step: ${ownedFiles.join(', ')}`,
        ) as FsResult & { ok: false },
      };
    }
  }

  return base;
}
