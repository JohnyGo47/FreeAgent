// Парсинг/валидация [PLAN] (spec_md_orchestrator). Формат намеренно текстовый, pipe-separated —
// не JSON/YAML, бесплатные модели надёжнее генерируют его. Парсер живёт в CLI, как parseFsCall.
import type { PlanPayload, PlanStep } from '../../../shared/bus-types/index.ts';

const PLAN_RE = /\[PLAN\]([\s\S]*?)\[\/PLAN\]/;
const STEP_LINE_RE = /^STEP\s+(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*FILES:\s*([^|]*?)\s*\|\s*DEPENDS:\s*(.+)$/i;

export type ParsePlanResult = { ok: true; plan: PlanPayload } | { ok: false; error: string };

export function parsePlanText(text: string): ParsePlanResult {
  const match = PLAN_RE.exec(text);
  if (!match) return { ok: false, error: 'no [PLAN]...[/PLAN] block found' };

  const lines = match[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: 'empty plan' };

  const steps: PlanStep[] = [];
  for (const line of lines) {
    const m = STEP_LINE_RE.exec(line);
    if (!m) return { ok: false, error: `malformed step line: ${line}` };
    const [, stepId, agentId, description, filesRaw, dependsRaw] = m;
    const files = filesRaw
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const dependsTrim = dependsRaw.trim();
    const depends_on = /^none$/i.test(dependsTrim)
      ? []
      : dependsTrim
          .split(',')
          .map((d) => Number(d.trim()))
          .filter((n) => !Number.isNaN(n));
    steps.push({ step_id: Number(stepId), agent_id: agentId, description, files, depends_on });
  }

  return { ok: true, plan: { steps } };
}

export type ValidatePlanResult = { ok: true } | { ok: false; error: string };

export function validatePlan(plan: PlanPayload, validAgentIds: string[]): ValidatePlanResult {
  const validSet = new Set(validAgentIds);
  for (const step of plan.steps) {
    if (!validSet.has(step.agent_id)) {
      return { ok: false, error: `unknown agent_id: ${step.agent_id} (valid: ${validAgentIds.join(', ')})` };
    }
  }

  const fileOwner = new Map<string, number>();
  for (const step of plan.steps) {
    for (const file of step.files) {
      const owner = fileOwner.get(file);
      if (owner !== undefined && owner !== step.step_id) {
        return { ok: false, error: `file conflict: ${file} claimed by steps ${owner} and ${step.step_id}` };
      }
      fileOwner.set(file, step.step_id);
    }
  }

  const byId = new Map(plan.steps.map((s) => [s.step_id, s]));
  const state = new Map<number, 'visiting' | 'done'>();

  function findCycle(id: number, path: number[]): number[] | null {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...path, id];
    state.set(id, 'visiting');
    const step = byId.get(id);
    if (step) {
      for (const dep of step.depends_on) {
        const cycle = findCycle(dep, [...path, id]);
        if (cycle) return cycle;
      }
    }
    state.set(id, 'done');
    return null;
  }

  for (const step of plan.steps) {
    const cycle = findCycle(step.step_id, []);
    if (cycle) return { ok: false, error: `dependency cycle: ${cycle.join(' -> ')}` };
  }

  return { ok: true };
}

// "План Б" — три попытки: 1-я и 2-я неудача парсинга → отправить оркестратору на переписывание,
// 3-я → сдаться и показать сырой текст пользователю (spec_md_orchestrator "Парсинг плана").
export type PlanAttemptOutcome = 'RETRY' | 'SHOW_RAW_TO_USER';

export function planRetryOutcome(failedAttemptNumber: number): PlanAttemptOutcome {
  return failedAttemptNumber < 3 ? 'RETRY' : 'SHOW_RAW_TO_USER';
}

const PLAN_EXAMPLE = [
  '[PLAN]',
  'STEP 1 | researcher1 | Найти лучшие практики JWT-авторизации | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Написать middleware авторизации | FILES: src/auth.ts, src/auth.test.ts | DEPENDS: 1',
  '[/PLAN]',
].join('\n');

export function buildPlanRetryMessage(): string {
  return `Перепиши план строго по формату. Вот пример:\n${PLAN_EXAMPLE}`;
}
