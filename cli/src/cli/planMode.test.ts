// spec_cli_plan_mode — unit-тесты гейта и разбора плана. Тесты 1 ("агенты не получают TASK до
// APPROVED") и 2 ("WRITE до APPROVED → PAUSE") — интеграционные, требуют mainLoop/router;
// живут в planExecution.integration.test.ts вместе с интеграционными тестами plan_execution.
// Тест 5 ("/mode персистится") уже покрыт config.test.ts ("partial config: mode: yolo") +
// replCommands.test.ts ("/mode plan|yolo переключает режим в конфиге") — дублировать нечего,
// механизм персистенции общий для любого поля конфига, не специфичен для plan mode.
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
} from './planMode.ts';

const VALID_PLAN_TEXT = [
  '[PLAN]',
  'STEP 1 | coder1 | Написать модуль | FILES: src/a.ts | DEPENDS: none',
  '[/PLAN]',
].join('\n');

test('idle (до старта первой задачи): не блокирует — нет задачи, нечего гейтить', () => {
  assert.equal(isBlockedByGate(IDLE_GATE), false);
});

test('yolo: startTask пропускает гейт целиком, задача сразу approved (индикатор режима — TUI, статус тут)', () => {
  const gate = startTask('t1', Date.now(), 'yolo');
  assert.equal(gate.status, 'yolo');
  assert.equal(isApproved(gate), true);
  assert.equal(isBlockedByGate(gate), false);
});

test('plan mode: startTask ждёт план, ничего не approved до получения и подтверждения', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  assert.equal(gate.status, 'awaiting_plan');
  assert.equal(isApproved(gate), false);
  assert.equal(isBlockedByGate(gate), true);
});

test('валидный [PLAN] переводит гейт в plan_ready, ждёт подтверждения пользователя', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: next, outcome } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  assert.equal(outcome.kind, 'ready');
  assert.equal(next.status, 'plan_ready');
  assert.equal(isApproved(next), false); // Enter ещё не нажат
});

test('[Enter]: approvePlan переводит plan_ready -> approved', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: ready } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  const approved = approvePlan(ready);
  assert.equal(approved.status, 'approved');
  assert.equal(isApproved(approved), true);
});

test('[Esc]: cancelPlan сбрасывает гейт к idle', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const { gate: ready } = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']);
  assert.deepEqual(cancelPlan(), IDLE_GATE);
  void ready;
});

test('невалидный формат плана (1-я, 2-я попытка) -> retry с примером формата, гейт остаётся awaiting_plan', () => {
  let gate = startTask('t1', Date.now(), 'plan');
  const first = receivePlanText(gate, 'это не план', ['coder1']);
  assert.equal(first.outcome.kind, 'retry');
  if (first.outcome.kind === 'retry') assert.match(first.outcome.message, /\[PLAN\]/);
  assert.equal(first.gate.status, 'awaiting_plan');
  gate = first.gate;

  const second = receivePlanText(gate, 'снова не план', ['coder1']);
  assert.equal(second.outcome.kind, 'retry');
  assert.equal(second.gate.status, 'awaiting_plan');
});

test('невалидный формат плана — 3-я неудача -> show_raw, сырой текст сохранён для показа пользователю', () => {
  let gate = startTask('t1', Date.now(), 'plan');
  gate = receivePlanText(gate, 'не план 1', ['coder1']).gate;
  gate = receivePlanText(gate, 'не план 2', ['coder1']).gate;
  const third = receivePlanText(gate, 'не план 3', ['coder1']);
  assert.equal(third.outcome.kind, 'show_raw');
  if (third.outcome.kind === 'show_raw') assert.equal(third.outcome.rawText, 'не план 3');
});

// Задача A.6: невалидный план (несуществующий агент, цикл) возвращается оркестратору ДО показа
// пользователю — тот же путь, что отступление по формату (retry), не отдельная ветка.
test('план с несуществующим agent_id -> retry, не показывается пользователю как plan_ready', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const badAgentPlan = ['[PLAN]', 'STEP 1 | ghost5 | x | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n');
  const { gate: next, outcome } = receivePlanText(gate, badAgentPlan, ['coder1']);
  assert.equal(outcome.kind, 'retry');
  assert.equal(next.status, 'awaiting_plan');
});

test('таймаут 120с: гейт всё ещё awaiting_plan -> timed_out; раньше срока -> не трогает', () => {
  const start = 1_000_000;
  const gate = startTask('t1', start, 'plan');

  const early = checkTimeout(gate, start + PLAN_TIMEOUT_MS - 1);
  assert.equal(early.status, 'awaiting_plan');

  const late = checkTimeout(gate, start + PLAN_TIMEOUT_MS);
  assert.equal(late.status, 'timed_out');
});

test('таймаут не трогает гейт вне awaiting_plan (уже approved/yolo)', () => {
  const gate = startTask('t1', 0, 'yolo');
  const result = checkTimeout(gate, PLAN_TIMEOUT_MS * 10);
  assert.equal(result.status, 'yolo');
});

test('правка в $EDITOR: валидный markdown -> approved напрямую, PLAN_REVISED уходит оркестратору с текстом редактора', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;

  const editedText = ['[PLAN]', 'STEP 1 | coder1 | Другое описание | FILES: src/a.ts | DEPENDS: none', '[/PLAN]'].join('\n');
  const outcome = revisePlan(ready, editedText, ['coder1']);
  assert.ok('toOrchestrator' in outcome);
  if (!('toOrchestrator' in outcome)) return;
  assert.equal(outcome.gate.status, 'approved');
  assert.equal(outcome.toOrchestrator.type, 'PLAN_REVISED');
  assert.equal(outcome.toOrchestrator.payload, editedText);
  assert.equal(outcome.gate.plan?.steps[0].description, 'Другое описание');
});

test('planToEditableText: round-trip через parsePlanText/validatePlan — то, что откроется в $EDITOR, снова парсится без потерь', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;
  const text = planToEditableText(ready.plan!);
  const outcome = revisePlan(ready, text, ['coder1']);
  assert.ok('toOrchestrator' in outcome);
  if ('toOrchestrator' in outcome) assert.deepEqual(outcome.gate.plan, ready.plan);
});

test('правка в $EDITOR: невалидный markdown -> error, гейт не продвигается', () => {
  const gate = startTask('t1', Date.now(), 'plan');
  const ready = receivePlanText(gate, VALID_PLAN_TEXT, ['coder1']).gate;

  const outcome = revisePlan(ready, 'сломанный markdown', ['coder1']);
  assert.ok('error' in outcome);
  if (!('error' in outcome)) return;
  assert.equal(outcome.gate.status, 'plan_ready');
});
