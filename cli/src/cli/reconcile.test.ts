import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTabStateRequests, reconcileFromResponses } from './reconcile.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { TabStatePayload } from '../../../shared/bus-types/index.ts';

function registry(): AgentsRegistry {
  return {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
    tester1: { agent_id: 'tester1', instance_id: 'browser_b', tab_id: 2, role: 'tester', status: 'WORKING' },
  };
}

test('перезапуск: CLI запрашивает TAB_STATE у каждого зарегистрированного агента', () => {
  const requests = buildTabStateRequests(registry());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].message.type, 'COMMAND');
});

test('живой агент (TAB_STATE: alive) возвращается в работу как IDLE', () => {
  const responses: Record<string, TabStatePayload> = { coder1: { agent_id: 'coder1', state: 'alive' } };
  const updated = reconcileFromResponses(registry(), responses);
  assert.equal(updated.coder1.status, 'IDLE');
});

test('агент без ответа помечен мёртвым (SERVICE_DOWN), реестр не считается достоверным до сверки', () => {
  const responses: Record<string, TabStatePayload> = { coder1: { agent_id: 'coder1', state: 'alive' } };
  const updated = reconcileFromResponses(registry(), responses);
  assert.equal(updated.tester1.status, 'SERVICE_DOWN');
});

test('TAB_STATE: closed → SERVICE_DOWN; selectors_broken → SELECTOR_BROKEN', () => {
  const responses: Record<string, TabStatePayload> = {
    coder1: { agent_id: 'coder1', state: 'closed' },
    tester1: { agent_id: 'tester1', state: 'selectors_broken' },
  };
  const updated = reconcileFromResponses(registry(), responses);
  assert.equal(updated.coder1.status, 'SERVICE_DOWN');
  assert.equal(updated.tester1.status, 'SELECTOR_BROKEN');
});
