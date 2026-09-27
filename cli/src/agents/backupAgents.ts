// backup_agents (spec_backup_agents v1.0) - hot backup: switching moves agent_id to
// a pre-initialized backup tab along with memory, the orchestrator does not notice anything
// (ARCHITECTURE §7/§8). Three steps of the procedure - three pure functions, I/O (read/write MEMORY.md on
// disk) remains on the caller (applyMessage.ts), as does everywhere else in this layer.
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';
import type { BusMessage, CommandPayload, NotifyPayload } from '../../../shared/bus-types/index.ts';
import type { Delivery } from '../cli/router.ts';
import { buildInitPrompt } from './initAgent.ts';

export interface SwitchOutcome {
  registry: AgentsRegistry;
  toCommand?: Delivery;
  toBus?: BusMessage;
}

// to: 'cli' - the orchestrator is not notified of the switch (constraint spec, ARCHITECTURE §8);
// route() does not deliver to:'cli' to any agent.
function notify(event: string, agentId: string, now: string, details?: string): BusMessage {
  const payload: NotifyPayload = { event, agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: now, payload };
}

function findStandbyBackup(registry: AgentsRegistry, agentId: string): RegisteredAgent | undefined {
  return Object.values(registry).find((a) => a.is_backup_for === agentId && a.status === 'STANDBY');
}

// Step 1-2: status -> SWITCHING, request MEMORY.md inline (not “write as in the skill” - constraint,
// the model's attention to distant context is degrading by this point in the thread).
export function beginSwitch(registry: AgentsRegistry, agentId: string, now: string, memoryTemplate: string): SwitchOutcome {
  const agent = registry[agentId];
  if (!agent) return { registry };

  const backup = findStandbyBackup(registry, agentId);
  if (!backup) {
    // BLOCKED - transitional status (not IDLE/WORKING): router buffers messages addressed to the agent
    // tasks, the queue is not lost until the user assigns a backup manually (constraint).
    const blocked: RegisteredAgent = { ...agent, status: 'BLOCKED' };
    return { registry: { ...registry, [agentId]: blocked }, toBus: notify('NO_BACKUP_AVAILABLE', agentId, now) };
  }

  const requestText = [`[COMMAND: REQUEST_MEMORY]`, memoryTemplate, `[/COMMAND]`].join('\n');
  const commandPayload: CommandPayload = { command: 'REQUEST_MEMORY', agent_id: agentId, args: { text: requestText } };
  const command: BusMessage = { id: randomUUID(), from: 'cli', to: agentId, type: 'COMMAND', ts: now, payload: commandPayload };

  const updated: RegisteredAgent = { ...agent, status: 'SWITCHING', switching_step: 'memory_requested' };
  return { registry: { ...registry, [agentId]: updated }, toCommand: { instanceId: agent.instance_id, message: command } };
}

// Step 3-5: MEMORY.md (or, if the agent did not have time to give it, the reconstructed context from the bus -
// last TASK + recorded files, the caller builds this line) goes to the backup instance.
export function completeMemoryHandoff(
  registry: AgentsRegistry,
  agentId: string,
  now: string,
  memoryMd: string | null,
  reconstructedContext = 'no MEMORY.md and data to reconstruct',
): SwitchOutcome {
  const agent = registry[agentId];
  if (!agent) return { registry };
  const backup = findStandbyBackup(registry, agentId);
  if (!backup) return { registry };

  const contextText = memoryMd ?? reconstructedContext;
  const initText = buildInitPrompt(agentId, agent.role, `[MEMORY HANDOFF]\n${contextText}\n[/MEMORY HANDOFF]`);
  const commandPayload: CommandPayload = { command: 'ACTIVATE_BACKUP', agent_id: backup.agent_id, args: { text: initText } };
  const command: BusMessage = { id: randomUUID(), from: 'cli', to: backup.agent_id, type: 'COMMAND', ts: now, payload: commandPayload };

  const updatedBackup: RegisteredAgent = { ...backup, switching_step: 'activating_backup' };
  return { registry: { ...registry, [backup.agent_id]: updatedBackup }, toCommand: { instanceId: backup.instance_id, message: command } };
}

// Step 6-8: backup responded READY -> agent_id moves to its instance/tab, old entry (under
// agent_id of the backup) is merged into the main one and disappears from the registry. The agent's queue is flushed by the caller
// side (mainLoop) using the same generic mechanism as regular READY (router.flushBuffered).
export function completeBackupActivation(registry: AgentsRegistry, backupAgentId: string, now: string): SwitchOutcome {
  const backup = registry[backupAgentId];
  if (!backup || !backup.is_backup_for) return { registry };
  const targetId = backup.is_backup_for;
  const target = registry[targetId];
  if (!target) return { registry };

  const merged: RegisteredAgent = {
    ...target,
    instance_id: backup.instance_id,
    tab_id: backup.tab_id,
    status: 'IDLE',
    switching_step: undefined,
  };
  const nextRegistry = { ...registry, [targetId]: merged };
  delete nextRegistry[backupAgentId];

  return { registry: nextRegistry, toBus: notify('AGENT_SWITCHED', targetId, now) };
}
