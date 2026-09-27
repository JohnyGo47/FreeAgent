// spec_plan_execution - unit tests of the execution engine. Tests 4/5 (cycle/unknown agent rejected)
// already covered orchestrator/plan.test.ts (validatePlan - general code, task B.8 says not
// duplicate). Test 9 (SWITCHING → queue) - integration, requires mainLoop/router; lives in
// planExecution.integration.test.ts. Test 7 (red tests → escalation) by run 2 became available:
// applyResult actually calls verification (verifyFn is injected here for speed/cleanliness
// unit tests - the actual process run is checked in verification.test.ts and
// planExecution.integration.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlanText } from '../orchestrator/plan.ts';
import { write } from '../fs/write.ts';
import type { BusMessage, PlanPayload, ResultPayload, StatusPayload, TestsReadyPayload } from '../../../shared/bus-types/index.ts';
import type { VerifyParams, VerifyVerdict } from './verification.ts';
import {
  startExecution,
  nextTasks,
  applyResult,
  applyOwnershipViolation,
  dedupeStatus,
  isComplete,
  currentStepFilesForAgent,
  stopExecution,
  recordTestsReady,
  recordWrittenFile,
  type VerifyContext,
} from './planExecution.ts';

function plan(text: string): PlanPayload {
  const parsed = parsePlanText(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.plan;
}

function resultMsg(taskId: string, agentId: string, status: 'DONE' | 'FAILED', summary = 'ok', selfAssessment?: number): BusMessage {
  const payload: ResultPayload = { task_id: taskId, status, summary, ...(selfAssessment !== undefined ? { self_assessment: { percent: selfAssessment, reasoning: 'x' } } : {}) };
  return { id: 'r', from: agentId, to: 'orchestrator', type: 'RESULT', ts: new Date().toISOString(), payload };
}

// Unit tests for planning scenarios are not about verification in themselves - they need an ok stub,
// so as not to run the real process for every DONE. The real verifyStep is checked separately
// (verification.test.ts) and in integration (planExecution.integration.test.ts).
const okVerify = async (): Promise<VerifyVerdict> => ({ kind: 'ok', log: '' });
const ctx: VerifyContext = { cwd: '.', timeoutMs: 1000, logsDir: '.', verifyFn: okVerify };

const LINEAR_3 = [
  '[PLAN]',
  'STEP 1 | researcher1 | Find practices | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Write middleware | FILES: src/auth.ts | DEPENDS: 1',
  'STEP 3 | coder1 | Connect router | FILES: src/router.ts | DEPENDS: 2',
  '[/PLAN]',
].join('\n');

test('linear plan of 3 steps: only step 1 is ready immediately, the next one opens only after RESULT:DONE of the previous one', async () => {
  let state = startExecution(plan(LINEAR_3));

  let round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'researcher1');
  state = round.state;

  const step1TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after1 = await applyResult(state, resultMsg(step1TaskId, 'researcher1', 'DONE'), 70, ctx);
  assert.equal(after1.event.kind, 'progress');
  state = after1.state;

  round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'coder1');
  state = round.state;

  const step2TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after2 = await applyResult(state, resultMsg(step2TaskId, 'coder1', 'DONE'), 70, ctx);
  state = after2.state;

  round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'coder1');
  const step3TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after3 = await applyResult(round.state, resultMsg(step3TaskId, 'coder1', 'DONE'), 70, ctx);
  assert.equal(after3.event.kind, 'complete');
  assert.equal(isComplete(after3.state), true);
});

test('two independent steps without crossing files -> both go in one round (in parallel)', () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: src/a.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: src/b.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  const state = startExecution(p);
  const round = nextTasks(state);
  assert.equal(round.tasks.length, 2);
  assert.deepEqual(round.tasks.map((t) => t.to).sort(), ['coder1', 'coder2']);
});

test('two steps with overlapping files and without depends_on -> only one leaves now, the second waits for the file to be released', async () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: shared.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: shared.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  let state = startExecution(p);

  const round1 = nextTasks(state);
  assert.equal(round1.tasks.length, 1); // sequentially, not parallel - despite the absence of depends_on
  state = round1.state;

  const round2 = nextTasks(state); // step 1 still 'sent' (RESULT did not arrive) - file is busy
  assert.equal(round2.tasks.length, 0);

  const taskId = (round1.tasks[0].payload as { task_id: string }).task_id;
  const doneAgent = round1.tasks[0].to;
  const after = await applyResult(state, resultMsg(taskId, doneAgent, 'DONE'), 70, ctx);

  const round3 = nextTasks(after.state); // file freed -> second step is now ready
  assert.equal(round3.tasks.length, 1);
  assert.notEqual(round3.tasks[0].to, doneAgent);
});

test('RESULT: FAILED -> escalation with error text, dependent steps do not start', async () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'FAILED', 'boom'), 70, ctx);
  assert.equal(after.event.kind, 'escalate');
  if (after.event.kind === 'escalate') assert.match(after.event.reason, /boom/);

  const nextRound = nextTasks(after.state);
  assert.equal(nextRound.tasks.length, 0); // step 2 depends on failed step 1 - does not open
});

