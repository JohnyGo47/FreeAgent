// backup_agents (spec_backup_agents v1.0) — горячий бэкап: переключение переезжает agent_id на
// заранее инициализированную вкладку-бэкап вместе с памятью, оркестратор ничего не замечает
// (ARCHITECTURE §7/§8). Три шага процедуры — три чистые функции, I/O (чтение/запись MEMORY.md на
// диск) остаётся на вызывающей стороне (applyMessage.ts), как и everywhere else в этом слое.
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

// to: 'cli' — оркестратор не уведомляется о переключении (constraint spec, ARCHITECTURE §8);
// route() не доставляет to:'cli' ни одному агенту.
function notify(event: string, agentId: string, now: string, details?: string): BusMessage {
  const payload: NotifyPayload = { event, agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: now, payload };
}

function findStandbyBackup(registry: AgentsRegistry, agentId: string): RegisteredAgent | undefined {
  return Object.values(registry).find((a) => a.is_backup_for === agentId && a.status === 'STANDBY');
}

// Шаг 1-2: статус -> SWITCHING, запрос MEMORY.md инлайном (не "напиши как в скилле" — constraint,
// внимание модели к далёкому контексту деградирует к этому моменту треда).
export function beginSwitch(registry: AgentsRegistry, agentId: string, now: string, memoryTemplate: string): SwitchOutcome {
  const agent = registry[agentId];
  if (!agent) return { registry };

  const backup = findStandbyBackup(registry, agentId);
  if (!backup) {
    // BLOCKED — переходный статус (не IDLE/WORKING): router буферизует адресованные агенту
    // задачи, очередь не теряется, пока пользователь не назначит бэкап вручную (constraint).
    const blocked: RegisteredAgent = { ...agent, status: 'BLOCKED' };
    return { registry: { ...registry, [agentId]: blocked }, toBus: notify('NO_BACKUP_AVAILABLE', agentId, now) };
  }

  const requestText = [`[COMMAND: REQUEST_MEMORY]`, memoryTemplate, `[/COMMAND]`].join('\n');
  const commandPayload: CommandPayload = { command: 'REQUEST_MEMORY', agent_id: agentId, args: { text: requestText } };
  const command: BusMessage = { id: randomUUID(), from: 'cli', to: agentId, type: 'COMMAND', ts: now, payload: commandPayload };

  const updated: RegisteredAgent = { ...agent, status: 'SWITCHING', switching_step: 'memory_requested' };
  return { registry: { ...registry, [agentId]: updated }, toCommand: { instanceId: agent.instance_id, message: command } };
}

// Шаг 3-5: MEMORY.md (или, если агент не успел его отдать, реконструированный контекст из шины —
// последний TASK + записанные файлы, вызывающая сторона строит эту строку) уходит в бэкап-инстанс.
export function completeMemoryHandoff(
  registry: AgentsRegistry,
  agentId: string,
  now: string,
  memoryMd: string | null,
  reconstructedContext = 'нет MEMORY.md и данных для реконструкции',
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

// Шаг 6-8: бэкап ответил READY -> agent_id переезжает на его instance/tab, старая запись (под
// agent_id бэкапа) сливается в основную и исчезает из реестра. Очередь агента флашится вызывающей
// стороной (mainLoop) тем же generic-механизмом, что и обычный READY (router.flushBuffered).
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
