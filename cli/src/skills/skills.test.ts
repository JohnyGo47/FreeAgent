import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile, loadSkills, buildRoster } from './skills.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'skills');

async function tmpSkillsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-skills-'));
}

test('valid skill parses and is included in the list', () => {
  const content = ['---', 'name: seo_auditor', 'summary: Website audits for technical SEO', '---', '', '# Role', 'body text'].join('\n');
  const result = parseSkillFile(content, 'seo_auditor.md');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skill.name, 'seo_auditor');
    assert.equal(result.skill.summary, 'Website audits for technical SEO');
    assert.match(result.skill.roleMd, /# Role/);
  }
});

test('missing summary -> rejected with a clear error', () => {
  const content = ['---', 'name: seo_auditor', '---', '# Role'].join('\n');
  const result = parseSkillFile(content, 'seo_auditor.md');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /summary/);
});

test('duplicate name -> the second file is rejected', async (t) => {
  const dir = await tmpSkillsDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = (name: string) => ['---', `name: ${name}`, 'summary: does things', '---', 'body'].join('\n');
  await writeFile(join(dir, 'a_first.md'), content('coder'), 'utf8');
  await writeFile(join(dir, 'b_second.md'), content('coder'), 'utf8');

  const { skills, errors } = await loadSkills(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].filename, 'a_first.md');
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
});

test('summary longer than 120 chars -> truncated, with a warning', () => {
  const longSummary = 'x'.repeat(150);
  const content = ['---', 'name: verbose', `summary: ${longSummary}`, '---', 'body'].join('\n');
  const result = parseSkillFile(content, 'verbose.md');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skill.summary.length, 120);
    assert.equal(result.skill.truncated, true);
  }
});

test('roster is built from registered agents with correct statuses', () => {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
    researcher1: { agent_id: 'researcher1', instance_id: 'browser_a', tab_id: 2, role: 'researcher', status: 'WORKING' },
  };
  const skills = [
    { name: 'coder', summary: 'writes code', roleMd: '', filename: 'coder.md' },
    { name: 'researcher', summary: 'researches things', roleMd: '', filename: 'researcher.md' },
  ];
  const roster = buildRoster(registry, skills);
  assert.match(roster, /coder1\s+\[IDLE\]\s+writes code/);
  assert.match(roster, /researcher1\s+\[WORKING\]\s+researches things/);
});

test('the five built-in skills pass validation', async () => {
  const { skills, errors } = await loadSkills(BUILTIN_SKILLS_DIR);
  assert.deepEqual(errors, []);
  assert.equal(skills.length, 5);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['coder', 'orchestrator', 'researcher', 'reviewer', 'tester']);
});
