// Routing bus messages to commands/<instance_id>.jsonl (spec_cli, ARCHITECTURE §3).
import { randomUUID } from 'node:crypto';
import type { BusMessage, ErrorPayload } from '../../../shared/bus-types/index.ts';
import { type AgentsRegistry, isValidAddressee, validAgentIds } from '../registry/registry.ts';

export interface Delivery {
  instanceId: string;
  message: BusMessage;
}

export interface RouteResult {
  toCommands: Delivery[];
  toBus?: BusMessage;
}

function errorMessage(msg: BusMessage, registry: AgentsRegistry): BusMessage {
  const payload: ErrorPayload = { message: `unknown agent_id: ${msg.to}`, valid_agents: validAgentIds(registry) };
  return { id: randomUUID(), from: 'cli', to: msg.from, type: 'ERROR', ts: new Date().toISOString(), payload };
}

// Transitional status - neither IDLE nor WORKING (ARCHITECTURE, spec_cli constraint "task buffer for agents
// in transitional status"). WORKING is not buffered: the agent will deal with its own queue.
function isTransitional(status: AgentsRegistry[string]['status']): boolean {
  return status !== 'IDLE' && status !== 'WORKING';
}

export function route(
  msg: BusMessage,
  registry: AgentsRegistry,
  buffered: Record<string, BusMessage[]>,
): RouteResult {
  if (msg.to === 'cli' || msg.to === 'extension') return { toCommands: [] };

  if (msg.to === 'broadcast') {
    return { toCommands: Object.values(registry).map((agent) => ({ instanceId: agent.instance_id, message: msg })) };
  }

  if (!isValidAddressee(registry, msg.to)) {
    return { toCommands: [], toBus: errorMessage(msg, registry) };
  }

  const agent = registry[msg.to];
  if (isTransitional(agent.status)) {
    (buffered[msg.to] ??= []).push(msg);
    return { toCommands: [] };
  }

  return { toCommands: [{ instanceId: agent.instance_id, message: msg }] };
}

// Called after the READY from agent_id has been processed and its status has been converted to IDLE.
export function flushBuffered(
  agentId: string,
  registry: AgentsRegistry,
  buffered: Record<string, BusMessage[]>,
): Delivery[] {
  const queue = buffered[agentId];
  delete buffered[agentId];
  const agent = registry[agentId];
  if (!queue || !agent) return [];
  return queue.map((message) => ({ instanceId: agent.instance_id, message }));
}
