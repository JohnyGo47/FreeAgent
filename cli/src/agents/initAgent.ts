// initializeAgent (spec_init_agent): один код для пиннинга (флоу А) и программного открытия
// (флоу Б) — оба заканчиваются REGISTER_REQUEST → CLI присваивает agent_id → инжект INIT.
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';
import type { BusMessage, CommandPayload, NotifyPayload, RegisterPayload } from '../../../shared/bus-types/index.ts';
import type { Delivery } from '../cli/router.ts';

// agent_id = <role><N>, N — минимальный свободный номер для роли (освободившийся номер переиспользуется).
export function nextAgentId(registry: AgentsRegistry, role: string): string {
  let n = 1;
  while (`${role}${n}` in registry) n++;
  return `${role}${n}`;
}

export function buildInitPrompt(agentId: string, role: string, roleMd: string, extraContext?: string): string {
  const lines = [`[INIT: ${agentId}]`, `Ты — ${role}. Работаешь в системе FreeAgent.`, roleMd];
  if (extraContext) lines.push(extraContext);
  lines.push('Ответь [READY] когда готов принимать задачи.', '[/INIT]');
  return lines.join('\n');
}

export interface RegisterParams {
  registry: AgentsRegistry;
  payload: RegisterPayload;
  instanceId: string;
  roleMd: string;
  now: string;
  authBlocked: boolean; // true когда для флоу инжекта не резолвится input-селектор — вероятная login-форма
  extraContext?: string;
}

export interface RegisterOutcome {
  registry: AgentsRegistry;
  toCommand?: Delivery;
  toBus?: BusMessage;
}

export function registerAgent(params: RegisterParams): RegisterOutcome {
  const { registry, payload, instanceId, roleMd, now, authBlocked, extraContext } = params;
  const agentId = nextAgentId(registry, payload.role);

  const baseAgent: RegisteredAgent = {
    agent_id: agentId,
    instance_id: instanceId,
    tab_id: payload.tab_id,
    role: payload.role,
    status: authBlocked ? 'BLOCKED' : 'INITIALIZING',
    name: payload.name,
    is_backup_for: payload.is_backup_for,
    registered_at: now,
  };
  const nextRegistry = { ...registry, [agentId]: baseAgent };

  if (authBlocked) {
    const notifyPayload: NotifyPayload = { event: 'AGENT_BLOCKED', agent_id: agentId, details: 'auth_required' };
    const notify: BusMessage = { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'NOTIFY', ts: now, payload: notifyPayload };
    return { registry: nextRegistry, toBus: notify };
  }

  const initText = buildInitPrompt(agentId, payload.role, roleMd, extraContext);
  const commandPayload: CommandPayload = { command: 'INIT', agent_id: agentId, args: { text: initText } };
  const message: BusMessage = { id: randomUUID(), from: 'cli', to: agentId, type: 'COMMAND', ts: now, payload: commandPayload };

  return { registry: nextRegistry, toCommand: { instanceId, message } };
}

// Таймаут ожидания READY (Constraints: 60с → INIT_FAILED; это не recovery-FAILED, recovery-попытки не тратятся).
export function checkInitTimeouts(registry: AgentsRegistry, nowMs: number, timeoutMs: number): AgentsRegistry {
  let changed = false;
  const next: AgentsRegistry = { ...registry };
  for (const [agentId, agent] of Object.entries(registry)) {
    if (agent.status !== 'INITIALIZING' || !agent.registered_at) continue;
    if (nowMs - Date.parse(agent.registered_at) >= timeoutMs) {
      next[agentId] = { ...agent, status: 'INIT_FAILED' };
      changed = true;
    }
  }
  return changed ? next : registry;
}
