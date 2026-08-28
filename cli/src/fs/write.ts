// fs.write (spec_file_access): создать/перезаписать файл. kind записывается, не enforced в PR-4.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { validateWritePath } from './pathGuard.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

export type WriteKind = 'code' | 'test' | 'doc' | 'data';
const VALID_KINDS: WriteKind[] = ['code', 'test', 'doc', 'data'];

export async function write(root: string, path: string, content: string, kind?: string): Promise<FsResult> {
  if (typeof content !== 'string') return fsError('BAD_ARGS', 'write body is required');
  const resolvedKind: WriteKind = VALID_KINDS.includes(kind as WriteKind) ? (kind as WriteKind) : 'code';

  const check = await validateWritePath(root, path);
  if (!check.ok) return check.error;

  const existed = await stat(check.resolved).then(() => true).catch(() => false);
  try {
    await mkdir(dirname(check.resolved), { recursive: true });
    await writeFile(check.resolved, content, 'utf8');
  } catch (err) {
    return fsError('IO_ERROR', String(err instanceof Error ? err.message : err));
  }

  return fsOk({
    path: relative(root, check.resolved).split('\\').join('/'),
    bytes_written: Buffer.byteLength(content, 'utf8'),
    created: !existed,
    kind: resolvedKind,
  });
}
