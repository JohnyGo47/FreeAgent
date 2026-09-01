// Обновление agents_registry по сообщениям шины — механически, без LLM (ARCHITECTURE §12).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BusMessage, ErrorPayload, HealthPayload, RegisterPayload, StatusPayload, TabStatePayload } from '../../../shared/bus-types/index.ts';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { FreeAgentConfig } from '../config/config.ts';
import type { Delivery } from './router.ts';
import { flushBuffered } from './router.ts';
import { runFsTurn } from '../fs/pipeline.ts';
import { loadSkills, buildRoster } from '../skills/skills.ts';
import { registerAgent, type RegisterOutcome } from '../agents/initAgent.ts';
import { recoverAgent, type RecoverOutcome } from '../agents/recovery.ts';
import { reactToResponseHealth, candidateServices } from '../agents/responseHealth.ts';
import { beginSwitch, completeMemoryHandoff, completeBackupActivation } from '../agents/backupAgents.ts';
import { markSelectorBroken } from '../agents/selectorStatus.ts';

export function applyMessageToRegistry(msg: BusMessage, registry: AgentsRegistry): AgentsRegistry {
  const agent = registry[msg.from];
  if (!agent) return registry;

  let status = agent.status;
  // Бэкап-агент (is_backup_for) после READY встаёт в STANDBY, не в IDLE — он не в рабочем
  // роутинге, пока не активирован переключением (spec_backup_agents).
  if (msg.type === 'READY' || msg.type === 'RESULT') status = agent.is_backup_for ? 'STANDBY' : 'IDLE';
  else if (msg.type === 'STATUS') status = (msg.payload as StatusPayload).state;
  else return registry;

  return { ...registry, [msg.from]: { ...agent, status } };
}

// FS_CALL → parseFsCall/dispatch (существующий fs-pipeline) → FS_RESULT адресован обратно
// вызвавшему агенту (msg.from), тем же путём, что любой адресный BusMessage (микро-PR перед PR-5).
// ownedFiles — files текущего шага msg.from в активном плане (уровень-3, spec_plan_execution
// задача C); null/undefined — плана нет или yolo, уровень-3 пропускается (mainLoop решает это,
// applyMessage про план ничего не знает).
export async function handleFsCall(root: string, msg: BusMessage, ownedFiles?: string[] | null): Promise<BusMessage | null> {
  if (msg.type !== 'FS_CALL') return null;

  const modelText = typeof msg.payload === 'string' ? msg.payload : '';
  const turn = await runFsTurn(root, modelText, ownedFiles);
  if (!turn.hasCall) return null;

  return {
    id: randomUUID(),
    from: 'cli',
    to: msg.from,
    type: 'FS_RESULT',
    ts: new Date().toISOString(),
    payload: turn.rendered.join('\n'),
  };
}

// REGISTER_REQUEST → agent_id присваивает CLI (spec_init_agent). msg.from — instance_id, не
// agent_id: инстанс существует до появления агентов (ARCHITECTURE §4, ревизия #6), поэтому
// регистрация — обычное сообщение в тот же канал, без спецслучаев.
export async function handleRegisterRequest(freeagentDir: string, registry: AgentsRegistry, msg: BusMessage): Promise<RegisterOutcome> {
  if (msg.type !== 'REGISTER_REQUEST') return { registry };

  const payload = msg.payload as RegisterPayload;
  const { skills } = await loadSkills(join(freeagentDir, 'skills'));
  const skill = skills.find((s) => s.name === payload.role);
  const now = new Date().toISOString();

  if (!skill) {
    const errorPayload: ErrorPayload = { message: `unknown role: ${payload.role}`, valid_agents: skills.map((s) => s.name) };
    const error: BusMessage = { id: randomUUID(), from: 'cli', to: msg.from, type: 'ERROR', ts: now, payload: errorPayload };
    return { registry, toBus: error };
  }

  // Ростер инжектится в INIT только оркестратору — остальные роли его не видят (ARCHITECTURE §8).
  const extraContext = payload.role === 'orchestrator' ? buildRoster(registry, skills) : undefined;

  return registerAgent({
    registry,
    payload,
    instanceId: msg.from,
    roleMd: skill.roleMd,
    now,
    authBlocked: false, // сигнал "нет input-селектора" приходит от расширения после попытки инжекта — вне этого PR
    extraContext,
  });
}

