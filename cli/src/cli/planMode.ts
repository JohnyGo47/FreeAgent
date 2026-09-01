// Plan mode — default, enforcement на стороне CLI, не на дисциплине модели (spec_cli_plan_mode,
// ARCHITECTURE §8/§10). Гейт живёт на одну текущую задачу: пока не approved, ни TASK от
// оркестратора агенту, ни WRITE/EDIT от любого агента не проходят — mainLoop.ts блокирует их
// сам (isBlockedByGate), опираясь на этот модуль только за состоянием.
import { randomUUID } from 'node:crypto';
import type { BusMessage, CommandPayload, NotifyPayload, PlanPayload } from '../../../shared/bus-types/index.ts';
import { parsePlanText, validatePlan, planRetryOutcome, buildPlanRetryMessage } from '../orchestrator/plan.ts';

export const PLAN_TIMEOUT_MS = 120_000;

export type PlanGateStatus = 'idle' | 'awaiting_plan' | 'plan_ready' | 'approved' | 'yolo' | 'timed_out';

export interface PlanGate {
  status: PlanGateStatus;
  taskId?: string;
  requestedAt?: number;
  plan?: PlanPayload;
  attempts: number;
  rawText?: string; // последний сырой ответ оркестратора — для показа при отступлении/таймауте
}

export const IDLE_GATE: PlanGate = { status: 'idle', attempts: 0 };

// Новая задача от пользователя (/do, /btw) — старт гейта. Yolo пропускает его целиком: агенты
// получают TASK сразу, индикатор режима в statusbar это отражает (spec constraint "yolo → TASK
// сразу + индикатор").
export function startTask(taskId: string, now: number, mode: 'plan' | 'yolo'): PlanGate {
  if (mode === 'yolo') return { status: 'yolo', taskId, attempts: 0 };
  return { status: 'awaiting_plan', taskId, requestedAt: now, attempts: 0 };
}

export function isApproved(gate: PlanGate): boolean {
  return gate.status === 'approved' || gate.status === 'yolo';
}

// Любой TASK от оркестратора агенту или WRITE/EDIT от агента, пока не approved — заблокировать
// (COMMAND: PAUSE + уведомление, собирается в mainLoop.ts). 'idle' намеренно НЕ блокирует: до
// старта первой задачи гейт ничего не гейтит (нет задачи — нечего защищать); блокируют только
// фазы реально начатой, но ещё не approved задачи.
export function isBlockedByGate(gate: PlanGate): boolean {
  return gate.status === 'awaiting_plan' || gate.status === 'plan_ready' || gate.status === 'timed_out';
}

export function checkTimeout(gate: PlanGate, now: number, timeoutMs: number = PLAN_TIMEOUT_MS): PlanGate {
  if (gate.status !== 'awaiting_plan' || gate.requestedAt === undefined) return gate;
  if (now - gate.requestedAt < timeoutMs) return gate;
  return { ...gate, status: 'timed_out' };
}

export type PlanIntakeOutcome =
  | { kind: 'ignored' } // PLAN пришёл не в фазе ожидания — поздний/дублирующий ответ
  | { kind: 'retry'; message: string } // отступление 1-2 (spec_md_orchestrator "План Б")
  | { kind: 'show_raw'; rawText: string } // отступление 3 — сдаться, показать сырой текст
  | { kind: 'ready'; plan: PlanPayload };

// Разбор + валидация ответа оркестратора на [PLAN]. Общая точка с plan_execution (задача B.8) —
// обе используют validatePlan из orchestrator/plan.ts, не дублируют проверку.
export function receivePlanText(gate: PlanGate, rawText: string, validAgentIds: string[]): { gate: PlanGate; outcome: PlanIntakeOutcome } {
  if (gate.status !== 'awaiting_plan') return { gate, outcome: { kind: 'ignored' } };

  const parsed = parsePlanText(rawText);
  const validation = parsed.ok ? validatePlan(parsed.plan, validAgentIds) : null;
  const failed = !parsed.ok ? parsed.error : validation && !validation.ok ? validation.error : null;

  if (failed) {
    const attempts = gate.attempts + 1;
    const nextGate = { ...gate, attempts, rawText };
    if (planRetryOutcome(attempts) === 'RETRY') {
      return { gate: nextGate, outcome: { kind: 'retry', message: buildPlanRetryMessage() } };
    }
    return { gate: { ...nextGate, status: 'timed_out' }, outcome: { kind: 'show_raw', rawText } };
  }

  if (!parsed.ok) throw new Error('unreachable'); // failed above covers !parsed.ok
  return { gate: { ...gate, status: 'plan_ready', plan: parsed.plan }, outcome: { kind: 'ready', plan: parsed.plan } };
}

