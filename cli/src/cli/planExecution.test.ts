// spec_plan_execution — unit-тесты движка исполнения. Тесты 4/5 (цикл/unknown agent отклонены)
// уже покрыты orchestrator/plan.test.ts (validatePlan — общий код, задача B.8 говорит не
// дублировать). Тесты 7 (красные тесты) и 9 (SWITCHING → очередь) — интеграционные, требуют
// mainLoop/router/verification-stub; живут в planExecution.integration.test.ts. Тест 7 здесь
// сведён к механически доступному в этом PR сигналу — RESULT: FAILED (verification — заглушка
// захода 2, "красные тесты" через неё не реализованы).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlanText } from '../orchestrator/plan.ts';
import { write } from '../fs/write.ts';
import type { BusMessage, PlanPayload, ResultPayload, StatusPayload } from '../../../shared/bus-types/index.ts';
import {
  startExecution,
  nextTasks,
  applyResult,
  applyOwnershipViolation,
  dedupeStatus,
  isComplete,
  currentStepFilesForAgent,
  stopExecution,
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

const LINEAR_3 = [
  '[PLAN]',
  'STEP 1 | researcher1 | Найти практики | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Написать middleware | FILES: src/auth.ts | DEPENDS: 1',
  'STEP 3 | coder1 | Подключить роутер | FILES: src/router.ts | DEPENDS: 2',
  '[/PLAN]',
].join('\n');

test('линейный план из 3 шагов: только шаг 1 сразу готов, следующий открывается только после RESULT:DONE предыдущего', () => {
  let state = startExecution(plan(LINEAR_3));

  let round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'researcher1');
  state = round.state;

  const step1TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after1 = applyResult(state, resultMsg(step1TaskId, 'researcher1', 'DONE'), 70);
  assert.equal(after1.event.kind, 'progress');
  state = after1.state;

  round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'coder1');
  state = round.state;

  const step2TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after2 = applyResult(state, resultMsg(step2TaskId, 'coder1', 'DONE'), 70);
  state = after2.state;

  round = nextTasks(state);
  assert.equal(round.tasks.length, 1);
  assert.equal(round.tasks[0].to, 'coder1');
  const step3TaskId = (round.tasks[0].payload as { task_id: string }).task_id;
  const after3 = applyResult(round.state, resultMsg(step3TaskId, 'coder1', 'DONE'), 70);
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

test('два шага с пересекающимися files и без depends_on -> только один уходит сейчас, второй ждёт освобождения файла', () => {
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
  const after = applyResult(state, resultMsg(taskId, doneAgent, 'DONE'), 70);

  const round3 = nextTasks(after.state); // файл освободился -> второй шаг теперь готов
  assert.equal(round3.tasks.length, 1);
  assert.notEqual(round3.tasks[0].to, doneAgent);
});

test('RESULT: FAILED -> эскалация с текстом ошибки, зависимые шаги не стартуют', () => {
  const p = plan(LINEAR_3);
  let state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = applyResult(round.state, resultMsg(taskId, 'researcher1', 'FAILED', 'boom'), 70);
  assert.equal(after.event.kind, 'escalate');
  if (after.event.kind === 'escalate') assert.match(after.event.reason, /boom/);

  const nextRound = nextTasks(after.state);
  assert.equal(nextRound.tasks.length, 0); // шаг 2 зависит от заваленного шага 1 — не открывается
});

test('self_assessment ниже порога -> эскалация, даже если status: DONE', () => {
  const p = plan(['[PLAN]', 'STEP 1 | researcher1 | ресёрч | FILES: research.md | DEPENDS: none', '[/PLAN]'].join('\n'));
  const state = startExecution(p);
  const round = nextTasks(state);
  const taskId = (round.tasks[0].payload as { task_id: string }).task_id;

  const after = applyResult(round.state, resultMsg(taskId, 'researcher1', 'DONE', 'сделано, наверное', 40), 70);
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
