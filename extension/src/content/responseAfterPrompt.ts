// Anchor to the submitted message: virtualized chats may remove older turns,
// so neither the number of response nodes nor global protocol counts must grow.
export function responseAfterPrompt(current: string, baseline: string, prompt: string): string | null {
  const escaped = prompt.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!escaped) return null;
  const pattern = new RegExp(escaped, 'g');
  const match = Array.from(current.matchAll(pattern)).at(-1);
  if (!match) return null;
  const previous = Array.from(baseline.matchAll(pattern)).at(-1);
  if (previous && current.slice(0, match.index + match[0].length) === baseline.slice(0, previous.index + previous[0].length)) return null;

  const tail = current.slice(match.index + match[0].length);
  const start = tail.search(/\[READY\]|\[PLAN\]|\[FS\s*\||\[MSG\s*\|[^\]]*type:\s*(?:RESULT|STATUS|TESTS_READY)\b/);
  // Keep all blocks and preserve newlines, including FS write bodies.
  return start < 0 ? null : tail.slice(start);
}
