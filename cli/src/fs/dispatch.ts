// Диспетчер {op,args} → [FS_RESULT] (spec_file_access "Enforcement на стороне CLI").
// UNKNOWN_OP/BAD_ARGS проверяются здесь, до похода на диск; PATH_ESCAPE/FORBIDDEN_PATH/NOT_FOUND
// приходят из fs.*-функций (path guard уже часть каждой из них).
import { FS_OPS, type FsOp, type FsResult, fsError } from './types.ts';
import { read } from './read.ts';
import { list } from './list.ts';
import { search } from './search.ts';
import { write } from './write.ts';
import { edit } from './edit.ts';

export interface FsCallArgs {
  op: string;
  path?: string;
  depth?: string;
  query?: string;
  type?: string;
  kind?: string;
  body?: string; // write: тело heredoc
  old?: string; // edit: фрагмент до ---NEW---
  new?: string; // edit: фрагмент после ---NEW---
}

function isFsOp(op: string): op is FsOp {
  return (FS_OPS as readonly string[]).includes(op);
}

export async function dispatch(root: string, call: FsCallArgs): Promise<FsResult> {
  if (!isFsOp(call.op)) {
    return fsError('UNKNOWN_OP', `unknown op: ${call.op}`, `valid ops: ${FS_OPS.join(', ')}`);
  }

  switch (call.op) {
    case 'read':
      if (!call.path) return fsError('BAD_ARGS', 'read requires path');
      return read(root, call.path);

    case 'list':
      if (!call.path) return fsError('BAD_ARGS', 'list requires path');
      return list(root, call.path, call.depth !== undefined ? Number(call.depth) : 1);

    case 'search':
      if (!call.query) return fsError('BAD_ARGS', 'search requires query');
      return search(root, call.query, (call.type as 'content' | 'name') ?? 'content', call.path ?? '.');

    case 'write':
      if (!call.path) return fsError('BAD_ARGS', 'write requires path');
      if (call.body === undefined) return fsError('BAD_ARGS', 'write requires a heredoc body');
      return write(root, call.path, call.body, call.kind);

    case 'edit':
      if (!call.path) return fsError('BAD_ARGS', 'edit requires path');
      if (call.old === undefined || call.new === undefined) {
        return fsError('BAD_ARGS', 'edit requires ---OLD---/---NEW--- body');
      }
      return edit(root, call.path, call.old, call.new);
  }
}

export function renderFsResult(result: FsResult): string {
  return `[FS_RESULT]\n${JSON.stringify(result)}\n[/FS_RESULT]`;
}