// spec_plan_execution Test 7 (task A.7 of run 2): “red tests” - now available.
// verifyFn stands in place of the real verifyStep (spec_verification), tested as a contract.
test('RESULT: DONE, but verification returned failed ("red tests") -> escalation, dependent steps do not start', async () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const redVerify = async (params: VerifyParams): Promise<VerifyVerdict> => {
    assert.equal(params.taskId, taskId); // applyResult actually applies task_id to verification
    return { kind: 'failed', reason: 'AssertionError: expected 2 to equal 3' };
  };

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE'), 70, { ...ctx, verifyFn: redVerify });
  assert.equal(after.event.kind, 'escalate');
  if (after.event.kind === 'escalate') assert.match(after.event.reason, /expected 2 to equal 3/);

  const nextRound = nextTasks(after.state);
  assert.equal(nextRound.tasks.length, 0);
});

test('RESULT: DONE, verification unverified (no TESTS_READY) -> step closed but marked unverified', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | researcher1 | research | FILES: research.md | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const unverifiedVerify = async (): Promise<VerifyVerdict> => ({ kind: 'unverified' });
  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE'), 70, { ...ctx, verifyFn: unverifiedVerify });

  assert.equal(after.event.kind, 'complete');
  assert.equal(after.unverified, true);
  assert.ok(after.state.unverifiedSteps.has(1)); // "visible to the user", not passed off as verified
});

test('recordTestsReady: command saved against step by task_id, reaches verifyFn on DONE', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const round = nextTasks(startExecution(p));
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const payload: TestsReadyPayload = { task_id: taskId, command: 'npm test' };
  const withCommand = recordTestsReady(round.state, { id: 'x', from: 'coder1', to: 'cli', type: 'TESTS_READY', ts: new Date().toISOString(), payload });

  let seenCommand: string | undefined;
  const captureVerify = async (params: VerifyParams): Promise<VerifyVerdict> => {
    seenCommand = params.command;
    return { kind: 'ok', log: '' };
  };
  await applyResult(withCommand, resultMsg(taskId, 'coder1', 'DONE'), 70, { ...ctx, verifyFn: captureVerify });
  assert.equal(seenCommand, 'npm test');
});

test('self_assessment below threshold -> escalation even if status: DONE', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | researcher1 | research | FILES: research.md | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE', 'probably done', 40), 70, ctx);
  assert.equal(after.event.kind, 'escalate');
});

test('WRITE outside the declared files of the current step -> ERROR, the file was not written', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-planexec-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: src/a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  void round;

  const ownedFiles = currentStepFilesForAgent(round.state, 'coder1');
  assert.deepEqual(ownedFiles, ['src/a.ts']);

  const res = await write(root, 'src/other.ts', 'oops', 'code', ownedFiles);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'FILE_NOT_OWNED');
  await assert.rejects(readFile(join(root, 'src', 'other.ts'), 'utf8'));
});

test('recordWrittenFile: step files are accumulated, reach verifyFn as writtenFiles', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts, b.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const round = nextTasks(startExecution(p));
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  let state = recordWrittenFile(round.state, 'coder1', 'a.ts');
  state = recordWrittenFile(state, 'coder1', 'b.ts');
  state = recordWrittenFile(state, 'coder1', 'a.ts'); // duplicate - does not reproduce

  let seen: string[] | undefined;
  const captureVerify = async (params: VerifyParams): Promise<VerifyVerdict> => {
    seen = params.writtenFiles;
    return { kind: 'ok', log: '' };
  };
  await applyResult(state, resultMsg(taskId, 'coder1', 'DONE'), 70, { ...ctx, verifyFn: captureVerify });
  assert.deepEqual(seen, ['a.ts', 'b.ts']);
});

test('currentStepFilesForAgent: agent outside active step -> null (level-3 skipped)', () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: src/a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  assert.equal(currentStepFilesForAgent(state, 'coder1'), null); // TASK has not been sent yet
  assert.equal(currentStepFilesForAgent(state, 'coder9'), null); // does not participate in the plan at all
});

test('deduplication: 20 identical STATUS in a row -> 0 messages to orchestrator', () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  let forwarded = 0;
  for (let i = 0; i < 20; i++) {
    const payload: StatusPayload = { state: 'WORKING' };
    const msg: BusMessage = { id: `s${i}`, from: 'coder1', to: 'cli', type: 'STATUS', ts: new Date().toISOString(), payload };
    const result = dedupeStatus(state, msg);
    state = result.state;
    if (result.toOrchestrator) forwarded++;
  }
  assert.equal(forwarded, 0);
});

test('/stop: nextTasks stops sending new tasks after stopExecution', () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: b.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  const state = stopExecution(startExecution(p));
  const round = nextTasks(state);
  assert.equal(round.tasks.length, 0);
});

test('applyOwnershipViolation: WRITE outside files -> escalation (regardless of verification)', () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const round = nextTasks(startExecution(p));
  const outcome = applyOwnershipViolation(round.state, 'coder1', 'other.ts');
  assert.equal(outcome.event.kind, 'escalate');
  if (outcome.event.kind === 'escalate') assert.match(outcome.event.reason, /other\.ts/);
});
