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

test('/status, /agents, /log, /files respond without a single message to the orchestrator', () => {
  for (const cmd of ['/status', '/agents', '/log', '/files']) {
    const result = runReplCommand(cmd, ctx());
    assert.equal(result.toOrchestrator, undefined, cmd);
    assert.ok(result.output.length > 0, cmd);
  }
});

test('/mode plan|yolo switches the mode in the config', () => {
  const c = ctx();
  const result = runReplCommand('/mode yolo', c);
  assert.equal(result.configPatch?.mode, 'yolo');
});

test('/btw <text> goes to the orchestrator as a TASK from the user', () => {
  const result = runReplCommand('/btw check the logs', ctx());
  assert.equal(result.toOrchestrator?.from, 'user');
  assert.equal(result.toOrchestrator?.to, 'orchestrator');
});

// spec_plan_execution task B.13: /stop removes the PR-3 stub (dependency appeared - plan_execution
// now exists). The signal goes to bin.ts as stopExecution: true, and not as toOrchestrator -
// this is stopping the execution of the plan inside the CLI, it does not affect the orchestrator.
test('/stop signals the plan to stop execution (new tasks do not leave), does not touch the orchestrator', () => {
  const result = runReplCommand('/stop', ctx());
  assert.equal(result.stopExecution, true);
  assert.equal(result.toOrchestrator, undefined);
});

// spec_git_checkpoints task B.12: /undo signals bin.ts (real git revert - I/O,
// runReplCommand is synchronous), does not affect the orchestrator.
test('/undo without argument: undoRequest without taskId - bin.ts rolls back the last checkpoint', () => {
  const result = runReplCommand('/undo', ctx());
  assert.deepEqual(result.undoRequest, { taskId: undefined });
  assert.equal(result.toOrchestrator, undefined);
});

test('/undo <task_id>: undoRequest.taskId carries a specific task', () => {
  const result = runReplCommand('/undo task-42', ctx());
  assert.deepEqual(result.undoRequest, { taskId: 'task-42' });
});
