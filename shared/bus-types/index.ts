import { log } from '../log.ts';

// задачи и результаты / жизненный цикл агента / файлы / планирование / здоровье / системное
export const MESSAGE_TYPES = [
  'TASK', 'RESULT', 'STATUS',
  'READY', 'REGISTER_REQUEST', 'TAB_STATE', 'HEARTBEAT',
  'WRITE', 'READ', 'TESTS_READY',
  'PLAN', 'PLAN_REVISED', 'APPROVED',
  'RESPONSE_HEALTH',
  'NOTIFY', 'COMMAND', 'ERROR',
] as const;
export type MessageType = typeof MESSAGE_TYPES[number];

// IDLE/WORKING — единственная «рабочая» зона; ACTIVE намеренно отсутствует (ARCHITECTURE §7, ревизия v1.1 #47)
export const AGENT_STATUSES = [
  'INITIALIZING',
  'INIT_FAILED',
  'IDLE',
  'WORKING',
  'SWITCHING',
  'BLOCKED',
  'SELECTOR_BROKEN',
  'SERVICE_DOWN',
  'STANDBY',
  'FAILED',
] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export interface BusMessage {
  id: string;          // uuid, ставит отправитель при создании; стабилен до записи в incoming; дедуп мержа
  seq?: number;         // только в главной шине, присваивает CLI при мерже
  from: string;         // agent_id | 'user' | 'cli' | 'extension' | instance_id
  to: string;            // agent_id | 'orchestrator' | 'cli' | 'extension' | 'broadcast'
  type: MessageType;
  ts: string;             // ISO 8601 UTC
  payload: unknown;
}

export interface TaskPayload { task_id: string; description: string; files?: string[]; retry?: boolean }
export interface ResultPayload { task_id: string; status: 'DONE' | 'FAILED'; summary: string; self_assessment?: { percent: number; reasoning: string } }
export interface StatusPayload { state: 'WORKING' | 'IDLE'; task_id?: string }
export interface WritePayload { path: string; content: string; kind: 'code' | 'test' | 'doc' | 'data' }
export interface ReadPayload { path: string }
export interface TestsReadyPayload { task_id: string; command: string }
export interface TabStatePayload { agent_id: string; state: 'alive' | 'closed' | 'wrong_domain' | 'selectors_broken'; context_pct?: number }
export interface RegisterPayload { role: string; llm_url: string; tab_id: number; name?: string; is_backup_for?: string }
export interface HealthPayload { agent_id: string; klass: 'unavailable' | 'rate_limited' | 'context_full' | 'no_tags'; raw_excerpt: string }
export interface PlanStep { step_id: number; agent_id: string; description: string; files: string[]; depends_on: number[] }
export interface PlanPayload { steps: PlanStep[] }
export interface CommandPayload { command: string; agent_id?: string; args?: Record<string, unknown> }
export interface NotifyPayload { event: string; agent_id?: string; details?: string }
export interface ErrorPayload { message: string; context?: string; valid_agents?: string[] }

export type ParseResult = { ok: true; msg: BusMessage } | { ok: false; error: string };

const REQUIRED_STRING_FIELDS = ['id', 'from', 'to', 'type', 'ts'] as const;

export function parseBusLine(line: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (typeof obj !== 'object' || obj === null) {
    return { ok: false, error: 'not a JSON object' };
  }
  const rec = obj as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof rec[field] !== 'string') {
      return { ok: false, error: `missing or invalid field: ${field}` };
    }
  }
  if (!MESSAGE_TYPES.includes(rec.type as MessageType)) {
    return { ok: false, error: `unknown type: ${String(rec.type)}` };
  }
  if (Number.isNaN(Date.parse(rec.ts as string))) {
    return { ok: false, error: `invalid ts: ${String(rec.ts)}` };
  }
  if (rec.seq !== undefined && typeof rec.seq !== 'number') {
    return { ok: false, error: 'invalid seq' };
  }

  return {
    ok: true,
    msg: {
      id: rec.id as string,
      seq: rec.seq as number | undefined,
      from: rec.from as string,
      to: rec.to as string,
      type: rec.type as MessageType,
      ts: rec.ts as string,
      payload: rec.payload,
    },
  };
}

// Тег-формат — только слой перевода для чата LLM; id/seq в него не входят (ARCHITECTURE §4).
export function toTagFormat(msg: BusMessage): string {
  return `[MSG | from: ${msg.from} | to: ${msg.to} | type: ${msg.type}]\n${JSON.stringify(msg.payload)}\n[/MSG]`;
}

function parseHeader(header: string): { from: string; to: string; type: string } | null {
  const attrs: Record<string, string> = {};
  for (const part of header.split('|')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) attrs[key] = value;
  }
  if (!attrs.type) return null;
  return { from: attrs.from ?? '', to: attrs.to ?? '', type: attrs.type };
}

const OPEN_TAG_RE = /\[MSG\s*\|([\s\S]*?)\]/g;
const CLOSE_TAG = '[/MSG]';

export function fromTagFormat(text: string): BusMessage[] {
  const cleaned = text.replace(/```[a-zA-Z]*\r?\n?/g, '').replace(/```/g, '');
  const results: BusMessage[] = [];

  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(cleaned))) {
    const header = parseHeader(match[1]);
    const bodyStart = OPEN_TAG_RE.lastIndex;
    const closeIdx = cleaned.indexOf(CLOSE_TAG, bodyStart);
    const unclosed = closeIdx === -1;
    const body = unclosed ? cleaned.slice(bodyStart) : cleaned.slice(bodyStart, closeIdx);

    if (unclosed) {
      log.warn(`fromTagFormat: unclosed [MSG] tag at position ${match.index}`);
    }

    if (header) {
      try {
        const payload = JSON.parse(body.trim());
        results.push({
          id: '', // присваивается отправителем/расширением при выходе за пределы тег-формата (ARCHITECTURE §4)
          from: header.from,
          to: header.to,
          type: header.type as MessageType,
          ts: new Date().toISOString(),
          payload,
        });
      } catch {
        log.warn(`fromTagFormat: invalid JSON payload at position ${match.index}`);
      }
    } else {
      log.warn(`fromTagFormat: malformed header at position ${match.index}`);
    }

    if (unclosed) break;
    OPEN_TAG_RE.lastIndex = closeIdx + CLOSE_TAG.length;
  }

  return results;
}
