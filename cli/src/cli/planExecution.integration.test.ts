// Integration tests spec_cli_plan_mode + spec_plan_execution via real runMainLoopOnce
// (same style as mainLoop.test.ts) - covers what is not tested as a pure function:
// routing, buffering SWITCHING (router.ts), writing to disk via FS_CALL, persistent
// bus. The “live orchestrator” from the Integration check of both specs is emulated by what we ourselves put
// in incoming exactly what he would have sent (the same technique as REGISTER_REQUEST/FS_CALL integration
// tests of this repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusWriter } from '../bus/write.ts';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './mainLoop.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function line(id: string, from: string, to: string, type: string, payload: unknown = {}): string {
  return JSON.stringify({ id, from, to, type, ts: new Date().toISOString(), payload });
}

async function projectDir(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'freeagent-planexec-e2e-'));
  const freeagentDir = join(projectRoot, 'freeagent');
  await mkdir(join(freeagentDir, 'incoming'), { recursive: true });
  return freeagentDir;
}

function baseRegistry(): AgentsRegistry {
  return {
    orchestrator: { agent_id: 'orchestrator', instance_id: 'browser_o', tab_id: 1, role: 'orchestrator', status: 'IDLE' },
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 2, role: 'coder', status: 'IDLE' },
    coder2: { agent_id: 'coder2', instance_id: 'browser_b', tab_id: 3, role: 'coder', status: 'IDLE' },
  };
}

// spec_cli_plan_mode Test 1+2: agents do not receive TASK until APPROVED; WRITE to APPROVED -> PAUSE.
test('plan mode: TASK orchestrator to agent and WRITE from agent to APPROVED - both blocked, PAUSE + notification', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'do the thing' }) + '\n', 'utf8');

  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state); // task starts, gate -> awaiting_plan
  assert.equal(state.gate?.status, 'awaiting_plan');

  // The orchestrator ignores the protocol and sends a TASK to the agent directly, bypassing the plan.
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_o.jsonl'),
    line('m2', 'orchestrator', 'coder1', 'TASK', { task_id: 't2', description: 'just do it' }) + '\n',
    'utf8',
  );
  const round2 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round2.commands.length, 1);
  assert.equal(round2.commands[0].message.type, 'COMMAND');
  assert.equal((round2.commands[0].message.payload as { command: string }).command, 'PAUSE');
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /PLAN_MODE_VIOLATION/);

  // Separately: the agent sends WRITE (FS_CALL) before APPROVED - also a pause, the file has not been written.
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('m3', 'coder1', 'cli', 'FS_CALL', '[FS | op: write | path: sneaky.md | kind: doc | end: ---END---]\nx\n---END---') + '\n',
    'utf8',
  );
  const round3 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round3.commands.some((c) => c.message.type === 'COMMAND' && (c.message.payload as { command: string }).command === 'PAUSE'), true);
  await assert.rejects(readFile(join(freeagentDir, '..', 'sneaky.md'), 'utf8'));
});

// spec_cli_plan_mode Test 3: yolo skips the gate, TASK/WRITE pass immediately.
test('yolo: WRITE from the agent occurs immediately, without waiting for a plan', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));
  await writeFile(join(freeagentDir, 'freeagent.config.json'), JSON.stringify({ mode: 'yolo' }), 'utf8');

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'go' }) + '\n', 'utf8');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.gate?.status, 'yolo');

  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('m2', 'coder1', 'cli', 'FS_CALL', '[FS | op: write | path: fast.md | kind: doc | end: ---END---]\nhi\n---END---') + '\n',
    'utf8',
  );
  const round = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round.commands.some((c) => c.message.type === 'COMMAND'), false); // no PAUSE
  const written = await readFile(join(freeagentDir, '..', 'fast.md'), 'utf8');
  assert.equal(written, 'hi');
});

