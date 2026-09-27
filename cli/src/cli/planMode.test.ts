// spec_cli_plan_mode - unit tests for gate and plan parsing. Tests 1 ("agents do not receive TASK until
// APPROVED") and 2 ("WRITE before APPROVED → PAUSE") - integration, require mainLoop/router;
// live in planExecution.integration.test.ts along with the plan_execution integration tests.
// Test 5 ("/mode persists") is already covered by config.test.ts ("partial config: mode: yolo") +
// replCommands.test.ts ("/mode plan|yolo switches the mode in the config") - there is nothing to duplicate,
// the persistence mechanism is common to any config field, not specific to plan mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_GATE,
  PLAN_TIMEOUT_MS,
  startTask,
  isApproved,
  isBlockedByGate,
  checkTimeout,
  receivePlanText,
  approvePlan,
  cancelPlan,
  revisePlan,
  planToEditableText,
  switchMode,
} from './planMode.ts';

const VALID_PLAN_TEXT = [
  '[PLAN]',
  'STEP 1 | coder1 | Write a module | FILES: src/a.ts | DEPENDS: none',
  '[/PLAN]',
].join('\n');

test('idle (before the start of the first task): does not block - there is no task, there is nothing to gate', () => {
  assert.equal(isBlockedByGate(IDLE_GATE), false);
});

test('yolo: startTask skips the entire gate, the task is immediately approved (mode indicator - TUI, status here)', () => {
  const gate = startTask('t1', Date.now(), 'yolo');
  assert.equal(gate.status, 'yolo');
  assert.equal(isApproved(gate), true);
  assert.equal(isBlockedByGate(gate), false);
});

test('switching an awaiting plan to yolo releases the gate', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const yolo = switchMode(gate, 'yolo');
  assert.equal(yolo.status, 'yolo');
  assert.equal(isBlockedByGate(yolo), false);
});

test('plan mode: startTask is waiting for a plan, nothing is approved until received and confirmed', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  assert.equal(gate.status, 'awaiting_plan');
  assert.equal(isApproved(gate), false);
  assert.equal(isBlockedByGate(gate), true);
});

test('valid [PLAN] moves the gate to plan_ready, waits for user confirmation', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: next, outcome } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  assert.equal(outcome.kind, 'ready');
  assert.equal(next.status, 'plan_ready');
  assert.equal(isApproved(next), false); // Enter has not been pressed yet
});

test('[Enter]: approvePlan translates plan_ready -> approved', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: ready } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  const approved = approvePlan(ready);
  assert.equal(approved.status, 'approved');
  assert.equal(isApproved(approved), true);
});

test('[Esc]: cancelPlan resets the gate to idle', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: ready } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  assert.deepEqual(cancelPlan(), IDLE_GATE);
  void ready;
});

test('invalid plan format (1st, 2nd attempt) -> retry with an example of the format, the gate remains awaiting_plan', () => {
  let gate = startTask('t1', Date.now(), 'plan');
  const first = receivePlanText(gate, 'this is not a plan', ['coder1']);
  assert.equal(first.outcome.kind, 'retry');
  if (first.outcome.kind === 'retry') assert.match(first.outcome.message, /\[PLAN\]/);
  assert.equal(first.gate.status, 'awaiting_plan');
  gate = first.gate;

  const second = receivePlanText(gate, 'no plan again', ['coder1']);
  assert.equal(second.outcome.kind, 'retry');
  assert.equal(second.gate.status, 'awaiting_plan');
});

test('invalid plan format - 3rd failure -> show_raw, raw text saved for display to user', () => {
  let gate = startTask('t1', Date.now(), 'plan');
  gate = receivePlanText(gate, 'not plan 1', ['coder1']).gate;
  gate = receivePlanText(gate, 'not plan 2', ['coder1']).gate;
  const third = receivePlanText(gate, 'not plan 3', ['coder1']);
  assert.equal(third.outcome.kind, 'show_raw');
  if (third.outcome.kind === 'show_raw') assert.equal(third.outcome.rawText, 'not plan 3');
});

// Task A.6: invalid plan (non-existent agent, cycle) is returned to the orchestrator BEFORE display
// to the user - the same path as the format retreat (retry), not a separate branch.
test('plan with non-existent agent_id -> retry, not shown to user as plan_ready', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const badAgentPlan = ['[PLAN]', 'STEP 1 | ghost5 | x | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n');
  const { gate: next, outcome } = receivePlanText(gate, badAgentPlan, ['coder1']);
  assert.equal(outcome.kind, 'retry');
  assert.equal(next.status, 'awaiting_plan');
});

test('timeout 120s: gate is still awaiting_plan -> timed_out; ahead of schedule -> does not touch', () => {
  const start = 1_000_000;
  const gate = startTask('t1', start, 'plan');

  const early = checkTimeout(gate, start + PLAN_TIMEOUT_MS - 1);
  assert.equal(early.status, 'awaiting_plan');

  const late = checkTimeout(gate, start + PLAN_TIMEOUT_MS);
  assert.equal(late.status, 'timed_out');
});

test('timeout does not touch gate outside awaiting_plan (already approved/yolo)', () => {
  const gate = startTask('t1', 0, 'yolo');
  const result = checkTimeout(gate, PLAN_TIMEOUT_MS * 10);
  assert.equal(result.status, 'yolo');
});

test('edit in $EDITOR: valid markdown -> approved directly, PLAN_REVISED goes to orchestrator with editor text', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;

  const editedText = ['[PLAN]', 'STEP 1 | coder1 | Other description | FILES: src/a.ts | DEPENDS: none', '[/PLAN]'].join('\n');
  const outcome = revisePlan(ready, editedText, ['coder1']);
  assert.ok('toOrchestrator' in outcome);
  if (!('toOrchestrator' in outcome)) return;
  assert.equal(outcome.gate.status, 'approved');
  assert.equal(outcome.toOrchestrator.type, 'PLAN_REVISED');
  assert.equal(outcome.toOrchestrator.payload, editedText);
  assert.equal(outcome.gate.plan?.steps[0].description, 'Other description');
});

test('planToEditableText: round-trip via parsePlanText/validatePlan - what opens in $EDITOR is parsed again without loss', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;
  const text = planToEditableText(ready.plan!);
  const outcome = revisePlan(ready, text, ['coder1']);
  assert.ok('toOrchestrator' in outcome);
  if ('toOrchestrator' in outcome) assert.deepEqual(outcome.gate.plan, ready.plan);
});

test('edit in $EDITOR: invalid markdown -> error, gate is not promoted', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;

  const outcome = revisePlan(ready, 'broken markdown', ['coder1']);
  assert.ok('error' in outcome);
  if (!('error' in outcome)) return;
  assert.equal(outcome.gate.status, 'plan_ready');
});
