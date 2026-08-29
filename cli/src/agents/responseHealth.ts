// response_health (spec_response_health) — реакция CLI на уже классифицированный расширением
// ответ. Обратной зависимости на backup_agents нет (constraint spec): здесь только решение
// "что делать", исполнение переключения — на вызывающей стороне (applyMessage.ts).
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

// to: 'cli' — эти NOTIFY адресованы человеку (решение "какой сервис выбрать" не автоматическое),
// не оркестратору (constraint: "задача не переназначается автоматически"). route() не доставляет
// сообщения с to:'cli' ни одному агенту (ARCHITECTURE §3) — они остаются в шине для CLI/TUI.
function notify(event: string, agentId: string, now: string, details?: string): BusMessage {
  const payload: NotifyPayload = { event, agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: now, payload };
}

// Все домены реестра адаптеров кроме упавшего — кандидаты на ручной выбор пользователя после
// исчерпания backoff (нет фильтрации по ролям, spec: "адаптеры привязаны к доменам, не к ролям").
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
    // Счётчик независим от attempts (recovery, spec_agent_recovery) — недоступность сервиса не
    // должна списывать попытки, предназначенные для сбоев агента (constraint).
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
    // Переключение решает spec_backup_agents (вызывается вызывающей стороной) — оркестратор
    // здесь намеренно не уведомляется (constraint: "не знает про бэкапы").
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
