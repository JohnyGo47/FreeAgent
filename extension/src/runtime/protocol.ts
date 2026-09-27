import type { CommandPayload, BusMessage } from '../../../shared/bus-types/index.ts';
import { toTagFormat } from '../../../shared/bus-types/index.ts';
import type { OutgoingMessage } from '../bus/instanceBusWriter.ts';
import { extractMessages } from '../content/messageFormat.ts';

const AGENT_MESSAGE_TYPES = new Set(['RESULT', 'STATUS', 'TESTS_READY']);

export function commandText(message: BusMessage): string | null {
  if (message.type !== 'COMMAND') return toTagFormat(message);

  const payload = message.payload as CommandPayload;
  if (payload.command === 'TAB_STATE') return null;
  if (payload.command === 'INIT' && typeof payload.args?.text === 'string') return payload.args.text;
  return toTagFormat(message);
}

export function parseAgentResponse(agentId: string, text: string): OutgoingMessage[] {
  const ts = new Date().toISOString();
  const outgoing: OutgoingMessage[] = [];
  const extracted = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });

  for (const message of extracted.messages) {
    if (!AGENT_MESSAGE_TYPES.has(message.type)) continue;
    const { id: _id, seq: _seq, ...withoutTransportFields } = message;
    outgoing.push({ ...withoutTransportFields, from: agentId, ts });
  }

  const plan = text.match(/\[PLAN\][\s\S]*?\[\/PLAN\]/)?.[0];
  if (plan) outgoing.push({ from: agentId, to: 'cli', type: 'PLAN', ts, payload: plan });

  if (/\[READY\]/.test(text)) {
    outgoing.push({ from: agentId, to: 'cli', type: 'READY', ts, payload: {} });
  }

  if (extracted.fsCallText && !outgoing.some((message) => message.type === 'FS_CALL')) {
    outgoing.push({ from: agentId, to: 'cli', type: 'FS_CALL', ts, payload: extracted.fsCallText });
  }

  return outgoing;
}
