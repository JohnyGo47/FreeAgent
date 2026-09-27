// ROSTER UPDATE - update the orchestrator roster with one short message when there is a change
// composition/statuses (spec_md_orchestrator "Roster - format and update"). Complete replacement of the roaster -
// only when restoring the orchestrator from MEMORY.md (not here, PR-6).
import type { AgentsRegistry } from '../registry/registry.ts';
import type { SkillDef } from '../skills/skills.ts';

interface RosterLine {
  agent_id: string;
  status: string;
  summary: string;
}

function rosterLines(registry: AgentsRegistry, skills: Pick<SkillDef, 'name' | 'summary'>[]): RosterLine[] {
  const summaryByRole = new Map(skills.map((s) => [s.name, s.summary]));
  return Object.values(registry).map((agent) => ({
    agent_id: agent.agent_id,
    status: agent.status,
    summary: summaryByRole.get(agent.role) ?? '',
  }));
}

export function buildRosterUpdateMessage(
  prevRegistry: AgentsRegistry,
  nextRegistry: AgentsRegistry,
  skills: Pick<SkillDef, 'name' | 'summary'>[],
): string | null {
  const prevByAgent = new Map(rosterLines(prevRegistry, skills).map((l) => [l.agent_id, l]));
  const next = rosterLines(nextRegistry, skills);
  const nextIds = new Set(next.map((l) => l.agent_id));

  const lines: string[] = [];
  for (const entry of next) {
    const before = prevByAgent.get(entry.agent_id);
    if (!before || before.status !== entry.status || before.summary !== entry.summary) {
      lines.push(`+ ${entry.agent_id.padEnd(11)} [${entry.status}]  ${entry.summary}`);
    }
  }
  for (const [agentId, entry] of prevByAgent) {
    if (!nextIds.has(agentId)) {
      lines.push(`- ${agentId.padEnd(11)} [${entry.status}] (removed from roster)`);
    }
  }

  if (lines.length === 0) return null;
  return ['ROSTER UPDATE:', ...lines].join('\n');
}
