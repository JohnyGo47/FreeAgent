import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMessageToRegistry } from './applyMessage.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

function registry(): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'SWITCHING' } };
}

function msg(from: string, type: BusMessage['type'], payload: unknown = {}): BusMessage {
  return { id: 'x', from, to: 'cli', type, ts: new Date().toISOString(), payload };
}

test('READY from an agent moves it to IDLE', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'READY'), registry());
  assert.equal(updated.coder1.status, 'IDLE');
});

test('STATUS payload WORKING/IDLE updates the agent status', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'STATUS', { state: 'WORKING' }), registry());
  assert.equal(updated.coder1.status, 'WORKING');
});

test('RESULT (task finished) moves the agent back to IDLE', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'RESULT', { task_id: 't1', status: 'DONE', summary: 'ok' }), registry());
  assert.equal(updated.coder1.status, 'IDLE');
});

test('unrelated message types leave the registry unchanged', () => {
  const before = registry();
  const updated = applyMessageToRegistry(msg('orchestrator', 'TASK'), before);
  assert.deepEqual(updated, before);
});