// [Enter] в TUI.
export function approvePlan(gate: PlanGate): PlanGate {
  if (gate.status !== 'plan_ready') return gate;
  return { ...gate, status: 'approved' };
}

// [Esc] в TUI — задача отменена целиком, гейт сброшен.
export function cancelPlan(): PlanGate {
  return { ...IDLE_GATE };
}

export type ReviseOutcome = { gate: PlanGate; toOrchestrator: BusMessage } | { gate: PlanGate; error: string };

// Сериализация плана обратно в тот же STEP-формат для $EDITOR — то, что пользователь правит,
// parsePlanText/revisePlan должны суметь прочитать без потерь (round-trip).
export function planToEditableText(plan: PlanPayload): string {
  const lines = plan.steps.map(
    (s) => `STEP ${s.step_id} | ${s.agent_id} | ${s.description} | FILES: ${s.files.join(', ')} | DEPENDS: ${s.depends_on.join(', ') || 'none'}`,
  );
  return ['[PLAN]', ...lines, '[/PLAN]'].join('\n');
}

// [e] в TUI: план правится как markdown (тот же STEP-формат) в $EDITOR. Отредактированный текст
// становится планом напрямую — повторный обход через оркестратора не нужен: план уже
// человеком проверен, гонять его туда-обратно только ради того, чтобы CLI могло его же и
// распарсить, стоило бы контекста оркестратора без механической пользы (ARCHITECTURE принцип 1).
// PLAN_REVISED всё равно уходит оркестратору — информационно, чтобы его собственный контекст не
// разошёлся с тем, что реально исполняется.
export function revisePlan(gate: PlanGate, editedText: string, validAgentIds: string[]): ReviseOutcome {
  const parsed = parsePlanText(editedText);
  if (!parsed.ok) return { gate, error: parsed.error };
  const validation = validatePlan(parsed.plan, validAgentIds);
  if (!validation.ok) return { gate, error: validation.error };

  return {
    gate: { ...gate, status: 'approved', plan: parsed.plan },
    toOrchestrator: {
      id: randomUUID(),
      from: 'cli',
      to: 'orchestrator',
      type: 'PLAN_REVISED',
      ts: new Date().toISOString(),
      payload: editedText,
    },
  };
}

// Enforcement на стороне CLI (constraint spec_cli_plan_mode): TASK от оркестратора агенту или
// WRITE/EDIT от агента, пока не approved, — агент ставится на паузу.
export function pauseCommand(agentId: string): BusMessage {
  const payload: CommandPayload = { command: 'PAUSE', agent_id: agentId };
  return { id: randomUUID(), from: 'cli', to: agentId, type: 'COMMAND', ts: new Date().toISOString(), payload };
}

// Уведомление пользователю (не оркестратору — это не решение для него, а факт нарушения
// протокола, дешёвая механическая правда, ARCHITECTURE §12) — to: 'cli', как responseHealth/
// backupAgents NOTIFY, видно через /log.
export function planViolationNotify(agentId: string, details: string): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_MODE_VIOLATION', agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

// Отступление 1-2 ("План Б", spec_md_orchestrator): переписать план строго по формату.
export function replanCommand(instructionText: string): BusMessage {
  const payload: CommandPayload = { command: 'REPLAN', args: { text: instructionText } };
  return { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'COMMAND', ts: new Date().toISOString(), payload };
}

// Отступление 3 и таймаут 120с — оба ведут к одному: показать пользователю сырой текст,
// предложить повтор (spec constraint). to: 'cli' — тот же self-NOTIFY принцип, что pauseCommand's
// уведомление.
export function planGiveUpNotify(rawText: string): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_TIMEOUT_OR_GIVEUP', details: rawText };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}
