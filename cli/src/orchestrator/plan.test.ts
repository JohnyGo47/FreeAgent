import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanText, validatePlan, planRetryOutcome, buildPlanRetryMessage } from './plan.ts';

const VALID_PLAN = [
  '[PLAN]',
  'STEP 1 | researcher1 | Найти лучшие практики JWT-авторизации | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Написать middleware авторизации | FILES: src/auth.ts, src/auth.test.ts | DEPENDS: 1',
  'STEP 3 | coder2 | Написать модель пользователя | FILES: src/user.ts, src/user.test.ts | DEPENDS: none',
  'STEP 4 | coder1 | Интегрировать auth и user в роутер | FILES: src/router.ts | DEPENDS: 2, 3',
  '[/PLAN]',
].join('\n');

test('a valid [PLAN] block parses into a PlanPayload with all steps', () => {
  const result = parsePlanText(VALID_PLAN);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.steps.length, 4);
    assert.deepEqual(result.plan.steps[1], {
      step_id: 2,
      agent_id: 'coder1',
      description: 'Написать middleware авторизации',
      files: ['src/auth.ts', 'src/auth.test.ts'],
      depends_on: [1],
    });
    assert.deepEqual(result.plan.steps[0].depends_on, []);
    assert.deepEqual(result.plan.steps[3].depends_on, [2, 3]);
  }
});

test('malformed plan text fails to parse', () => {
  const result = parsePlanText('[PLAN]\nthis is not a step line\n[/PLAN]');
  assert.equal(result.ok, false);
});

test('planRetryOutcome: first and second failed attempts retry, third gives up and shows raw text', () => {
  assert.equal(planRetryOutcome(1), 'RETRY');
  assert.equal(planRetryOutcome(2), 'RETRY');
  assert.equal(planRetryOutcome(3), 'SHOW_RAW_TO_USER');
});

test('buildPlanRetryMessage gives a concrete example of the format', () => {
  const msg = buildPlanRetryMessage();
  assert.match(msg, /\[PLAN\]/);
  assert.match(msg, /STEP 1 \|/);
});

test('a dependency cycle is rejected before the plan reaches the user', () => {
  const cyclic = parsePlanText(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: a.ts | DEPENDS: 2', 'STEP 2 | coder1 | b | FILES: b.ts | DEPENDS: 1', '[/PLAN]'].join('\n'),
  );
  assert.equal(cyclic.ok, true);
  if (!cyclic.ok) return;
  const result = validatePlan(cyclic.plan, ['coder1']);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /cycle/i);
});

// ARCHITECTURE §10: "Пересечение → последовательное исполнение", не отказ. Роль-текст
// spec_md_orchestrator раньше говорил строже ("два шага не могут трогать один файл") — приведён
// к архитектуре в ревизии PR-8. validatePlan больше не отклоняет план из-за пересечения files;
// это сигнал расписания для spec_plan_execution (последовательный запуск), не ошибка валидации.
test('two steps claiming the same file pass validation — overlap is a scheduling signal, not a validation error', () => {
  const overlap = parsePlanText(
    ['[PLAN]', 'STEP 1 | coder1 | a | FILES: shared.ts | DEPENDS: none', 'STEP 2 | coder2 | b | FILES: shared.ts | DEPENDS: none', '[/PLAN]'].join(
      '\n',
    ),
  );
  assert.equal(overlap.ok, true);
  if (!overlap.ok) return;
  const result = validatePlan(overlap.plan, ['coder1', 'coder2']);
  assert.equal(result.ok, true);
});

test('an unknown agent_id is rejected with the list of valid agents', () => {
  const parsed = parsePlanText(['[PLAN]', 'STEP 1 | ghost5 | a | FILES: a.ts | DEPENDS: none', '[/PLAN]'].join('\n'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const result = validatePlan(parsed.plan, ['coder1', 'coder2']);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /ghost5/);
    assert.match(result.error, /coder1/);
  }
});

test('a valid plan (no cycles, no file overlap, known agents) passes validation', () => {
  const parsed = parsePlanText(VALID_PLAN);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const result = validatePlan(parsed.plan, ['researcher1', 'coder1', 'coder2']);
  assert.equal(result.ok, true);
});
