// Обновление agents_registry по сообщениям шины — механически, без LLM (ARCHITECTURE §12).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BusMessage, ErrorPayload, RegisterPayload, StatusPayload } from '../../../shared/bus-types/index.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import { runFsTurn } from '../fs/pipeline.ts';
import { loadSkills, buildRoster } from '../skills/skills.ts';
import { registerAgent, type RegisterOutcome } from '../agents/initAgent.ts';

export function applyMessageToRegistry(msg: BusMessage, registry: AgentsRegistry): AgentsRegistry {
  const agent = registry[msg.from];
  if (!agent) return registry;

  let status = agent.status;
  if (msg.type === 'READY' || msg.type === 'RESULT') status = 'IDLE';
  else if (msg.type === 'STATUS') status = (msg.payload as StatusPayload).state;
  else return registry;

  return { ...registry, [msg.from]: { ...agent, status } };
}

// FS_CALL → parseFsCall/dispatch (существующий fs-pipeline) → FS_RESULT адресован обратно
// вызвавшему агенту (msg.from), тем же путём, что любой адресный BusMessage (микро-PR перед PR-5).
export async function handleFsCall(root: string, msg: BusMessage): Promise<BusMessage | null> {
  if (msg.type !== 'FS_CALL') return null;

  const modelText = typeof msg.payload === 'string' ? msg.payload : '';
  const turn = await runFsTurn(root, modelText);
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
