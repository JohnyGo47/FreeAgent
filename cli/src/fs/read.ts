// fs.read (spec_file_access): чтение файла с byte-cap, path guard первым.
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { resolveInRoot } from './pathGuard.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

// Значение — заглушка PR-4 (Open items: калибруется на реальных прогонах).
export const READ_BYTE_CAP = 200_000;

export async function read(root: string, path: string): Promise<FsResult> {
  const check = await resolveInRoot(root, path);
  if (!check.ok) return check.error;

  const st = await stat(check.resolved).catch(() => null);
  if (!st) {
    return fsError('NOT_FOUND', `not found: ${path}`, 'use list/search to find the target');
  }
  if (!st.isFile()) {
    return fsError('NOT_FOUND', `not a file: ${path}`, 'use list/search to find the target');
  }
  if (st.size > READ_BYTE_CAP) {
    return fsError('FILE_TOO_LARGE', `file exceeds ${READ_BYTE_CAP} bytes: ${path}`, 'read in parts or narrow via search');
  }

  try {
    const content = await readFile(check.resolved, 'utf8');
    return fsOk({ path: relative(root, check.resolved).split('\\').join('/'), content });
  } catch (err) {
    return fsError('IO_ERROR', String(err instanceof Error ? err.message : err));
  }
}
