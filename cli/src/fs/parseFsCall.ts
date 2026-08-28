// parseFsCall (spec_file_access v1.1): текст → {op,args} + heredoc-тело до end:-маркера.
// Отдельно от fromTagFormat (/shared/bus-types) — та инлайнится в браузерный бандл и снимает
// бэктики/парсит JSON тело; здесь тело read дословно (write/edit — код с `|`/бэктиками/тегами
// внутри не должен ломаться), и парсер живёт только в CLI (disk-логика).
import type { FsCallArgs } from './dispatch.ts';

const HEADER_RE = /\[FS\s*\|([\s\S]*?)\]/g;
const NEEDS_BODY = new Set(['write', 'edit']);

function parseHeader(header: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of header.split('|')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) attrs[key] = value;
  }
  return attrs;
}

function findMarkerLine(text: string, fromIndex: number, marker: string): { start: number; end: number } | null {
  const re = new RegExp(`(^|\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`);
  const m = re.exec(text.slice(fromIndex));
  if (!m) return null;
  const lineStart = fromIndex + m.index + (m[1] === '\n' ? 1 : 0);
  const lineEnd = lineStart + marker.length;
  return { start: lineStart, end: lineEnd };
}

function splitEditBody(body: string): { old: string; new: string } | null {
  const oldTag = '---OLD---';
  const newTag = '---NEW---';
  const oldIdx = body.indexOf(oldTag);
  const newIdx = body.indexOf(newTag);
  if (oldIdx === -1 || newIdx === -1 || newIdx < oldIdx) return null;
  const old = body.slice(oldIdx + oldTag.length, newIdx).replace(/^\n/, '').replace(/\n$/, '');
  const newer = body.slice(newIdx + newTag.length).replace(/^\n/, '').replace(/\n$/, '');
  return { old, new: newer };
}

export interface ParsedFsCall {
  args: FsCallArgs;
}

export interface ParseFsResult {
  calls: ParsedFsCall[];
}

export function parseFsCall(text: string): ParseFsResult {
  const calls: ParsedFsCall[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    HEADER_RE.lastIndex = searchFrom;
    const match = HEADER_RE.exec(text);
    if (!match) break;

    const attrs = parseHeader(match[1]);
    const op = attrs.op ?? '';
    const headerEnd = HEADER_RE.lastIndex;

    if (NEEDS_BODY.has(op) && attrs.end) {
      const bodyStart = text[headerEnd] === '\n' ? headerEnd + 1 : headerEnd;
      const marker = findMarkerLine(text, bodyStart, attrs.end);
      if (!marker) {
        // маркер не найден — незакрытый вызов, тело недоступно, останавливаем сканирование
        calls.push({ args: { op, ...attrs } });
        break;
      }
      const rawBody = text.slice(bodyStart, marker.start).replace(/\n$/, '');
      const args: FsCallArgs = { op, ...attrs };
      if (op === 'edit') {
        const split = splitEditBody(rawBody);
        if (split) {
          args.old = split.old;
          args.new = split.new;
        }
      } else {
        args.body = rawBody;
      }
      calls.push({ args });
      searchFrom = marker.end;
    } else {
      calls.push({ args: { op, ...attrs } });
      searchFrom = headerEnd;
    }
  }

  return { calls };
}
