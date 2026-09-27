// selector_resilience (spec_selector_resilience) - extension only reports broken
// selector (it sees the DOM), writing to the registry - CLI (single writer_registry.json,
// ARCHITECTURE §2). The agent's task is suspended until the candidate's self-heal is confirmed.
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';

export interface MarkSelectorBrokenOutcome {
  registry: AgentsRegistry;
}

export function markSelectorBroken(registry: AgentsRegistry, agentId: string, _now: string): MarkSelectorBrokenOutcome {
  const agent = registry[agentId];
  if (!agent) return { registry };
  const updated: RegisteredAgent = { ...agent, status: 'SELECTOR_BROKEN' };
  return { registry: { ...registry, [agentId]: updated } };
}
