// Единая точка истины для защищаемых путей (PR-7). pathGuard (запрет записи,
// spec_write_path_validation A.1) и privacyFilter (запрет чтения/показа в дереве,
// spec_context_privacy_filter B.5) читают список отсюда — не дублируют его.

export const SECRET_FILE_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*'];

// Каталоги, запись в которые запрещена целиком на любой глубине (write_path_validation A.1).
export const PROTECTED_DIR_NAMES = ['.git', 'freeagent', 'node_modules'];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const SECRET_FILE_REGEXES = SECRET_FILE_PATTERNS.map(globToRegExp);

export function matchesSecretPattern(basename: string): boolean {
  return SECRET_FILE_REGEXES.some((re) => re.test(basename));
}
