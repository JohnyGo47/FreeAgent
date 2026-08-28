// Фильтр мусора для list/search (spec_file_access "list обязан фильтровать мусор по умолчанию").
// ponytail: упрощённый gitignore-матчер (без **, отрицаний, escape-последовательностей) —
// покрывает обычные строки/каталоги/*.ext из .gitignore и .freeagentignore. Апгрейд до полного
// gitignore-парсера — когда реальные проекты покажут, что этого не хватает.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BUILTIN_JUNK = ['.git', 'node_modules', 'dist', 'build'];

function patternToRegExp(pattern: string): RegExp {
  const dirOnly = pattern.endsWith('/');
  let p = dirOnly ? pattern.slice(0, -1) : pattern;
  if (p.startsWith('/')) p = p.slice(1);
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

async function readIgnoreFile(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export interface IgnoreMatcher {
  isIgnored(relPath: string): boolean;
}

export async function loadIgnoreMatcher(root: string): Promise<IgnoreMatcher> {
  const patterns = [...BUILTIN_JUNK, ...(await readIgnoreFile(join(root, '.gitignore'))), ...(await readIgnoreFile(join(root, '.freeagentignore')))];
  const regexes = patterns.map(patternToRegExp);
  return {
    isIgnored(relPath: string): boolean {
      const posix = relPath.split('\\').join('/');
      return regexes.some((re) => re.test(posix));
    },
  };
}
