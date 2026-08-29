// agents_registry.json — единственный writer CLI (ARCHITECTURE §2, §4; spec_cli).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentStatus } from '../../../shared/bus-types/index.ts';

export interface RegisteredAgent {
  agent_id: string;
  instance_id: string;
  tab_id: number;
  role: string;
  status: AgentStatus;
  name?: string;
  is_backup_for?: string;
  registered_at?: string; // ISO, для отсчёта таймаута READY при INITIALIZING (spec_init_agent)
  attempts?: number; // recovery-попытки подряд (spec_agent_recovery), сбрасывается на успешный READY
  service_unavailable_attempts?: number; // backoff-попытки при "unavailable" (spec_response_health), независим от attempts
  service_down_since?: string; // ISO, момент входа в SERVICE_DOWN — точка отсчёта backoff
  no_tags_attempts?: number; // счётчик переспросов формата (spec_response_health)
  switching_step?: 'memory_requested' | 'activating_backup'; // фаза переключения на бэкап (spec_backup_agents)
}

export type AgentsRegistry = Record<string, RegisteredAgent>;

export function registryPath(freeagentDir: string): string {
  return join(freeagentDir, 'agents_registry.json');
}

export async function loadRegistry(freeagentDir: string): Promise<AgentsRegistry> {
  const raw = await readFile(registryPath(freeagentDir), 'utf8').catch(() => null);
  if (raw === null || raw.trim().length === 0) return {};
  return JSON.parse(raw) as AgentsRegistry;
}

export async function saveRegistry(freeagentDir: string, registry: AgentsRegistry): Promise<void> {
  await writeFile(registryPath(freeagentDir), JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// broadcast — не адрес конкретного агента, всегда валиден.
export function isValidAddressee(registry: AgentsRegistry, to: string): boolean {
  return to === 'broadcast' || to in registry;
}

export function validAgentIds(registry: AgentsRegistry): string[] {
  return Object.keys(registry);
}