// spec_plan_execution Test 4/5 (shared code with orchestrator/plan.test.ts, task A.6/B.8): invalid
// the plan is returned to the orchestrator BEFORE being shown to the user; it is not partially executed.
test('plan with a loop or non-existent agent_id: retry to orchestrator, gate does not reach plan_ready', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'go' }) + '\n', 'utf8');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state);

  const cyclicPlan = ['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: 2', 'STEP 2 | coder1 | b | FILES: b.ts | DEPENDS: 1', '[/PLAN]'].join('\n');
  await writeFile(join(freeagentDir, 'incoming', 'browser_o.jsonl'), line('m2', 'orchestrator', 'cli', 'PLAN', cyclicPlan) + '\n', 'utf8');
  const round = await runMainLoopOnce(freeagentDir, writer, state);

  assert.notEqual(state.gate?.status, 'plan_ready');
  assert.equal(state.gate?.status, 'awaiting_plan'); // 1st failure - retry, not passing
  assert.equal(round.commands.length, 0); // nothing went to the agents - the plan did not begin to be executed
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /"command":"REPLAN"/);
});

// spec_plan_execution Test 7: RESULT:FAILED -> escalation with error text, dependent steps not
// start. planExecution.test.ts tests applyResult() as a pure function; here - what
// mainLoop.ts actually intercepts RESULT on the bus, actually writes escalationNotify to disk
// (doesn't just call the function) and actually DOES NOT send the TASK of step 2 on the next tick.
test('RESULT: FAILED via real tick mainLoop - escalationNotify on bus, dependent step 2 not dispatched', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'go' }) + '\n', 'utf8');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state);

  const linearPlan = [
    '[PLAN]',
    'STEP 1 | coder1 | step 1 | FILES: a.ts | DEPENDS: none',
    'STEP 2 | coder1 | step 2 | FILES: b.ts | DEPENDS: 1',
    '[/PLAN]',
  ].join('\n');
  await writeFile(join(freeagentDir, 'incoming', 'browser_o.jsonl'), line('m2', 'orchestrator', 'cli', 'PLAN', linearPlan) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.gate?.status, 'plan_ready');

  const { approvePlan } = await import('./planMode.ts');
  const { startExecution } = await import('./planExecution.ts');
  state.gate = approvePlan(state.gate!);
  state.execution = startExecution(state.gate.plan!);

  const round1 = await runMainLoopOnce(freeagentDir, writer, state); // step 1 leaves coder1
  const step1Task = round1.commands.find((c) => c.message.type === 'TASK');
  assert.ok(step1Task);
  const step1TaskId = (step1Task!.message.payload as { task_id: string }).task_id;

  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('r1', 'coder1', 'orchestrator', 'RESULT', { task_id: step1TaskId, status: 'FAILED', summary: 'stack trace: TypeError boom' }) + '\n',
    'utf8',
  );
  const round2 = await runMainLoopOnce(freeagentDir, writer, state); // RESULT:FAILED processed on a real tick
  assert.equal(round2.commands.some((c) => c.message.type === 'TASK'), false); // step 2 does not go away with this tick

  // escalationNotify is written via writer.mergeOnce (the same technique as ERROR/other toBus in
  // this file) - appears in the bus file, but the round that spawned it has not yet read this file
  // again, so the real routing is visible to the orchestrator at the NEXT tick.
  const round3 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round3.commands.some((c) => c.message.type === 'TASK'), false, 'step 2 depends on failed step 1 and never opens');
  const delivered = round3.commands.find((c) => c.message.type === 'NOTIFY' && c.instanceId === 'browser_o');
  assert.ok(delivered, 'the escalation was actually delivered to commands/<instance of the orchestrator>, not just on the bus');
  assert.match((delivered!.message.payload as { details: string }).details, /TypeError boom/);

  await appendCommands(freeagentDir, round3.commands);
  const commandsFile = await readFile(join(freeagentDir, 'commands', 'browser_o.jsonl'), 'utf8');
  assert.match(commandsFile, /PLAN_ESCALATION/);

  // Nothing left undelivered / looped - the next tick is silent.
  const round4 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round4.commands.length, 0);
});

