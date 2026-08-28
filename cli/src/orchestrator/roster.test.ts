import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterUpdateMessage } from './roster.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

const skills = [
  { name: 'coder', summary: 'пишет код' },
  { name: 'tester', summary: 'запускает тесты по спекам, отчёт в test_report.md' },
];

test('ROSTER UPDATE contains only agents whose status or summary changed', () => {
  const prev: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  const next: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'a', tab_id: 1, role: 'coder', status: 'IDLE' }, // unchanged
    tester1: { agent_id: 'tester1', instance_id: 'a', tab_id: 2, role: 'tester', status: 'IDLE' }, // new
  };

  const message = buildRosterUpdateMessage(prev, next, skills);
  assert.ok(message);
  assert.match(message as string, /ROSTER UPDATE:/);
  assert.match(message as string, /\+ tester1.*test_report\.md/);
  assert.doesNotMatch(message as string, /coder1/);
});

test('a removed agent shows as a minus line', () => {
  const prev: AgentsRegistry = {
    researcher1: { agent_id: 'researcher1', instance_id: 'a', tab_id: 1, role: 'researcher', status: 'FAILED' },
  };
  const next: AgentsRegistry = {};

  const message = buildRosterUpdateMessage(prev, next, skills);
  assert.ok(message);
  assert.match(message as string, /- researcher1/);
});

test('no changes -> null (no message to send)', () => {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  assert.equal(buildRosterUpdateMessage(registry, registry, skills), null);
});
