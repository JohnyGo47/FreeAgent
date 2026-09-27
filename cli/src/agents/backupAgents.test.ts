import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginSwitch, completeMemoryHandoff, completeBackupActivation } from './backupAgents.ts';
import { route } from '../cli/router.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

function registryWithBackup(): AgentsRegistry {
  return {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' },
    coder1_b: { agent_id: 'coder1_b', instance_id: 'browser_b', tab_id: 2, role: 'coder', status: 'STANDBY', is_backup_for: 'coder1' },
  };
}

test('registering a backup: tasks addressed to the STANDBY agent are buffered (do not arrive)', () => {
  const registry = registryWithBackup();
  const buffered: Record<string, BusMessage[]> = {};
  const task: BusMessage = { id: 't1', from: 'orchestrator', to: 'coder1_b', type: 'TASK', ts: 'now', payload: { task_id: 't1', description: 'x' } };
  const result = route(task, registry, buffered);
  assert.deepEqual(result.toCommands, []);
  assert.equal(buffered.coder1_b.length, 1);
});

test('context_full: full switch procedure, agent_id does not change, orchestrator is not notified', () => {
  const registry = registryWithBackup();

  const begin = beginSwitch(registry, 'coder1', 'now', 'MEMORY TEMPLATE BODY');
  assert.equal(begin.registry.coder1.status, 'SWITCHING');
  assert.ok(begin.toCommand);
  assert.equal(begin.toCommand?.instanceId, 'browser_a');
  assert.match((begin.toCommand?.message.payload as { args: { text: string } }).args.text, /MEMORY TEMPLATE BODY/);

  const handoff = completeMemoryHandoff(begin.registry, 'coder1', 'now', '## Current state\nmid-task');
  assert.ok(handoff.toCommand);
  assert.equal(handoff.toCommand?.instanceId, 'browser_b'); // went to the backup instance
  assert.match((handoff.toCommand?.message.payload as { args: { text: string } }).args.text, /mid-task/);

  const activated = completeBackupActivation(handoff.registry, 'coder1_b', 'now');
  assert.ok('coder1' in activated.registry);
  assert.equal(activated.registry.coder1.instance_id, 'browser_b');
  assert.equal(activated.registry.coder1.tab_id, 2);
  assert.equal(activated.registry.coder1.status, 'IDLE');
  assert.equal('coder1_b' in activated.registry, false); // old entry merged into the main one

  for (const msg of [begin.toBus, handoff.toBus, activated.toBus]) {
    if (msg) assert.notEqual(msg.to, 'orchestrator');
  }
});

test('backup without MEMORY.md is activated with the transferred reconstructed context', () => {
  const registry = registryWithBackup();
  const begin = beginSwitch(registry, 'coder1', 'now', 'TEMPLATE');
  const handoff = completeMemoryHandoff(begin.registry, 'coder1', 'now', null, 'RECONSTRUCTED: last task t1, files: a.ts, b.ts');
  assert.match((handoff.toCommand?.message.payload as { args: { text: string } }).args.text, /RECONSTRUCTED: last task t1/);
});

test('lack of backup when switching -> NOTIFY, status blocks routing, queue is not lost', () => {
  const registry: AgentsRegistry = { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' } };
  const outcome = beginSwitch(registry, 'coder1', 'now', 'TEMPLATE');
  assert.equal(outcome.toCommand, undefined);
  assert.equal(outcome.toBus?.type, 'NOTIFY');
  assert.notEqual(outcome.toBus?.to, 'orchestrator');

  const buffered: Record<string, BusMessage[]> = {};
  const task: BusMessage = { id: 't2', from: 'orchestrator', to: 'coder1', type: 'TASK', ts: 'now', payload: { task_id: 't2', description: 'x' } };
  const result = route(task, outcome.registry, buffered);
  assert.deepEqual(result.toCommands, []);
  assert.equal(buffered.coder1.length, 1);
});

test("unknown agent_id -> no-op, doesn't crash", () => {
  const registry = registryWithBackup();
  const outcome = beginSwitch(registry, 'ghost1', 'now', 'TEMPLATE');
  assert.deepEqual(outcome.registry, registry);
  assert.equal(outcome.toCommand, undefined);
});
