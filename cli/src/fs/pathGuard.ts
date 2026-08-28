// Валидация пути от агента — единственный вход к диску проходит отсюда (ARCHITECTURE §11,
// spec_file_access "Enforcement на стороне CLI" уровни 1-2). Уровень-3 (владение по PlanStep.files)
// — PR-7, не здесь.
import { isAbsolute, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fsError, type FsResult } from './types.ts';

// Фиксированный список защищённых путей PR-4. PR-7 расширит уровнем-3.
const PROTECTED_SEGMENTS = ['.git', '.env', 'freeagent'];

function isWithin(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r + sep);
}

export type PathCheck = { ok: true; resolved: string } | { ok: false; error: FsResult & { ok: false } };

// Уровень 1: traversal. Используется всеми пятью операциями.
export async function resolveInRoot(root: string, relPath: string): Promise<PathCheck> {
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
  // Симлинк может уводить за пределы корня даже когда лексический путь внутри — проверяем,
  // если путь уже существует (write в новый файл существовать не обязан).
  try {
    const real = await realpath(resolved);
    const realRoot = await realpath(rootResolved);
    if (!isWithin(realRoot, real)) {
      return {
        ok: false,
        error: fsError('PATH_ESCAPE', `path escapes project root via symlink: ${relPath}`, 'use a path relative to the project root') as FsResult & {
          ok: false;
        },
      };
    }
  } catch {
    // путь ещё не существует — ок для write/edit создания нового файла
  }
  return { ok: true, resolved };
}

function isProtected(root: string, resolved: string): boolean {
  const relFromRoot = resolved.slice(resolve(root).length).replace(/^[\\/]+/, '');
  const firstSegment = relFromRoot.split(/[\\/]/)[0];
  return PROTECTED_SEGMENTS.includes(firstSegment);
}

// Уровень 1+2: используется только write/edit. PR-7 обернёт это уровнем-3.
export async function validateWritePath(root: string, relPath: string): Promise<PathCheck> {
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
  return base;
}
