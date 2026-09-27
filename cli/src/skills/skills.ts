// Role like MD-file-in /skills/ (spec_skills_system). There is no hard-to-date list of roles —
// listing frontmatter disk-file.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentsRegistry } from '../registry/registry.ts';

export interface SkillDef {
  name: string;
  summary: string;
  roleMd: string; // file-body frontmatter — full-time INIT-practicum
  filename: string;
}

const NAME_RE = /^[a-z0-9_]+$/;
const MAX_SUMMARY = 120;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

type ParsedSkill = { name: string; summary: string; roleMd: string; truncated: boolean };
export type ParseSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; error: string };

export function parseSkillFile(content: string, filename: string): ParseSkillResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { ok: false, error: `${filename}: missing frontmatter` };
  const [, frontmatter, body] = match;

  const attrs: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    attrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const name = attrs.name;
  if (!name) return { ok: false, error: `${filename}: missing required field: name` };
  if (!NAME_RE.test(name)) return { ok: false, error: `${filename}: invalid name (must match [a-z0-9_]+): ${name}` };

  const rawSummary = attrs.summary;
  if (!rawSummary) return { ok: false, error: `${filename}: missing required field: summary` };

  const truncated = rawSummary.length > MAX_SUMMARY;
  const summary = truncated ? rawSummary.slice(0, MAX_SUMMARY) : rawSummary;

  return { ok: true, skill: { name, summary, roleMd: body.trim(), truncated } };
}

export interface SkillLoadResult {
  skills: SkillDef[];
  errors: string[];
}

export async function loadSkills(skillsDir: string): Promise<SkillLoadResult> {
  const files = (await readdir(skillsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort();
  const skills: SkillDef[] = [];
  const errors: string[] = [];
  const seenNames = new Set<string>();

  for (const filename of files) {
    const content = await readFile(join(skillsDir, filename), 'utf8');
    const parsed = parseSkillFile(content, filename);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    const { name, summary, roleMd, truncated } = parsed.skill;
    if (seenNames.has(name)) {
      errors.push(`${filename}: duplicate name: ${name}`);
      continue;
    }
    seenNames.add(name);
    if (truncated) errors.push(`${filename}: summary truncated to ${MAX_SUMMARY} chars`);
    skills.push({ name, summary, roleMd, filename });
  }

  return { skills, errors };
}

// roster for orchestrator: agent_id [status] summary — one-line (ARCHITECTURE §8).
export function buildRoster(registry: AgentsRegistry, skills: Pick<SkillDef, 'name' | 'summary'>[]): string {
  const summaryByRole = new Map(skills.map((s) => [s.name, s.summary]));
  return Object.values(registry)
    .map((agent) => `${agent.agent_id} [${agent.status}] ${summaryByRole.get(agent.role) ?? ''}`.trimEnd())
    .join('\n');
}
