// selector_resilience (spec_selector_resilience) — расширение только сообщает о сломанном
// селекторе (оно видит DOM), запись в реестр — CLI (единственный writer agents_registry.json,
// ARCHITECTURE §2). Задача агента приостановлена до подтверждения self-heal кандидата.
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
