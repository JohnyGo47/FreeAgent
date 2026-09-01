// spec_plan_execution — unit-тесты движка исполнения. Тесты 4/5 (цикл/unknown agent отклонены)
// уже покрыты orchestrator/plan.test.ts (validatePlan — общий код, задача B.8 говорит не
// дублировать). Тест 9 (SWITCHING → очередь) — интеграционный, требует mainLoop/router; живёт в
// planExecution.integration.test.ts. Тест 7 (красные тесты → эскалация) заходом 2 стал доступен:
// applyResult реально зовёт verification (verifyFn инъецируется здесь для скорости/чистоты
// юнит-тестов — реальный прогон процесса проверяется в verification.test.ts и
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

// Юнит-тесты сценариев планирования не про verification сами по себе — им нужна ok-заглушка,
// чтобы не гонять реальный процесс на каждый DONE. Реальный verifyStep проверяется отдельно
// (verification.test.ts) и в интеграции (planExecution.integration.test.ts).
const okVerify = async (): Promise<VerifyVerdict> => ({ kind: 'ok', log: '' });
const ctx: VerifyContext = { cwd: '.', timeoutMs: 1000, logsDir: '.', verifyFn: okVerify };

const LINEAR_3 = [
  '[PLAN]',
  'STEP 1 | researcher1 | Найти практики | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Написать middleware | FILES: src/auth.ts | DEPENDS: 1',
  'STEP 3 | coder1 | Подключить роутер | FILES: src/router.ts | DEPENDS: 2',
  '[/PLAN]',
].join('\n');

test('линейный план из 3 шагов: только шаг 1 сразу готов, следующий открывается только после RESULT:DONE предыдущего', async () => {
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

test('два независимых шага без пересечения files -> оба уходят в одном раунде (параллельно)', () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: src/a.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: src/b.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  const state = startExecution(p);
  const round = nextTasks(state);
  assert.equal(round.tasks.length, 2);
  assert.deepEqual(round.tasks.map((t) => t.to).sort(), ['coder1', 'coder2']);
});

test('два шага с пересекающимися files и без depends_on -> только один уходит сейчас, второй ждёт освобождения файла', async () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: shared.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: shared.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  let state = startExecution(p);

  const round1 = nextTasks(state);
  assert.equal(round1.tasks.length, 1); // последовательно, не параллельно — несмотря на отсутствие depends_on
  state = round1.state;

  const round2 = nextTasks(state); // шаг 1 ещё 'sent' (RESULT не пришёл) — файл занят
  assert.equal(round2.tasks.length, 0);

  const taskId = (round1.tasks[0].payload as { task_id: string }).task_id;
  const doneAgent = round1.tasks[0].to;
  const after = await applyResult(state, resultMsg(taskId, doneAgent, 'DONE'), 70, ctx);

  const round3 = nextTasks(after.state); // файл освободился -> второй шаг теперь готов
  assert.equal(round3.tasks.length, 1);
  assert.notEqual(round3.tasks[0].to, doneAgent);
});

test('RESULT: FAILED -> эскалация с текстом ошибки, зависимые шаги не стартуют', async () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'FAILED', 'boom'), 70, ctx);
  assert.equal(after.event.kind, 'escalate');
  if (after.event.kind === 'escalate') assert.match(after.event.reason, /boom/);

  const nextRound = nextTasks(after.state);
  assert.equal(nextRound.tasks.length, 0); // шаг 2 зависит от заваленного шага 1 — не открывается
});

// spec_plan_execution Test 7 (задача A.7 захода 2): "красные тесты" — теперь доступно.
// verifyFn стоит на месте реального verifyStep (spec_verification), тестируется как контракт.
test('RESULT: DONE, но verification вернула failed ("красные тесты") -> эскалация, зависимые шаги не стартуют', async () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const redVerify = async (params: VerifyParams): Promise<VerifyVerdict> => {
    assert.equal(params.taskId, taskId); // applyResult реально прокидывает task_id в verification
    return { kind: 'failed', reason: 'AssertionError: expected 2 to equal 3' };
  };

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE'), 70, { ...ctx, verifyFn: redVerify });
  assert.equal(after.event.kind, 'escalate');
  if (after.event.kind === 'escalate') assert.match(after.event.reason, /expected 2 to equal 3/);

  const nextRound = nextTasks(after.state);
  assert.equal(nextRound.tasks.length, 0);
});

test('RESULT: DONE, verification unverified (нет TESTS_READY) -> шаг закрыт, но помечен unverified', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | researcher1 | ресёрч | FILES: research.md | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const unverifiedVerify = async (): Promise<VerifyVerdict> => ({ kind: 'unverified' });
  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE'), 70, { ...ctx, verifyFn: unverifiedVerify });

  assert.equal(after.event.kind, 'complete');
  assert.equal(after.unverified, true);
  assert.ok(after.state.unverifiedSteps.has(1)); // "видим пользователю", не выдан за проверенный
});

test('recordTestsReady: command сохраняется против шага по task_id, доходит до verifyFn при DONE', async () => {
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

test('self_assessment ниже порога -> эскалация, даже если status: DONE', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | researcher1 | ресёрч | FILES: research.md | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = await applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE', 'сделано, наверное', 40), 70, ctx);
  assert.equal(after.event.kind, 'escalate');
});

test('WRITE вне заявленных files текущего шага -> ERROR, файл не записан', async (t) => {
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

test('recordWrittenFile: файлы шага копятся, доходят до verifyFn как writtenFiles', async () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts, b.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const round = nextTasks(startExecution(p));
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  let state = recordWrittenFile(round.state, 'coder1', 'a.ts');
  state = recordWrittenFile(state, 'coder1', 'b.ts');
  state = recordWrittenFile(state, 'coder1', 'a.ts'); // дубликат — не размножается

  let seen: string[] | undefined;
  const captureVerify = async (params: VerifyParams): Promise<VerifyVerdict> => {
    seen = params.writtenFiles;
    return { kind: 'ok', log: '' };
  };
  await applyResult(state, resultMsg(taskId, 'coder1', 'DONE'), 70, { ...ctx, verifyFn: captureVerify });
  assert.deepEqual(seen, ['a.ts', 'b.ts']);
});

test('currentStepFilesForAgent: агент вне активного шага -> null (уровень-3 пропускается)', () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: src/a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  assert.equal(currentStepFilesForAgent(state, 'coder1'), null); // TASK ещё не отправлена
  assert.equal(currentStepFilesForAgent(state, 'coder9'), null); // не участвует в плане вовсе
});

test('дедупликация: 20 одинаковых STATUS подряд -> 0 сообщений оркестратору', () => {
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

test('/stop: nextTasks перестаёт отправлять новые задачи после stopExecution', () => {
  const p = plan(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: b.ts | DEPENDS: none', '[/PLAN]'].join('\n'),
  );
  const state = stopExecution(startExecution(p));
  const round = nextTasks(state);
  assert.equal(round.tasks.length, 0);
});

test('applyOwnershipViolation: WRITE вне files -> эскалация (независимо от verification)', () => {
  const p = plan(['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  const round = nextTasks(startExecution(p));
  const outcome = applyOwnershipViolation(round.state, 'coder1', 'other.ts');
  assert.equal(outcome.event.kind, 'escalate');
  if (outcome.event.kind === 'escalate') assert.match(outcome.event.reason, /other\.ts/);
});
