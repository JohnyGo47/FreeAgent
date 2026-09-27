// agent_recovery (spec_agent_recovery v3.0) - reactive, without detection timeouts: the extension reports
// TAB_STATE when the tab state changes, the CLI decides. Reuses buildInitPrompt from initAgent.ts
// (same initialization procedure, not duplicated).
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';
import type { BusMessage, CommandPayload, NotifyPayload, TabStatePayload } from '../../../shared/bus-types/index.ts';
import type { Delivery } from '../cli/router.ts';
import { buildInitPrompt } from './initAgent.ts';

const SKIP_RECOVERY = new Set<AgentsRegistry[string]['status']>(['SWITCHING', 'SERVICE_DOWN', 'STANDBY', 'FAILED']);
const MAX_ATTEMPTS = 3;

export interface RecoverParams {
  registry: AgentsRegistry;
  payload: TabStatePayload;
  roleMd: string;
  now: string;
  memoryMd: string | null; // null - MEMORY.md did not exist yet (spec_md_memory_template)
}

export interface RecoverOutcome {
  registry: AgentsRegistry;
  toCommand?: Delivery;
  toBus?: BusMessage;
}

function notify(event: string, agentId: string, now: string): BusMessage {
  const payload: NotifyPayload = { event, agent_id: agentId };
  return { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'NOTIFY', ts: now, payload };
}

function recoveryContext(memoryMd: string | null): string {
  const body = memoryMd ?? 'no saved memory - restore from scratch';
  return `[RECOVERY CONTEXT]\n${body}\n[/RECOVERY CONTEXT]`;
}

export function recoverAgent(params: RecoverParams): RecoverOutcome {
  const { registry, payload, roleMd, now, memoryMd } = params;
  const agent = registry[payload.agent_id];
  if (!agent) return { registry };
  if (payload.state === 'alive') {
    if (agent.status !== 'SERVICE_DOWN') return { registry };
    return { registry: { ...registry, [agent.agent_id]: { ...agent, status: 'IDLE', attempts: 0 } } };
  }
  if (SKIP_RECOVERY.has(agent.status)) return { registry };

  const attempts = (agent.attempts ?? 0) + 1;

  if (attempts > MAX_ATTEMPTS) {
    const failed: RegisteredAgent = { ...agent, status: 'FAILED', attempts };
    return { registry: { ...registry, [agent.agent_id]: failed }, toBus: notify('AGENT_RECOVERY_FAILED', agent.agent_id, now) };
  }

  const initText = buildInitPrompt(agent.agent_id, agent.role, roleMd, recoveryContext(memoryMd));
  const commandPayload: CommandPayload = { command: 'RECOVER_AGENT', agent_id: agent.agent_id, args: { text: initText } };
  const command: BusMessage = { id: randomUUID(), from: 'cli', to: agent.agent_id, type: 'COMMAND', ts: now, payload: commandPayload };

  const updated: RegisteredAgent = { ...agent, status: 'INITIALIZING', attempts };
  // The command always goes to its own instance_id (cross-browser recovery is structural
  // impossible, ARCHITECTURE §16.1) - if that browser is currently closed, the command simply waits in
  // file; NOTIFY here covers this case, because... The CLI cannot distinguish between "closed" and "alive"
  // haven’t subtracted yet" (no return signal to READY).
  return {
    registry: { ...registry, [agent.agent_id]: updated },
    toCommand: { instanceId: agent.instance_id, message: command },
    toBus: notify('AGENT_RECOVERY_STARTED', agent.agent_id, now),
  };
}
