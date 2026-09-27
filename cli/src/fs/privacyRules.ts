// Single point of truth for protected paths (PR-7). pathGuard (write prohibition,
// spec_write_path_validation A.1) and privacyFilter (prohibition of reading/displaying in the tree,
// spec_context_privacy_filter B.5) read the list from here - do not duplicate it.

export const SECRET_FILE_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*'];

// Directories in which writing is completely prohibited at any depth (write_path_validation A.1).
export const PROTECTED_DIR_NAMES = ['.git', 'freeagent', 'node_modules'];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const SECRET_FILE_REGEXES = SECRET_FILE_PATTERNS.map(globToRegExp);

export function matchesSecretPattern(basename: string): boolean {
  return SECRET_FILE_REGEXES.some((re) => re.test(basename));
}
