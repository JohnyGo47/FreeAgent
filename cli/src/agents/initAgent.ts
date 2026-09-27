// initializeAgent (spec_init_agent): one path handles both pinning (flow A) and
// soft opening (flow B). Both end with REGISTER_REQUEST, agent assignment, and INIT.
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry, RegisteredAgent } from '../registry/registry.ts';
import type { BusMessage, CommandPayload, NotifyPayload, RegisterPayload } from '../../../shared/bus-types/index.ts';
import type { Delivery } from '../cli/router.ts';

const AGENT_PROTOCOL = `## FreeAgent Protocol

Files are only accessible through a separate response in the format \`[FS | op: read | path: package.json]\`.
For a list use \`[FS | op: list | path: . | depth: 2]\`; for search use \`[FS | op: search | query: text | path: .]\`.
To write, use a separate heredoc block:
\`[FS | op: write | path: file | kind: doc | end: ---FS_END---]
content
---FS_END---\`
After the FS request, wait for \`[FS_RESULT]\` and only then continue. Don't send READ/WRITE messages.

Send the completion of the task in a block:
\`[MSG | to: orchestrator | type: RESULT]
{"task_id":"received task_id","status":"DONE","summary":{"result":"short actual result"}}
[/MSG]\`
Always make the \`summary\` field a JSON object, not a string. Don't put unescaped quotes in JSON strings.

If the task requires running tests, send before RESULT:
\`[MSG | to: cli | type: TESTS_READY]
{"task_id":"received task_id","command":"npm test"}
[/MSG]\`
Immediately after TESTS_READY send RESULT. Don't wait for a separate TESTS_RESULT: the CLI will run the command and check the exit code itself when processing the RESULT.`;

// agent_id = <role><N>, N is the minimum free number for the role (the free number is reused).
export function nextAgentId(registry: AgentsRegistry, role: string): string {
  if (role === 'orchestrator') return 'orchestrator';
  const reusable = Object.values(registry)
    .filter((agent) => agent.role === role && ['SERVICE_DOWN', 'FAILED', 'INIT_FAILED'].includes(agent.status))
    .map((agent) => agent.agent_id)
    .sort((a, b) => Number(a.slice(role.length)) - Number(b.slice(role.length)))[0];
  if (reusable) return reusable;
  let n = 1;
  while (`${role}${n}` in registry) n++;
  return `${role}${n}`;
}

export function buildInitPrompt(agentId: string, role: string, roleMd: string, extraContext?: string): string {
  const lines = [`[INIT: ${agentId}]`, `You are ${role}. You work in the FreeAgent system.`, roleMd, AGENT_PROTOCOL];
  if (extraContext) lines.push(extraContext);
  lines.push('Reply [READY] when ready to accept tasks.', '[/INIT]');
  return lines.join('\n');
}

export interface RegisterParams {
  registry: AgentsRegistry;
  payload: RegisterPayload;
  instanceId: string;
  roleMd: string;
  now: string;
  authBlocked: boolean; // true when the input selector does not resolve for the flow injection - probable login form
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

// A READY timeout moves the agent to INIT_FAILED without consuming recovery attempts.
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
