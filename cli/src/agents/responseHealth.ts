// response_health (spec_response_health) - CLI reaction to one already classified by the extension
// answer. There is no inverse dependence on backup_agents (constraint spec): here is the only solution
// “what to do”, the execution of the switch is on the calling side (applyMessage.ts).
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';
import type { BusMessage, HealthPayload, NotifyPayload } from '../../../shared/bus-types/index.ts';

export type HealthAction =
  | { kind: 'backoff'; delayMs: number }
  | { kind: 'switch_backup' }
  | { kind: 'ask_reformat' }
  | { kind: 'notify_exhausted'; candidates: string[] }
  | { kind: 'notify_no_tags_exhausted' }
  | { kind: 'none' };

export interface ReactOutcome {
  registry: AgentsRegistry;
  toBus?: BusMessage;
  action: HealthAction;
}

const NO_TAGS_LIMIT = 3;

// to: 'cli' - these NOTIFYs are addressed to a person (the decision “which service to choose” is not automatic),
// not to the orchestrator (constraint: "the task is not automatically reassigned"). route() doesn't deliver
// messages with to:'cli' to no agent (ARCHITECTURE §3) - they remain in the bus for CLI/TUI.
function notify(event: string, agentId: string, now: string, details?: string): BusMessage {
  const payload: NotifyPayload = { event, agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: now, payload };
}

// All adapter registry domains except the fallen one are candidates for manual user selection after
// exhaustion of backoff (no filtering by roles, spec: "adapters are bound to domains, not to roles").
export function candidateServices(adapterRegistry: AdapterRegistry, failedDomain: string): string[] {
  return Object.keys(adapterRegistry.adapters).filter((d) => d !== failedDomain);
}

export function reactToResponseHealth(
  registry: AgentsRegistry,
  payload: HealthPayload,
  now: string,
  backoffMs: number[],
  candidates: string[],
): ReactOutcome {
  const agent = registry[payload.agent_id];
  if (!agent) return { registry, action: { kind: 'none' } };

  if (payload.klass === 'unavailable') {
    // The counter is independent of attempts (recovery, spec_agent_recovery) - service unavailability is not
    // should write off attempts intended for agent failures (constraint).
    const attempts = (agent.service_unavailable_attempts ?? 0) + 1;
    if (attempts > backoffMs.length) {
      const done: RegisteredAgent = { ...agent, service_unavailable_attempts: attempts };
      return {
        registry: { ...registry, [agent.agent_id]: done },
        toBus: notify('SERVICE_EXHAUSTED', agent.agent_id, now, `candidates: ${candidates.join(', ')}`),
        action: { kind: 'notify_exhausted', candidates },
      };
    }
    const down: RegisteredAgent = { ...agent, status: 'SERVICE_DOWN', service_unavailable_attempts: attempts, service_down_since: now };
    return { registry: { ...registry, [agent.agent_id]: down }, action: { kind: 'backoff', delayMs: backoffMs[attempts - 1] } };
  }

  if (payload.klass === 'rate_limited' || payload.klass === 'context_full') {
    // Switching is decided by spec_backup_agents (called by the caller) - orchestrator
    // deliberately not notified here (constraint: "does not know about backups").
    return { registry, action: { kind: 'switch_backup' } };
  }

  // no_tags
  const attempts = (agent.no_tags_attempts ?? 0) + 1;
  const updated: RegisteredAgent = { ...agent, no_tags_attempts: attempts };
  const nextRegistry = { ...registry, [agent.agent_id]: updated };
  if (attempts >= NO_TAGS_LIMIT) {
    return { registry: nextRegistry, toBus: notify('NO_TAGS_EXHAUSTED', agent.agent_id, now, payload.raw_excerpt), action: { kind: 'notify_no_tags_exhausted' } };
  }
  return { registry: nextRegistry, action: { kind: 'ask_reformat' } };
}
