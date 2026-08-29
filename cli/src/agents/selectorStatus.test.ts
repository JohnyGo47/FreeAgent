import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSelectorBroken } from './selectorStatus.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function registry(): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' } };
}

test('статус SELECTOR_BROKEN пишет CLI, не расширение напрямую', () => {
  const outcome = markSelectorBroken(registry(), 'coder1', 'now');
  assert.equal(outcome.registry.coder1.status, 'SELECTOR_BROKEN');
});

test('неизвестный agent_id -> no-op', () => {
  const reg = registry();
  const outcome = markSelectorBroken(reg, 'ghost1', 'now');
  assert.deepEqual(outcome.registry, reg);
});
