// Интеграционные тесты spec_cli_plan_mode + spec_plan_execution через настоящий runMainLoopOnce
// (тот же стиль, что mainLoop.test.ts) — покрывает то, что не тестируется как чистая функция:
// маршрутизация, буферизация SWITCHING (router.ts), запись на диск через FS_CALL, персистентная
// шина. "Живой оркестратор" из Integration check обеих спек эмулируется тем, что мы сами кладём
// в incoming ровно то, что он бы прислал (тот же приём, что REGISTER_REQUEST/FS_CALL интеграционные
// тесты этого репозитория).
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

// spec_cli_plan_mode Test 1+2: агенты не получают TASK до APPROVED; WRITE до APPROVED -> PAUSE.
test('plan mode: TASK оркестратора агенту и WRITE от агента до APPROVED — оба заблокированы, PAUSE + уведомление', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'сделай штуку' }) + '\n', 'utf8');

  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: baseRegistry(), buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state); // задача стартует, гейт -> awaiting_plan
  assert.equal(state.gate?.status, 'awaiting_plan');

  // Оркестратор игнорирует протокол и шлёт TASK агенту напрямую, минуя план.
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_o.jsonl'),
    line('m2', 'orchestrator', 'coder1', 'TASK', { task_id: 't2', description: 'просто сделай' }) + '\n',
    'utf8',
  );
  const round2 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round2.commands.length, 1);
  assert.equal(round2.commands[0].message.type, 'COMMAND');
  assert.equal((round2.commands[0].message.payload as { command: string }).command, 'PAUSE');
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /PLAN_MODE_VIOLATION/);

  // Отдельно: агент шлёт WRITE (FS_CALL) до APPROVED — тоже пауза, файл не написан.
  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('m3', 'coder1', 'cli', 'FS_CALL', '[FS | op: write | path: sneaky.md | kind: doc | end: ---END---]\nx\n---END---') + '\n',
    'utf8',
  );
  const round3 = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round3.commands.some((c) => c.message.type === 'COMMAND' && (c.message.payload as { command: string }).command === 'PAUSE'), true);
  await assert.rejects(readFile(join(freeagentDir, '..', 'sneaky.md'), 'utf8'));
});

// spec_cli_plan_mode Test 3: yolo пропускает гейт, TASK/WRITE проходят сразу.
test('yolo: WRITE от агента проходит сразу, без ожидания плана', async (t) => {
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
  assert.equal(round.commands.some((c) => c.message.type === 'COMMAND'), false); // никакого PAUSE
  const written = await readFile(join(freeagentDir, '..', 'fast.md'), 'utf8');
  assert.equal(written, 'hi');
});

// spec_plan_execution Test 4/5 (общий код с orchestrator/plan.test.ts, задача A.6/B.8): невалидный
// план возвращается оркестратору ДО показа пользователю, не выполняется частично.
test('план с циклом или несуществующим agent_id: retry оркестратору, гейт не доходит до plan_ready', async (t) => {
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
  assert.equal(state.gate?.status, 'awaiting_plan'); // 1-я неудача — retry, не сдача
  assert.equal(round.commands.length, 0); // ничего не ушло агентам — план не начал исполняться
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /"command":"REPLAN"/);
});

