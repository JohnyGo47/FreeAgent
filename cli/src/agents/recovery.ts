// agent_recovery (spec_agent_recovery v3.0) — реактивный, без таймаутов детекта: расширение сообщает
// TAB_STATE при изменении состояния вкладки, CLI решает. Переиспользует buildInitPrompt из initAgent.ts
// (та же процедура инициализации, не дублируется).
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
  memoryMd: string | null; // null — MEMORY.md ещё не было (spec_md_memory_template)
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
  const body = memoryMd ?? 'нет сохранённой памяти — восстановление с нуля';
  return `[RECOVERY CONTEXT]\n${body}\n[/RECOVERY CONTEXT]`;
}

export function recoverAgent(params: RecoverParams): RecoverOutcome {
  const { registry, payload, roleMd, now, memoryMd } = params;
  const agent = registry[payload.agent_id];
  if (!agent) return { registry };
  if (payload.state === 'alive') return { registry };
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
  // Команда всегда идёт в свой же instance_id (кросс-браузерное восстановление структурно
  // невозможно, ARCHITECTURE §16.1) — если тот браузер сейчас закрыт, команда просто ждёт в
  // файле; NOTIFY здесь и покрывает этот случай, т.к. CLI не может отличить "закрыт" от "жив,
  // ещё не вычитал" (нет обратного сигнала до READY).
  return {
    registry: { ...registry, [agent.agent_id]: updated },
    toCommand: { instanceId: agent.instance_id, message: command },
    toBus: notify('AGENT_RECOVERY_STARTED', agent.agent_id, now),
  };
}
