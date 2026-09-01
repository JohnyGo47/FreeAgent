// spec_context_privacy_filter (PR-7, задача B): секреты пользователя не уходят в контекст
// бесплатных LLM. Слой 1 — файл целиком не отдаётся по READ (built-in паттерны + .freeagentignore
// + .npmrc с _authToken). Слой 2 — маскирование похожих на секреты значений внутри разрешённых
// файлов. Точка вызова — read.ts, перед возвратом content (единственная точка, spec Constraints).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMatcher, readIgnoreFile, type IgnoreMatcher } from './ignore.ts';
import { SECRET_FILE_PATTERNS } from './privacyRules.ts';

// Уже своя, более узкая матчер: только секретные паттерны + пользовательский .freeagentignore —
// без .gitignore/BUILTIN_JUNK (dist/build мусор не про приватность, читать их можно).
export async function loadPrivacyMatcher(root: string): Promise<IgnoreMatcher> {
  const patterns = [...SECRET_FILE_PATTERNS, ...(await readIgnoreFile(join(root, '.freeagentignore')))];
  return buildMatcher(patterns);
}

export interface ExclusionResult {
  excluded: boolean;
  reason: string;
}

export async function checkReadExclusion(root: string, relPath: string, matcher: IgnoreMatcher): Promise<ExclusionResult | null> {
  const posix = relPath.split('\\').join('/');
  if (matcher.isIgnored(posix)) return { excluded: true, reason: 'excluded by privacy rules' };

  const base = posix.split('/').pop() ?? posix;
  if (base === '.npmrc') {
    const content = await readFile(join(root, relPath), 'utf8').catch(() => '');
    if (content.includes('_authToken')) return { excluded: true, reason: '.npmrc contains _authToken' };
  }
  return null;
}

interface SecretPattern {
  type: string;
  re: RegExp;
}

// Прямо-опознаваемые формы секретов — работают в любом файле, кавычки не обязательны.
const SECRET_VALUE_PATTERNS: SecretPattern[] = [
  { type: 'api_key', re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { type: 'api_key', re: /\bpk_[A-Za-z0-9_-]{10,}/g },
  { type: 'aws_key', re: /\bAKIA[A-Z0-9]{12,}/g },
  { type: 'github_token', re: /\bghp_[A-Za-z0-9]{20,}/g },
  { type: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { type: 'connection_string', re: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/g },
  { type: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/g },
];

// Длинный токен в кавычках после `=`/`:` — кавычки отличают литерал ("sk-...") от голой
// конструкции языка (process.env.API_KEY без кавычек этому не соответствует, тест не ловит).
const QUOTED_TOKEN_RE = /([:=]\s*)(['"])([A-Za-z0-9+/_-]{16,}=*)\2/g;

// dotenv-подобный файл (test.env.example и т.п., но не сам .env — тот исключён целиком слоем 1):
// KEY=value без кавычек — единственный формат, который не поймать конструкцией языка, поэтому
// маскируем значение независимо от того, похоже ли оно на секрет (лучше перестраховаться).
const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.+)$/gm;

function isEnvLikeBasename(basename: string): boolean {
  return /\.env(\.|$)/i.test(basename);
}

export function maskSecrets(content: string, basename: string): { masked: string; count: number } {
  let count = 0;
  let out = content;

  for (const { type, re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return `[REDACTED: ${type}]`;
    });
  }

  out = out.replace(QUOTED_TOKEN_RE, (_m, pre: string, quote: string) => {
    count++;
    return `${pre}${quote}[REDACTED: token]${quote}`;
  });

  if (isEnvLikeBasename(basename)) {
    out = out.replace(ENV_ASSIGNMENT_RE, (m: string, pre: string, value: string) => {
      if (value.trim().length === 0) return m;
      count++;
      return `${pre}[REDACTED: env_value]`;
    });
  }

  return { masked: out, count };
}
