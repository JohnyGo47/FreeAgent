// Сквозной тест: mainLoop.ts реально вызывает verification (реальный npm test, реальный процесс)
// И git_checkpoints (реальный git-репозиторий) на одном и том же RESULT:DONE — то, что unit-тесты
// verification.test.ts/gitCheckpoints.test.ts проверяют по отдельности (с моками/инъекцией), здесь
// проверяется как единая цепочка через настоящий runMainLoopOnce. Ни git, ни npm test не замоканы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BusWriter } from '../bus/write.ts';
import { runMainLoopOnce, type MainLoopState } from './mainLoop.ts';
import { approvePlan } from './planMode.ts';
import { startExecution } from './planExecution.ts';
import { loadCheckpoints } from './gitCheckpoints.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

const execFileAsync = promisify(execFile);

function line(id: string, from: string, to: string, type: string, payload: unknown = {}): string {
  return JSON.stringify({ id, from, to, type, ts: new Date().toISOString(), payload });
}

async function gitProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'freeagent-verify-checkpoints-'));
  await execFileAsync('git', ['init', '-q'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.email', 'a@a.com'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'user.name', 'a'], { cwd: projectRoot });
  await execFileAsync('git', ['config', 'core.autocrlf', 'false'], { cwd: projectRoot });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node math.test.js' } }), 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
  await mkdir(join(projectRoot, 'freeagent', 'incoming'), { recursive: true });
  return projectRoot;
}

function baseRegistry(): AgentsRegistry {
  return {
    orchestrator: { agent_id: 'orchestrator', instance_id: 'browser_o', tab_id: 1, role: 'orchestrator', status: 'IDLE' },
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 2, role: 'coder', status: 'IDLE' },
  };
}

async function gitLog(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd });
  return stdout.trim().split('\n');
}

async function setUpApprovedPlan(freeagentDir: string, writer: BusWriter, state: MainLoopState): Promise<void> {
  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'add math.add' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);

  const plan1 = ['[PLAN]', 'STEP 1 | coder1 | write math.add | FILES: math.test.js, math.js | DEPENDS: none', '[/PLAN]'].join('\n');
  await writeFile(join(freeagentDir, 'incoming', 'browser_o.jsonl'), line('m2', 'orchestrator', 'cli', 'PLAN', plan1) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.gate?.status, 'plan_ready');

  state.gate = approvePlan(state.gate!);
  state.execution = startExecution(state.gate.plan!);
}

test('happy path: реальный npm test зелёный -> шаг закрыт, реальные pre-task + done коммиты в реальном git-репозитории', async (t) => {
  const projectRoot = await gitProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');

  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await setUpApprovedPlan(freeagentDir, writer, state);

  const round = await runMainLoopOnce(freeagentDir, writer, state); // TASK -> coder1
  const taskId = (round.commands.find((c) => c.message.type === 'TASK')!.message.payload as { task_id: string }).task_id;

  // Агент пишет тест первым (протокол spec_verification), затем код — обе записи реально идут на
  // диск через FS_CALL/write.ts.
  const testBody = 'const { add } = require("./math.js"); if (add(2, 3) !== 5) { console.error("boom"); process.exit(1); } console.log("ok");';
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('w1', 'coder1', 'cli', 'FS_CALL', `[FS | op: write | path: math.test.js | kind: test | end: ---END---]\n${testBody}\n---END---`) + '\n',
    'utf8',
  );
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(await readFile(join(projectRoot, 'math.test.js'), 'utf8'), testBody);

  const codeBody = 'module.exports = { add: (a, b) => a + b };';
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('w2', 'coder1', 'cli', 'FS_CALL', `[FS | op: write | path: math.js | kind: code | end: ---END---]\n${codeBody}\n---END---`) + '\n',
    'utf8',
  );
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(await readFile(join(projectRoot, 'math.js'), 'utf8'), codeBody);

  // Только ОДИН pre-task коммит несмотря на два WRITE (дедуп по checkpoints.json).
  let checkpoints = await loadCheckpoints(freeagentDir);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].task_id, taskId);
  assert.equal(checkpoints[0].done_commit, undefined);

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('tr', 'coder1', 'cli', 'TESTS_READY', { task_id: taskId, command: 'npm test' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r1', 'coder1', 'orchestrator', 'RESULT', { task_id: taskId, status: 'DONE', summary: 'added math.add' }) + '\n', 'utf8');
  const finalRound = await runMainLoopOnce(freeagentDir, writer, state); // здесь реально спавнится npm test

  assert.equal(state.execution, undefined); // единственный шаг плана закрыт -> план завершён
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.equal(bus.includes('PLAN_ESCALATION'), false);
  assert.match(bus, /PLAN_COMPLETE/);
  void finalRound;

  const log = await gitLog(projectRoot);
  assert.equal(log[0], `freeagent: ${taskId} — added math.add`);
  assert.equal(log[1], `freeagent: pre-task ${taskId}`);
  assert.equal(log[2], 'init');

  checkpoints = await loadCheckpoints(freeagentDir);
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
  assert.equal(checkpoints[0].done_commit, head.trim()); // checkpoints.json несёт настоящий hash HEAD
  assert.equal(checkpoints[0].summary, 'added math.add');
});

test('red path: реальный npm test падает -> эскалация с реальным stderr/stdout, done-коммит НЕ создаётся', async (t) => {
  const projectRoot = await gitProject();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');

  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await setUpApprovedPlan(freeagentDir, writer, state);

  const round = await runMainLoopOnce(freeagentDir, writer, state);
  const taskId = (round.commands.find((c) => c.message.type === 'TASK')!.message.payload as { task_id: string }).task_id;

  const testBody = 'console.error("boom: add is broken"); process.exit(1);';
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('w1', 'coder1', 'cli', 'FS_CALL', `[FS | op: write | path: math.test.js | kind: test | end: ---END---]\n${testBody}\n---END---`) + '\n',
    'utf8',
  );
  await runMainLoopOnce(freeagentDir, writer, state);

  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('w2', 'coder1', 'cli', 'FS_CALL', '[FS | op: write | path: math.js | kind: code | end: ---END---]\nmodule.exports = {};\n---END---') + '\n',
    'utf8',
  );
  await runMainLoopOnce(freeagentDir, writer, state);

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('tr', 'coder1', 'cli', 'TESTS_READY', { task_id: taskId, command: 'npm test' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r1', 'coder1', 'orchestrator', 'RESULT', { task_id: taskId, status: 'DONE', summary: 'added math.add' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);
  const delivered = await runMainLoopOnce(freeagentDir, writer, state); // эскалация лежит на шине с прошлого тика -> маршрутизируется сейчас

  const escalation = delivered.commands.find((c) => c.message.type === 'NOTIFY' && c.instanceId === 'browser_o');
  assert.ok(escalation);
  assert.match((escalation!.message.payload as { details: string }).details, /boom: add is broken/);

  const log = await gitLog(projectRoot);
  assert.equal(log.some((m) => m.startsWith(`freeagent: ${taskId} —`)), false); // done-коммит не создан
  assert.equal(log[0], `freeagent: pre-task ${taskId}`); // pre-task остался как маркер начала работы

  const checkpoints = await loadCheckpoints(freeagentDir);
  assert.equal(checkpoints[0].done_commit, undefined);
});
