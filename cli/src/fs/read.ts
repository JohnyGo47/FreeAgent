// fs.read (spec_file_access): чтение файла с byte-cap, path guard первым.
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { resolveInRoot } from './pathGuard.ts';
import { loadPrivacyMatcher, checkReadExclusion, maskSecrets } from './privacyFilter.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

// Значение — заглушка PR-4 (Open items: калибруется на реальных прогонах).
export const READ_BYTE_CAP = 200_000;

export async function read(root: string, path: string): Promise<FsResult> {
  const check = await resolveInRoot(root, path);
  if (!check.ok) return check.error;

  const relPath = relative(root, check.resolved).split('\\').join('/');

  // Слой 1 (spec_context_privacy_filter): секретный файл не отдаётся агенту целиком, до чтения.
  const privacyMatcher = await loadPrivacyMatcher(root);
  const exclusion = await checkReadExclusion(root, relPath, privacyMatcher);
  if (exclusion) {
    console.warn(`[privacy] excluded from READ: ${relPath} (${exclusion.reason})`);
    return fsError('PRIVACY_EXCLUDED', `file excluded by privacy rules: ${path}`, 'this file is filtered; secrets are not sent to the agent');
  }

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
    const basename = relPath.split('/').pop() ?? relPath;
    const { masked, count } = maskSecrets(content, basename);
    if (count > 0) console.warn(`[privacy] masked ${count} value(s) in ${relPath}`);
    return fsOk({ path: relPath, content: masked });
  } catch (err) {
    return fsError('IO_ERROR', String(err instanceof Error ? err.message : err));
  }
}
