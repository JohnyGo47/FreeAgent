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
