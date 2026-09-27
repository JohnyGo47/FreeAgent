// Parsing/validation [PLAN] (spec_md_orchestrator). The format is intentionally text-based, pipe-separated -
// not JSON/YAML, free models generate it more reliably. The parser lives in the CLI, like parseFsCall.
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

  // ARCHITECTURE §10: intersection of files between steps - schedule signal (sequential
  // execution in plan_execution), not a validation error. Role-text spec_md_orchestrator before
  // required stricter (“two steps cannot touch the same file”); brought to the architecture in PR-8.

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

// "Plan B" - three attempts: 1st and 2nd parsing failure → send to orchestrator for rewriting,
// 3rd → give up and show the raw text to the user (spec_md_orchestrator "Plan Parsing").
export type PlanAttemptOutcome = 'RETRY' | 'SHOW_RAW_TO_USER';

export function planRetryOutcome(failedAttemptNumber: number): PlanAttemptOutcome {
  return failedAttemptNumber < 3 ? 'RETRY' : 'SHOW_RAW_TO_USER';
}

const PLAN_EXAMPLE = [
  '[PLAN]',
  'STEP 1 | researcher1 | Find JWT authorization best practices | FILES: research/jwt.md | DEPENDS: none',
  'STEP 2 | coder1 | Write authorization middleware | FILES: src/auth.ts, src/auth.test.ts | DEPENDS: 1',
  '[/PLAN]',
].join('\n');

export function buildPlanRetryMessage(): string {
  return `Rewrite the plan strictly according to the format. Here's an example:\n${PLAN_EXAMPLE}`;
}
