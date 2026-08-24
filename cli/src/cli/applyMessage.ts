// Обновление agents_registry по сообщениям шины — механически, без LLM (ARCHITECTURE §12).
import type { BusMessage, StatusPayload } from '../../../shared/bus-types/index.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

export function applyMessageToRegistry(msg: BusMessage, registry: AgentsRegistry): AgentsRegistry {
  const agent = registry[msg.from];
  if (!agent) return registry;

  let status = agent.status;
  if (msg.type === 'READY' || msg.type === 'RESULT') status = 'IDLE';
  else if (msg.type === 'STATUS') status = (msg.payload as StatusPayload).state;
  else return registry;

  return { ...registry, [msg.from]: { ...agent, status } };
}
