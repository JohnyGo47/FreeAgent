// Валидация пути от агента — единственный вход к диску проходит отсюда (ARCHITECTURE §11,
// spec_write_path_validation). Уровни 1-2 (traversal, защищённые пути) + уровень-3 (владение по
// PlanStep.files, PR-8) — все три здесь, в одной точке (spec_plan_execution задача C).
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

// Инъекция realpath (по умолчанию — настоящий fs.realpath): symlink-эскейп на Windows без
// Developer Mode/admin нельзя создать на диске (EPERM), но саму логику "realpath увёл за
// пределы корня -> PATH_ESCAPE" нужно проверять безусловно на любой платформе — тест подменяет
// эту функцию, реального симлинка не создавая (spec_write_path_validation Test 8).
export type RealpathFn = (path: string) => Promise<string>;

// Уровень 1: traversal. Используется всеми пятью операциями.
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
  // Симлинк может уводить за пределы корня даже когда лексический путь внутри — проверяем,
  // если путь уже существует (write в новый файл существовать не обязан).
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
    // путь ещё не существует — ок для write/edit создания нового файла
  }
  return { ok: true, resolved };
}

// Паттерн-матчинг (PR-7), не точное сравнение сегмента: .env.local / *.pem / node_modules
// (любой глубины) теперь тоже защищены, список — общая точка истины privacyRules.
function isProtected(root: string, resolved: string): boolean {
  const relFromRoot = resolved.slice(resolve(root).length).replace(/^[\\/]+/, '');
  const segments = relFromRoot.split(/[\\/]/);
  if (segments.some((seg) => PROTECTED_DIR_NAMES.includes(seg))) return true;
  const base = segments[segments.length - 1] ?? '';
  return matchesSecretPattern(base);
}

// Уровень 1+2+3: используется только write/edit. ownedFiles — files текущего шага агента из
// plan_execution; null/undefined значит «плана нет или yolo» — уровень-3 пропускается целиком
// (spec_write_path_validation §3, "если план не исполняется — уровень 3 пропускается").
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
