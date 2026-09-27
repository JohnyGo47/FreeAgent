// /status, /agents, /log, /files - mechanical truth from the bus and registry, without contacting the orchestrator
// (ARCHITECTURE §12, §13; spec_cli).
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage, WritePayload } from '../../../shared/bus-types/index.ts';

export interface AgentStatusRow {
  agent_id: string;
  role: string;
  status: AgentsRegistry[string]['status'];
}

export function agentsStatus(registry: AgentsRegistry): AgentStatusRow[] {
  return Object.values(registry).map((a) => ({ agent_id: a.agent_id, role: a.role, status: a.status }));
}

export function recentLog(messages: BusMessage[], n: number): BusMessage[] {
  return messages.slice(-n);
}

export function filesWritten(messages: BusMessage[]): string[] {
  return messages.filter((m) => m.type === 'WRITE').map((m) => (m.payload as WritePayload).path);
}

export interface StatusSummary {
  agentsWorking: number;
  agentsIdle: number;
  agentsUnavailable: number;
  recentFileCount: number;
}

export function statusSummary(registry: AgentsRegistry, messages: BusMessage[]): StatusSummary {
  const agents = Object.values(registry);
  return {
    agentsWorking: agents.filter((a) => a.status === 'WORKING').length,
    agentsIdle: agents.filter((a) => a.status === 'IDLE').length,
    agentsUnavailable: agents.filter((a) => a.status !== 'WORKING' && a.status !== 'IDLE').length,
    recentFileCount: filesWritten(messages).length,
  };
}
