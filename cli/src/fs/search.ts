// fs.search (spec_file_access): поиск по содержимому (content) или по имени/пути (name).
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInRoot } from './pathGuard.ts';
import { loadIgnoreMatcher } from './ignore.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

// ponytail: cap на совпадения — ограничивает контекст модели. Значение — заглушка PR-4,
// калибруется на реальных прогонах (Open items spec_file_access).
const MAX_MATCHES_PER_FILE = 20;

async function walk(root: string, dirAbs: string, ignore: { isIgnored(p: string): boolean }, out: string[]): Promise<void> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dirAbs, e.name);
    const rel = relative(root, abs).split('\\').join('/');
    if (ignore.isIgnored(rel)) continue;
    if (e.isDirectory()) await walk(root, abs, ignore, out);
    else if (e.isFile()) out.push(abs);
  }
}

interface ContentMatch { path: string; matches: { line: number; text: string }[]; reason: string }

async function searchContent(root: string, files: string[], query: string): Promise<ContentMatch[]> {
  const results: ContentMatch[] = [];
  for (const abs of files) {
    const content = await readFile(abs, 'utf8').catch(() => null);
    if (content === null) continue;
    const lines = content.split('\n');
    const matches: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
      if (lines[i].includes(query)) matches.push({ line: i + 1, text: lines[i] });
    }
    if (matches.length > 0) {
      const rel = relative(root, abs).split('\\').join('/');
      results.push({ path: rel, matches, reason: `content match: '${query}' (${matches.length} occurrence${matches.length === 1 ? '' : 's'})` });
    }
  }
  return results;
}

interface NameMatch { path: string; reason: string }

function searchName(root: string, files: string[], query: string): NameMatch[] {
  const needle = query.toLowerCase();
  const results: NameMatch[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/');
    if (rel.toLowerCase().includes(needle)) {
      results.push({ path: rel, reason: `name match: '${query}'` });
    }
  }
  return results;
}

export async function search(root: string, query: string, type: 'content' | 'name', scopePath = '.'): Promise<FsResult> {
  if (!query) return fsError('BAD_ARGS', 'query is required');
  if (type !== 'content' && type !== 'name') return fsError('BAD_ARGS', `invalid type: ${String(type)}`);

  const check = await resolveInRoot(root, scopePath);
  if (!check.ok) return check.error;

  const ignore = await loadIgnoreMatcher(root);
  const files: string[] = [];
  await walk(root, check.resolved, ignore, files);

  const results = type === 'content' ? await searchContent(root, files, query) : searchName(root, files, query);
  return fsOk({ results });
}
