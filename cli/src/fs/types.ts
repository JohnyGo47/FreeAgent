// Типы файлового доступа агента (spec_file_access v1.1). Не путать с extension/src/fs/ —
// там FSA-доступ браузера к папке проекта; здесь — node:fs по корню из freeagent.config.json.

export const FS_OPS = ['list', 'search', 'read', 'write', 'edit'] as const;
export type FsOp = typeof FS_OPS[number];

export const FS_ERROR_CODES = [
  'UNKNOWN_OP',
  'PATH_ESCAPE',
  'FORBIDDEN_PATH',
  'NOT_FOUND',
  'AMBIGUOUS_MATCH',
  'BAD_ARGS',
  'MULTIPLE_CALLS',
  'FILE_TOO_LARGE',
  'IO_ERROR',
] as const;
export type FsErrorCode = typeof FS_ERROR_CODES[number];

export interface FsError {
  code: FsErrorCode;
  message: string;
  hint?: string;
}

export type FsResult = { ok: true; data: unknown } | { ok: false; error: FsError };

export function fsError(code: FsErrorCode, message: string, hint?: string): FsResult {
  return { ok: false, error: hint ? { code, message, hint } : { code, message } };
}

export function fsOk(data: unknown): FsResult {
  return { ok: true, data };
}
