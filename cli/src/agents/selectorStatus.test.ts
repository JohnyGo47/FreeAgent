import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSelectorBroken } from './selectorStatus.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function registry(): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' } };
}

test('SELECTOR_BROKEN status is written by CLI, not extension directly', () => {
  const outcome = markSelectorBroken(registry(), 'coder1', 'now');
  assert.equal(outcome.registry.coder1.status, 'SELECTOR_BROKEN');
});

test('unknown agent_id -> no-op', () => {
  const reg = registry();
  const outcome = markSelectorBroken(reg, 'ghost1', 'now');
  assert.deepEqual(outcome.registry, reg);
});
