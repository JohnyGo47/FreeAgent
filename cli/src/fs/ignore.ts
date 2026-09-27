// Garbage filter for list/search (spec_file_access "list must filter garbage by default").
// ponytail: simplified gitignore matcher (no **, negations, escape sequences) -
// covers regular strings/directories/*.ext from .gitignore and .freeagentignore. Upgrade to full
// gitignore parser - when real projects show that this is missing.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_FILE_PATTERNS } from './privacyRules.ts';

const BUILTIN_JUNK = ['.git', 'node_modules', 'dist', 'build'];

export function patternToRegExp(pattern: string): RegExp {
  const dirOnly = pattern.endsWith('/');
  let p = dirOnly ? pattern.slice(0, -1) : pattern;
  if (p.startsWith('/')) p = p.slice(1);
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

export async function readIgnoreFile(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export interface IgnoreMatcher {
  isIgnored(relPath: string): boolean;
}

export function buildMatcher(patterns: string[]): IgnoreMatcher {
  const regexes = patterns.map(patternToRegExp);
  return {
    isIgnored(relPath: string): boolean {
      const posix = relPath.split('\\').join('/');
      return regexes.some((re) => re.test(posix));
    },
  };
}

// Secret patterns (privacyRules) are mixed in here - the tree/search should not be shown
// .env/*.pem is just like regular garbage (spec_context_privacy_filter B, "not visible in the tree").
export async function loadIgnoreMatcher(root: string): Promise<IgnoreMatcher> {
  const patterns = [
    ...BUILTIN_JUNK,
    ...SECRET_FILE_PATTERNS,
    ...(await readIgnoreFile(join(root, '.gitignore'))),
    ...(await readIgnoreFile(join(root, '.freeagentignore'))),
  ];
  return buildMatcher(patterns);
}
