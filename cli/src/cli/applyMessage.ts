// Update agents_registry based on bus messages - mechanically, without LLM (ARCHITECTURE §12).
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
  // The backup agent (is_backup_for) after READY is set to STANDBY, not to IDLE - it is not in working order
  // routing, not yet activated by switching (spec_backup_agents).
  if (msg.type === 'READY' || msg.type === 'RESULT') status = agent.is_backup_for ? 'STANDBY' : 'IDLE';
  else if (msg.type === 'STATUS') status = (msg.payload as StatusPayload).state;
  else return registry;

  return { ...registry, [msg.from]: { ...agent, status } };
}

// FS_CALL → parseFsCall/dispatch (existing fs-pipeline) → FS_RESULT addressed back
// to the calling agent (msg.from), in the same way as any addressable BusMessage (micro-PR before PR-5).
// ownedFiles — files of the current step msg.from in the active plan (level-3, spec_plan_execution
// task C); null/undefined - there is no plan or yolo, level-3 is skipped (mainLoop solves this,
// applyMessage knows nothing about the plan).
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

// REGISTER_REQUEST → agent_id assigned by CLI (spec_init_agent). msg.from - instance_id, not
// agent_id: the instance exists before the agents appear (ARCHITECTURE §4, revision #6), so
// registration is a regular message to the same channel, without special cases.
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

  // The roaster is injected into INIT only by the orchestrator - other roles do not see it (ARCHITECTURE §8).
  const extraContext = payload.role === 'orchestrator' ? buildRoster(registry, skills) : undefined;

  return registerAgent({
    registry,
    payload,
    instanceId: msg.from,
    roleMd: skill.roleMd,
    now,
    authBlocked: false, // the "no input selector" signal comes from the extension after an injection attempt - outside of this PR
    extraContext,
  });
}

// TAB_STATE → recoverAgent (spec_agent_recovery). I/O (agent role, MEMORY.md) read here,
// the solution is in pure recoverAgent, with the same division as handleRegisterRequest/registerAgent.
export async function handleTabState(freeagentDir: string, registry: AgentsRegistry, msg: BusMessage): Promise<RecoverOutcome> {
  if (msg.type !== 'TAB_STATE') return { registry };

  const payload = msg.payload as TabStatePayload;
  const agent = registry[payload.agent_id];
  if (!agent) return { registry };

  // selectors_broken -> SELECTOR_BROKEN (spec_selector_resilience), not via recoverAgent:
  // a broken selector does not mean a dead tab, re-initialization is not needed here -
  // we need confirmation of the candidate's self-heal by a person.
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

// RESPONSE_HEALTH → reactToResponseHealth (spec_response_health) decides the reaction class; For
// rate_limited/context_full reaction is composed with backup_agents here in the integration layer -
// responseHealth.ts itself does not know about backups (constraint spec, “there is no inverse dependence”).
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
  // the domain of a specific failed service is not stored anywhere on the RegisteredAgent - we take candidates
  // without exception (ponytail: the exact failedDomain is needed when the agent's llm_url starts saving
  // in the registry, add then).
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

// READY during switching to backup (spec_backup_agents) - recognized by switching_step,
// not the usual READY→IDLE (applyMessageToRegistry does not affect this case, see the call below
// order of branches in mainLoop). Two substeps: the agent gave up memory -> backup is activated.
export async function handleSwitchReady(freeagentDir: string, registry: AgentsRegistry, msg: BusMessage, buffered: Record<string, BusMessage[]>): Promise<SwitchReadyOutcome> {
  if (msg.type !== 'READY') return { registry };
  const agent = registry[msg.from];
  if (!agent?.switching_step) return { registry };

  if (agent.switching_step === 'memory_requested') {
    // The agent writes MEMORY.md with the usual FS_CALL (ARCHITECTURE §11, "agents do not write to disk
    // directly") - by the time of this READY the file is already on disk, the CLI simply reads what it wrote.
    const memoryMd = await readFile(join(freeagentDir, 'memory', `${msg.from}.md`), 'utf8').catch(() => null);
    const outcome = completeMemoryHandoff(registry, msg.from, new Date().toISOString(), memoryMd);
    return { registry: outcome.registry, toCommand: outcome.toCommand, toBus: outcome.toBus };
  }

  // activating_backup: msg.from — agent_id of the backup, not the original agent.
  const targetId = agent.is_backup_for;
  const outcome = completeBackupActivation(registry, msg.from, new Date().toISOString());
  const toCommands = targetId ? flushBuffered(targetId, outcome.registry, buffered) : [];
  return { registry: outcome.registry, toCommands, toBus: outcome.toBus };
}
