// spec_context_privacy_filter (PR-7, task B): user secrets do not go into the context
// free LLM. Layer 1 - the entire file is not served via READ (built-in patterns + .freeagentignore
// + .npmrc with _authToken). Layer 2 - masking secret-like values ​​inside allowed values
// files. The point of call is read.ts, before returning content (single point, spec Constraints).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMatcher, readIgnoreFile, type IgnoreMatcher } from './ignore.ts';
import { SECRET_FILE_PATTERNS } from './privacyRules.ts';

// Already our own, narrower matcher: only secret patterns + custom .freeagentignore -
// without .gitignore/BUILTIN_JUNK (dist/build garbage is not about privacy, you can read them).
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

// Directly identifiable forms of secrets - work in any file, quotes are not required.
const SECRET_VALUE_PATTERNS: SecretPattern[] = [
  { type: 'api_key', re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { type: 'api_key', re: /\bpk_[A-Za-z0-9_-]{10,}/g },
  { type: 'aws_key', re: /\bAKIA[A-Z0-9]{12,}/g },
  { type: 'github_token', re: /\bghp_[A-Za-z0-9]{20,}/g },
  { type: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { type: 'connection_string', re: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/g },
  { type: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/g },
];

// Long token in quotes after `=`/`:` - quotes distinguish a literal ("sk-...") from a bare one
// language constructs (process.env.API_KEY without quotes does not correspond to this, the test does not catch).
const QUOTED_TOKEN_RE = /([:=]\s*)(['"])([A-Za-z0-9+/_-]{16,}=*)\2/g;

// dotenv-like file (test.env.example, etc., but not .env itself - that one is excluded entirely by layer 1):
// KEY=value without quotes is the only format that cannot be caught by the language construct, so
// mask the value regardless of whether it looks like a secret (better to be safe).
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