// spec_plan_execution Integration check: 4-step plan with two parallel branches ->
// full execution without orchestrator participation in the process -> exactly one NOTIFY (PLAN_COMPLETE).
// At the same time covers Test 9 (SWITCHING -> queue -> delivery after READY, other branches are in progress).
test('integration: 4-step plan with two parallel branches - fully executed, orchestrator receives only PLAN_COMPLETE; agent in SWITCHING receives task in queue', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  const registry = baseRegistry();
  registry.coder2.status = 'SWITCHING'; // task B.12 / Test 9: transitional status at start

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'go' }) + '\n', 'utf8');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state);

  const plan4 = [
    '[PLAN]',
    'STEP 1 | coder1 | branch A step 1 | FILES: a1.ts | DEPENDS: none',
    'STEP 2 | coder1 | branch A step 2 | FILES: a2.ts | DEPENDS: 1',
    'STEP 3 | coder2 | branch B step 1 | FILES: b1.ts | DEPENDS: none',
    'STEP 4 | coder2 | branch B step 2 | FILES: b2.ts | DEPENDS: 3',
    '[/PLAN]',
  ].join('\n');
  await writeFile(join(freeagentDir, 'incoming', 'browser_o.jsonl'), line('m2', 'orchestrator', 'cli', 'PLAN', plan4) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.gate?.status, 'plan_ready');

  // [Enter] in TUI: approvePlan + start execution (same sequence as bin.ts).
  const { approvePlan } = await import('./planMode.ts');
  const { startExecution } = await import('./planExecution.ts');
  state.gate = approvePlan(state.gate!);
  state.execution = startExecution(state.gate.plan!);

  // Tick: step 1 (coder1, IDLE) goes away immediately; step 3 (coder2, SWITCHING) - to the router.ts queue, not to commands.
  let round = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round.commands.filter((c) => c.message.type === 'TASK').length, 1);
  assert.equal(round.commands[0].instanceId, 'browser_a');
  assert.ok(state.buffered.coder2?.length === 1, 'step 3 waits in buffered queue until coder2 is READY');

  const step1TaskId = (round.commands.find((c) => c.message.type === 'TASK')!.message.payload as { task_id: string }).task_id;
  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r1', 'coder1', 'orchestrator', 'RESULT', { task_id: step1TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state); // step 1 is closed -> step 2 leaves coder1
  const step2Task = round.commands.find((c) => c.message.type === 'TASK');
  assert.ok(step2Task, 'branch A continues regardless of the fact that branch B is waiting for SWITCHING');
  assert.equal(step2Task!.message.to, 'coder1');

  // coder2 is finally ready - READY removes SWITCHING and flushes the queue at once (step 3).
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('ready2', 'coder2', 'cli', 'READY') + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round.commands.some((c) => c.message.type === 'TASK' && c.message.to === 'coder2'), true, 'step 3 delivered immediately after READY');
  assert.equal(state.buffered.coder2, undefined);

  const step2TaskId = (step2Task!.message.payload as { task_id: string }).task_id;
  const step3TaskId = (round.commands.find((c) => c.message.type === 'TASK' && c.message.to === 'coder2')!.message.payload as { task_id: string }).task_id;

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r2', 'coder1', 'orchestrator', 'RESULT', { task_id: step2TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('r3', 'coder2', 'orchestrator', 'RESULT', { task_id: step3TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state); // branch A is completed; branch B opens step 4
  const step4Task = round.commands.find((c) => c.message.type === 'TASK' && c.message.to === 'coder2');
  assert.ok(step4Task);

  const step4TaskId = (step4Task!.message.payload as { task_id: string }).task_id;
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('r4', 'coder2', 'orchestrator', 'RESULT', { task_id: step4TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);

  assert.equal(state.execution, undefined, 'plan completed and cleared');
  assert.equal(state.gate?.status, 'idle');

  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  const notifyToOrchestrator = bus.split('\n').filter((l) => l.includes('"type":"NOTIFY"') && l.includes('"to":"orchestrator"'));
  assert.equal(notifyToOrchestrator.length, 1, 'on the happy path there is exactly one message to the orchestrator - PLAN_COMPLETE');
  assert.match(notifyToOrchestrator[0], /PLAN_COMPLETE/);
});
