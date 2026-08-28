// Обновление agents_registry по сообщениям шины — механически, без LLM (ARCHITECTURE §12).
import { randomUUID } from 'node:crypto';
import type { BusMessage, StatusPayload } from '../../../shared/bus-types/index.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import { runFsTurn } from '../fs/pipeline.ts';

export function applyMessageToRegistry(msg: BusMessage, registry: AgentsRegistry): AgentsRegistry {
  const agent = registry[msg.from];
  if (!agent) return registry;

  let status = agent.status;
  if (msg.type === 'READY' || msg.type === 'RESULT') status = 'IDLE';
  else if (msg.type === 'STATUS') status = (msg.payload as StatusPayload).state;
  else return registry;

  return { ...registry, [msg.from]: { ...agent, status } };
}

// FS_CALL → parseFsCall/dispatch (существующий fs-pipeline) → FS_RESULT адресован обратно
// вызвавшему агенту (msg.from), тем же путём, что любой адресный BusMessage (микро-PR перед PR-5).
export async function handleFsCall(root: string, msg: BusMessage): Promise<BusMessage | null> {
  if (msg.type !== 'FS_CALL') return null;

  const modelText = typeof msg.payload === 'string' ? msg.payload : '';
  const turn = await runFsTurn(root, modelText);
  if (!turn.hasCall) return null;

  return {
    id: randomUUID(),
    from: 'cli',
    to: msg.from,
    type: 'FS_RESULT',
    ts: new Date().toISOString(),
    payload: turn.rendered.join('\n'),
  };
}
