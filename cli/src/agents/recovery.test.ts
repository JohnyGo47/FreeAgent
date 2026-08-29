import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverAgent } from './recovery.ts';
import { route } from '../cli/router.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage, TabStatePayload } from '../../../shared/bus-types/index.ts';

function registryWith(status: AgentsRegistry['coder1']['status'], extra: Partial<AgentsRegistry['coder1']> = {}): AgentsRegistry {
  return {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status, ...extra },
  };
}

function tabState(state: TabStatePayload['state'], agent_id = 'coder1'): TabStatePayload {
  return { agent_id, state };
}

test('TAB_STATE: closed -> команда восстановления отправлена немедленно, без ожидания таймаута', () => {
  const outcome = recoverAgent({
    registry: registryWith('IDLE'),
    payload: tabState('closed'),
    roleMd: 'ROLE BODY',
    now: '2026-08-29T00:00:00.000Z',
    memoryMd: null,
  });
  assert.ok(outcome.toCommand);
  assert.equal(outcome.toCommand?.instanceId, 'browser_a');
  assert.equal(outcome.toCommand?.message.type, 'COMMAND');
  assert.equal(outcome.registry.coder1.status, 'INITIALIZING');
  assert.equal(outcome.registry.coder1.attempts, 1);
});

test('recovery не триггерится в статусах SWITCHING, SERVICE_DOWN, STANDBY, FAILED', () => {
  for (const status of ['SWITCHING', 'SERVICE_DOWN', 'STANDBY', 'FAILED'] as const) {
    const registry = registryWith(status);
    const outcome = recoverAgent({ registry, payload: tabState('closed'), roleMd: 'ROLE', now: 'now', memoryMd: null });
    assert.deepEqual(outcome.registry, registry, `status ${status} must not trigger recovery`);
    assert.equal(outcome.toCommand, undefined);
    assert.equal(outcome.toBus, undefined);
  }
});

test('после 3 попыток подряд -> FAILED + NOTIFY, дальше не пытается', () => {
  let registry = registryWith('IDLE');
  for (let i = 0; i < 3; i++) {
    const outcome = recoverAgent({ registry, payload: tabState('closed'), roleMd: 'ROLE', now: 'now', memoryMd: null });
    registry = outcome.registry;
    assert.equal(registry.coder1.status, 'INITIALIZING');
  }
  const fourth = recoverAgent({ registry, payload: tabState('closed'), roleMd: 'ROLE', now: 'now', memoryMd: null });
  assert.equal(fourth.registry.coder1.status, 'FAILED');
  assert.equal(fourth.toBus?.type, 'NOTIFY');
  assert.equal(fourth.toCommand, undefined);
});

test('агент с MEMORY.md получает RECOVERY CONTEXT с его содержимым; без него — базовый промпт', () => {
  const withMemory = recoverAgent({
    registry: registryWith('IDLE'),
    payload: tabState('closed'),
    roleMd: 'ROLE',
    now: 'now',
    memoryMd: '## Current state\nworking on X',
  });
  const withoutMemory = recoverAgent({
    registry: registryWith('IDLE'),
    payload: tabState('closed'),
    roleMd: 'ROLE',
    now: 'now',
    memoryMd: null,
  });

  const textWith = (withMemory.toCommand?.message.payload as { args: { text: string } }).args.text;
  const textWithout = (withoutMemory.toCommand?.message.payload as { args: { text: string } }).args.text;

  assert.match(textWith, /\[RECOVERY CONTEXT\]/);
  assert.match(textWith, /working on X/);
  assert.match(textWithout, /\[RECOVERY CONTEXT\]/);
  assert.doesNotMatch(textWithout, /working on X/);
});

test('задача, отправленная агенту в INITIALIZING (recovering), буферизуется и доставляется после READY', () => {
  const registry = registryWith('INITIALIZING');
  const buffered: Record<string, BusMessage[]> = {};
  const task: BusMessage = { id: 't1', from: 'orchestrator', to: 'coder1', type: 'TASK', ts: 'now', payload: { task_id: 't1', description: 'x' } };

  const result = route(task, registry, buffered);
  assert.deepEqual(result.toCommands, []);
  assert.equal(buffered.coder1.length, 1);
});

test('команда восстановления пишется в файл инстанса и пользователь уведомлён (на случай, если браузер закрыт)', () => {
  const outcome = recoverAgent({
    registry: registryWith('IDLE'),
    payload: tabState('closed'),
    roleMd: 'ROLE',
    now: 'now',
    memoryMd: null,
  });
  assert.ok(outcome.toCommand, 'command must be queued for the instance file regardless of whether the browser is open');
  assert.equal(outcome.toBus?.type, 'NOTIFY');
});

test('TAB_STATE: alive -> ничего не делает', () => {
  const registry = registryWith('IDLE');
  const outcome = recoverAgent({ registry, payload: tabState('alive'), roleMd: 'ROLE', now: 'now', memoryMd: null });
  assert.deepEqual(outcome.registry, registry);
  assert.equal(outcome.toCommand, undefined);
});

test('неизвестный agent_id в payload -> no-op', () => {
  const registry = registryWith('IDLE');
  const outcome = recoverAgent({ registry, payload: tabState('closed', 'ghost1'), roleMd: 'ROLE', now: 'now', memoryMd: null });
  assert.deepEqual(outcome.registry, registry);
});
