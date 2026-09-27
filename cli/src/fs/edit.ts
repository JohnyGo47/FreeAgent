// fs.edit (spec_file_access): replace the only occurrence of old with new. Non-unique old —
// always an error, never a silent no-op.
import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { validateWritePath } from './pathGuard.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

export async function edit(root: string, path: string, oldStr: string, newStr: string, ownedFiles?: string[] | null): Promise<FsResult> {
  if (typeof oldStr !== 'string' || oldStr.length === 0) return fsError('BAD_ARGS', 'old fragment is required');
  if (typeof newStr !== 'string') return fsError('BAD_ARGS', 'new fragment is required');

  const check = await validateWritePath(root, path, ownedFiles);
  if (!check.ok) return check.error;

  const content = await readFile(check.resolved, 'utf8').catch(() => null);
  if (content === null) {
    return fsError('NOT_FOUND', `not found: ${path}`, 'use list/search to find the target');
  }

  const occurrences = countOccurrences(content, oldStr);
  if (occurrences === 0) {
    return fsError('NOT_FOUND', `old fragment not found in ${path}`, 'use list/search to find the target');
  }
  if (occurrences > 1) {
    return fsError('AMBIGUOUS_MATCH', `old fragment matches ${occurrences} times in ${path}`, 'add surrounding context for a unique match');
  }

  const idx = content.indexOf(oldStr);
  const replaced = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);

  try {
    await writeFile(check.resolved, replaced, 'utf8');
  } catch (err) {
    return fsError('IO_ERROR', String(err instanceof Error ? err.message : err));
  }

  return fsOk({ path: relative(root, check.resolved).split('\\').join('/'), replaced: true });
}
