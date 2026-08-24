import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, flushBuffered } from './router.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

function task(to: string, id = 't1'): BusMessage {
  return { id, from: 'orchestrator', to, type: 'TASK', ts: new Date().toISOString(), payload: { task_id: id, description: 'x' } };
}

function registryWith(status: AgentsRegistry[string]['status']): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status } };
}

test('unknown agent_id: ERROR with the list of valid agent_id, nothing routed', () => {
  const registry = registryWith('IDLE');
  const result = route(task('coder5'), registry, {});
  assert.deepEqual(result.toCommands, []);
  assert.equal(result.toBus?.type, 'ERROR');
  assert.deepEqual((result.toBus?.payload as { valid_agents: string[] }).valid_agents, ['coder1']);
});

test('addressee IDLE: delivered straight to commands/<instance_id>', () => {
  const registry = registryWith('IDLE');
  const result = route(task('coder1'), registry, {});
  assert.equal(result.toCommands.length, 1);
  assert.equal(result.toCommands[0].instanceId, 'browser_a');
});

test('addressee WORKING: also delivered straight through, not buffered', () => {
  const registry = registryWith('WORKING');
  const result = route(task('coder1'), registry, {});
  assert.equal(result.toCommands.length, 1);
});

test('addressee SWITCHING: buffered, delivered only after flushBuffered on READY', () => {
  const registry = registryWith('SWITCHING');
  const buffered: Record<string, BusMessage[]> = {};
  const result = route(task('coder1'), registry, buffered);
  assert.deepEqual(result.toCommands, []);
  assert.equal(buffered.coder1.length, 1);

  registry.coder1.status = 'IDLE'; // READY message processed elsewhere flips status
  const flushed = flushBuffered('coder1', registry, buffered);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].instanceId, 'browser_a');
  assert.equal(buffered.coder1, undefined);
});

test('broadcast: delivered to every registered agent', () => {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
    tester1: { agent_id: 'tester1', instance_id: 'browser_b', tab_id: 2, role: 'tester', status: 'IDLE' },
  };
  const result = route(task('broadcast'), registry, {});
  assert.equal(result.toCommands.length, 2);
});
