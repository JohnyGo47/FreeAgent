// agents_registry.json is the only writer CLI (ARCHITECTURE §2, §4; spec_cli).
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
  registered_at?: string; // ISO, to count the READY timeout at INITIALIZING (spec_init_agent)
  attempts?: number; // recovery attempts in a row (spec_agent_recovery), reset to successful READY
  service_unavailable_attempts?: number; // backoff attempts when "unavailable" (spec_response_health), independent of attempts
  service_down_since?: string; // ISO, the moment of entering SERVICE_DOWN - backoff reference point
  no_tags_attempts?: number; // format response counter (spec_response_health)
  switching_step?: 'memory_requested' | 'activating_backup'; // phase of switching to backup (spec_backup_agents)
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

// broadcast is not the address of a specific agent, it is always valid.
export function isValidAddressee(registry: AgentsRegistry, to: string): boolean {
  return to === 'broadcast' || to in registry;
}

export function validAgentIds(registry: AgentsRegistry): string[] {
  return Object.keys(registry);
}
