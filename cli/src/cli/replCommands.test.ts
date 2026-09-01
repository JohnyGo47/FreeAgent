import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReplCommand, type ReplContext } from './replCommands.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';
import { DEFAULT_CONFIG } from '../config/config.ts';

function ctx(): ReplContext {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' },
  };
  const messages: BusMessage[] = [
    { id: '1', from: 'coder1', to: 'cli', type: 'WRITE', ts: '2026-01-01T00:00:00.000Z', payload: { path: 'a.ts', content: '', kind: 'code' } },
  ];
  return { registry, messages, config: { ...DEFAULT_CONFIG } };
}

test('/status, /agents, /log, /files отвечают без единого сообщения оркестратору', () => {
  for (const cmd of ['/status', '/agents', '/log', '/files']) {
    const result = runReplCommand(cmd, ctx());
    assert.equal(result.toOrchestrator, undefined, cmd);
    assert.ok(result.output.length > 0, cmd);
  }
});

test('/mode plan|yolo переключает режим в конфиге', () => {
  const c = ctx();
  const result = runReplCommand('/mode yolo', c);
  assert.equal(result.configPatch?.mode, 'yolo');
});

test('/btw <текст> уходит оркестратору как TASK от user', () => {
  const result = runReplCommand('/btw проверь логи', ctx());
  assert.equal(result.toOrchestrator?.from, 'user');
  assert.equal(result.toOrchestrator?.to, 'orchestrator');
});

// spec_plan_execution задача B.13: /stop снимает заглушку PR-3 (зависимость появилась — plan_execution
// теперь существует). Сигнал уходит в bin.ts как stopExecution: true, а не как toOrchestrator —
// это остановка исполнения плана внутри CLI, оркестратора она не касается.
test('/stop сигнализирует остановку исполнения плана (новые задачи не уходят), не трогает оркестратора', () => {
  const result = runReplCommand('/stop', ctx());
  assert.equal(result.stopExecution, true);
  assert.equal(result.toOrchestrator, undefined);
});

// spec_git_checkpoints задача B.12: /undo сигнализирует bin.ts (реальный git revert — I/O,
// runReplCommand синхронна), не трогает оркестратора.
test('/undo без аргумента: undoRequest без taskId — bin.ts откатывает последний чекпоинт', () => {
  const result = runReplCommand('/undo', ctx());
  assert.deepEqual(result.undoRequest, { taskId: undefined });
  assert.equal(result.toOrchestrator, undefined);
});

test('/undo <task_id>: undoRequest.taskId несёт конкретную задачу', () => {
  const result = runReplCommand('/undo task-42', ctx());
  assert.deepEqual(result.undoRequest, { taskId: 'task-42' });
});
