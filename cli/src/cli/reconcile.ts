// Перезапуск CLI: реестр не считается достоверным, сверяется с реальностью через TAB_STATE
// (ARCHITECTURE §2 "Завершение CLI", spec_cli constraint).
import { randomUUID } from 'node:crypto';
import type { AgentStatus, BusMessage, CommandPayload, TabStatePayload } from '../../../shared/bus-types/index.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { Delivery } from './router.ts';

export function buildTabStateRequests(registry: AgentsRegistry): Delivery[] {
  return Object.values(registry).map((agent) => {
    const payload: CommandPayload = { command: 'TAB_STATE', agent_id: agent.agent_id };
    const message: BusMessage = {
      id: randomUUID(),
      from: 'cli',
      to: agent.agent_id,
      type: 'COMMAND',
      ts: new Date().toISOString(),
      payload,
    };
    return { instanceId: agent.instance_id, message };
  });
}

const STATE_TO_STATUS: Record<TabStatePayload['state'], AgentStatus> = {
  alive: 'IDLE',
  closed: 'SERVICE_DOWN',
  wrong_domain: 'SERVICE_DOWN',
  selectors_broken: 'SELECTOR_BROKEN',
};

// Агент без ответа в окне сверки считается мёртвым — не оставлять реестр на честном слове.
export function reconcileFromResponses(
  registry: AgentsRegistry,
  responses: Record<string, TabStatePayload>,
): AgentsRegistry {
  const updated: AgentsRegistry = {};
  for (const [agentId, agent] of Object.entries(registry)) {
    const response = responses[agentId];
    updated[agentId] = {
      ...agent,
      status: response ? STATE_TO_STATUS[response.state] : 'SERVICE_DOWN',
    };
  }
  return updated;
}