// TAB_STATE → recoverAgent (spec_agent_recovery). I/O (роль агента, MEMORY.md) читается здесь,
// решение — в чистой recoverAgent, тем же разделением, что handleRegisterRequest/registerAgent.
export async function handleTabState(freeagentDir: string, registry: AgentsRegistry, msg: BusMessage): Promise<RecoverOutcome> {
  if (msg.type !== 'TAB_STATE') return { registry };

  const payload = msg.payload as TabStatePayload;
  const agent = registry[payload.agent_id];
  if (!agent) return { registry };

  // selectors_broken -> SELECTOR_BROKEN (spec_selector_resilience), не через recoverAgent:
  // сломанный селектор не значит мёртвую вкладку, повторная инициализация здесь не нужна —
  // нужно подтверждение self-heal кандидата человеком.
  if (payload.state === 'selectors_broken') {
    return markSelectorBroken(registry, payload.agent_id, new Date().toISOString());
  }

  const { skills } = await loadSkills(join(freeagentDir, 'skills'));
  const skill = skills.find((s) => s.name === agent.role);
  const roleMd = skill?.roleMd ?? '';
  const memoryMd = await readFile(join(freeagentDir, 'memory', `${agent.agent_id}.md`), 'utf8').catch(() => null);

  return recoverAgent({ registry, payload, roleMd, now: new Date().toISOString(), memoryMd });
}

const MEMORY_TEMPLATE_PATH = fileURLToPath(new URL('../../../shared/templates/MEMORY_TEMPLATE.md', import.meta.url));

export interface HealthOutcome {
  registry: AgentsRegistry;
  toCommand?: Delivery;
  toBus?: BusMessage;
}

// RESPONSE_HEALTH → reactToResponseHealth (spec_response_health) решает класс реакции; для
// rate_limited/context_full реакция композируется с backup_agents здесь, в интеграционном слое —
// сам responseHealth.ts про бэкапы не знает (constraint spec, "обратной зависимости нет").
export async function handleResponseHealth(
  freeagentDir: string,
  registry: AgentsRegistry,
  msg: BusMessage,
  config: FreeAgentConfig,
): Promise<HealthOutcome> {
  if (msg.type !== 'RESPONSE_HEALTH') return { registry };

  const payload = msg.payload as HealthPayload;
  const now = new Date().toISOString();
  const adapterRegistryRaw = await readFile(join(freeagentDir, 'llm_adapter_registry.json'), 'utf8').catch(() => null);
  const adapterRegistry: AdapterRegistry | null = adapterRegistryRaw ? JSON.parse(adapterRegistryRaw) : null;
  // domain конкретного упавшего сервиса нигде не хранится на RegisteredAgent — кандидаты берём
  // без исключения (ponytail: точный failedDomain нужен, когда llm_url агента начнёт сохраняться
  // в реестре, добавить тогда).
  const candidates = adapterRegistry ? candidateServices(adapterRegistry, '') : [];

  const reaction = reactToResponseHealth(registry, payload, now, config.backoff_ms, candidates);

  if (reaction.action.kind === 'switch_backup') {
    const template = await readFile(MEMORY_TEMPLATE_PATH, 'utf8').catch(() => '## Current state\n## Next steps');
    const switchOutcome = beginSwitch(reaction.registry, payload.agent_id, now, template);
    return { registry: switchOutcome.registry, toCommand: switchOutcome.toCommand, toBus: switchOutcome.toBus };
  }

  return { registry: reaction.registry, toBus: reaction.toBus };
}

export interface SwitchReadyOutcome {
  registry: AgentsRegistry;
  toCommand?: Delivery;
  toCommands?: Delivery[];
  toBus?: BusMessage;
}

// READY во время переключения на бэкап (spec_backup_agents) — распознаётся по switching_step,
// не по обычному READY→IDLE (applyMessageToRegistry этот случай не трогает, см. вызов ниже по
// порядку веток в mainLoop). Два подшага: агент отдал память -> бэкап активирован.
export async function handleSwitchReady(freeagentDir: string, registry: AgentsRegistry, msg: BusMessage, buffered: Record<string, BusMessage[]>): Promise<SwitchReadyOutcome> {
  if (msg.type !== 'READY') return { registry };
  const agent = registry[msg.from];
  if (!agent?.switching_step) return { registry };

  if (agent.switching_step === 'memory_requested') {
    // Агент пишет MEMORY.md обычным FS_CALL (ARCHITECTURE §11, "агенты не пишут на диск
    // напрямую") — к моменту этого READY файл уже на диске, CLI просто читает то, что сам записал.
    const memoryMd = await readFile(join(freeagentDir, 'memory', `${msg.from}.md`), 'utf8').catch(() => null);
    const outcome = completeMemoryHandoff(registry, msg.from, new Date().toISOString(), memoryMd);
    return { registry: outcome.registry, toCommand: outcome.toCommand, toBus: outcome.toBus };
  }

  // activating_backup: msg.from — agent_id бэкапа, не оригинального агента.
  const targetId = agent.is_backup_for;
  const outcome = completeBackupActivation(registry, msg.from, new Date().toISOString());
  const toCommands = targetId ? flushBuffered(targetId, outcome.registry, buffered) : [];
  return { registry: outcome.registry, toCommands, toBus: outcome.toBus };
}