// spec_plan_execution Integration check: план на 4 шага с двумя параллельными ветками ->
// полное исполнение без участия оркестратора в процессе -> ровно один NOTIFY (PLAN_COMPLETE).
// Заодно покрывает Test 9 (SWITCHING -> очередь -> доставка после READY, остальные ветки идут).
test('integration: план на 4 шага с двумя параллельными ветками — полностью исполняется, оркестратор получает только PLAN_COMPLETE; агент в SWITCHING получает задачу в очередь', async (t) => {
  const freeagentDir = await projectDir();
  t.after(() => rm(freeagentDir, { recursive: true, force: true }));

  const registry = baseRegistry();
  registry.coder2.status = 'SWITCHING'; // задача B.12 / Test 9: переходный статус на старте

  await writeFile(join(freeagentDir, 'incoming', 'browser_user.jsonl'), line('m1', 'user', 'orchestrator', 'TASK', { task_id: 't1', description: 'go' }) + '\n', 'utf8');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };
  await runMainLoopOnce(freeagentDir, writer, state);

  const plan4 = [
    '[PLAN]',
    'STEP 1 | coder1 | ветка A шаг 1 | FILES: a1.ts | DEPENDS: none',
    'STEP 2 | coder1 | ветка A шаг 2 | FILES: a2.ts | DEPENDS: 1',
    'STEP 3 | coder2 | ветка B шаг 1 | FILES: b1.ts | DEPENDS: none',
    'STEP 4 | coder2 | ветка B шаг 2 | FILES: b2.ts | DEPENDS: 3',
    '[/PLAN]',
  ].join('\n');
  await writeFile(join(freeagentDir, 'incoming', 'browser_o.jsonl'), line('m2', 'orchestrator', 'cli', 'PLAN', plan4) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.gate?.status, 'plan_ready');

  // [Enter] в TUI: approvePlan + запуск исполнения (та же последовательность, что делает bin.ts).
  const { approvePlan } = await import('./planMode.ts');
  const { startExecution } = await import('./planExecution.ts');
  state.gate = approvePlan(state.gate!);
  state.execution = startExecution(state.gate.plan!);

  // Тик: шаг 1 (coder1, IDLE) уходит сразу; шаг 3 (coder2, SWITCHING) — в очередь router.ts, не в commands.
  let round = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round.commands.filter((c) => c.message.type === 'TASK').length, 1);
  assert.equal(round.commands[0].instanceId, 'browser_a');
  assert.ok(state.buffered.coder2?.length === 1, 'шаг 3 ждёт в очереди buffered, пока coder2 не READY');

  const step1TaskId = (round.commands.find((c) => c.message.type === 'TASK')!.message.payload as { task_id: string }).task_id;
  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r1', 'coder1', 'orchestrator', 'RESULT', { task_id: step1TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state); // шаг 1 закрыт -> шаг 2 уходит coder1
  const step2Task = round.commands.find((c) => c.message.type === 'TASK');
  assert.ok(step2Task, 'ветка A продолжается независимо от того, что ветка B ждёт SWITCHING');
  assert.equal(step2Task!.message.to, 'coder1');

  // coder2 наконец готов — READY снимает SWITCHING и разом флашит очередь (шаг 3).
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('ready2', 'coder2', 'cli', 'READY') + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(round.commands.some((c) => c.message.type === 'TASK' && c.message.to === 'coder2'), true, 'шаг 3 доставлен сразу после READY');
  assert.equal(state.buffered.coder2, undefined);

  const step2TaskId = (step2Task!.message.payload as { task_id: string }).task_id;
  const step3TaskId = (round.commands.find((c) => c.message.type === 'TASK' && c.message.to === 'coder2')!.message.payload as { task_id: string }).task_id;

  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), line('r2', 'coder1', 'orchestrator', 'RESULT', { task_id: step2TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('r3', 'coder2', 'orchestrator', 'RESULT', { task_id: step3TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  round = await runMainLoopOnce(freeagentDir, writer, state); // ветка A завершена; ветка B открывает шаг 4
  const step4Task = round.commands.find((c) => c.message.type === 'TASK' && c.message.to === 'coder2');
  assert.ok(step4Task);

  const step4TaskId = (step4Task!.message.payload as { task_id: string }).task_id;
  await writeFile(join(freeagentDir, 'incoming', 'browser_b.jsonl'), line('r4', 'coder2', 'orchestrator', 'RESULT', { task_id: step4TaskId, status: 'DONE', summary: 'done' }) + '\n', 'utf8');
  await runMainLoopOnce(freeagentDir, writer, state);

  assert.equal(state.execution, undefined, 'план завершён и очищен');
  assert.equal(state.gate?.status, 'idle');

  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  const notifyToOrchestrator = bus.split('\n').filter((l) => l.includes('"type":"NOTIFY"') && l.includes('"to":"orchestrator"'));
  assert.equal(notifyToOrchestrator.length, 1, 'на счастливом пути ровно одно сообщение оркестратору — PLAN_COMPLETE');
  assert.match(notifyToOrchestrator[0], /PLAN_COMPLETE/);
});
