// Утверждённый план исполняется CLI механически (spec_plan_execution, ARCHITECTURE §8/§10).
// Оркестратор просыпается только на исключениях: RESULT: FAILED, самооценка ниже порога, WRITE
// вне files шага, агент FAILED после попыток, план исчерпан. Все функции здесь чистые — I/O
// (маршрутизация TASK через router.ts с его буферизацией переходных статусов, запись FS,
// сохранение состояния) делает mainLoop.ts.
import { randomUUID } from 'node:crypto';
import type { BusMessage, NotifyPayload, PlanPayload, PlanStep, ResultPayload, StatusPayload, TaskPayload, TestsReadyPayload } from '../../../shared/bus-types/index.ts';
import { verifyStep, type VerifyParams, type VerifyVerdict } from './verification.ts';

export type StepStatus = 'pending' | 'sent' | 'done' | 'failed';

export interface PlanExecutionState {
  plan: PlanPayload;
  stepStatus: Record<number, StepStatus>;
  taskIds: Record<number, string>; // step_id -> task_id отправленной TASK, для сопоставления RESULT
  testsReadyCommands: Record<number, string>; // step_id -> command из TESTS_READY (задача A.3/A.7)
  writtenFiles: Record<number, string[]>; // step_id -> файлы, реально записанные за этот шаг (FS_CALL write/edit)
  unverifiedSteps: Set<number>; // шаги, закрытые без TESTS_READY (задача A.4) — видимо пользователю
  stopped: boolean; // /stop (задача B.13): текущие задачи дорабатывают, новые не уходят
  lastStatus: Record<string, StatusPayload['state']>; // дедуп STATUS по agent_id
}

export function startExecution(plan: PlanPayload): PlanExecutionState {
  const stepStatus: Record<number, StepStatus> = {};
  for (const step of plan.steps) stepStatus[step.step_id] = 'pending';
  return { plan, stepStatus, taskIds: {}, testsReadyCommands: {}, writtenFiles: {}, unverifiedSteps: new Set(), stopped: false, lastStatus: {} };
}

function readySteps(state: PlanExecutionState): PlanStep[] {
  return state.plan.steps.filter(
    (s) => state.stepStatus[s.step_id] === 'pending' && s.depends_on.every((d) => state.stepStatus[d] === 'done'),
  );
}

// Пересечение files среди готовых → последовательно; непересекающиеся → параллельно
// (ARCHITECTURE §10). Жадно по порядку шагов в плане: файл, занятый уже 'sent' шагом или более
// ранним шагом этого же раунда, блокирует более поздний — тот остаётся 'pending' и уйдёт
// следующим раундом, когда файл освободится (RESULT по владельцу).
function sendableSteps(state: PlanExecutionState): PlanStep[] {
  const claimed = new Set<string>();
  for (const step of state.plan.steps) {
    if (state.stepStatus[step.step_id] === 'sent') for (const f of step.files) claimed.add(f);
  }
  const toSend: PlanStep[] = [];
  for (const step of readySteps(state)) {
    if (step.files.some((f) => claimed.has(f))) continue;
    toSend.push(step);
    for (const f of step.files) claimed.add(f);
  }
  return toSend;
}

export function nextTasks(state: PlanExecutionState): { state: PlanExecutionState; tasks: BusMessage[] } {
  if (state.stopped) return { state, tasks: [] };
  const toSend = sendableSteps(state);
  if (toSend.length === 0) return { state, tasks: [] };

  const stepStatus = { ...state.stepStatus };
  const taskIds = { ...state.taskIds };
  const tasks: BusMessage[] = [];
  const now = new Date().toISOString();
  for (const step of toSend) {
    const task_id = randomUUID();
    stepStatus[step.step_id] = 'sent';
    taskIds[step.step_id] = task_id;
    const payload: TaskPayload = { task_id, description: step.description, files: step.files };
    tasks.push({ id: randomUUID(), from: 'cli', to: step.agent_id, type: 'TASK', ts: now, payload });
  }
  return { state: { ...state, stepStatus, taskIds }, tasks };
}

export type ExecutionEvent = { kind: 'progress' } | { kind: 'complete' } | { kind: 'escalate'; reason: string };

function stepForTaskId(state: PlanExecutionState, taskId: string): PlanStep | undefined {
  const stepId = Object.entries(state.taskIds).find(([, id]) => id === taskId)?.[0];
  return stepId === undefined ? undefined : state.plan.steps.find((s) => s.step_id === Number(stepId));
}

function completionEvent(state: PlanExecutionState): ExecutionEvent {
  const allDone = state.plan.steps.every((s) => state.stepStatus[s.step_id] === 'done');
  return allDone ? { kind: 'complete' } : { kind: 'progress' };
}

// TESTS_READY {task_id, command} — CLI просто запоминает команду против шага; сам запуск
// откладывается до RESULT: DONE (applyResult ниже), где и решает, закрыт ли шаг
// (spec_plan_execution контракт п.5, spec_verification протокол шага).
export function recordTestsReady(state: PlanExecutionState, msg: BusMessage): PlanExecutionState {
  if (msg.type !== 'TESTS_READY') return state;
  const payload = msg.payload as TestsReadyPayload;
  const step = stepForTaskId(state, payload.task_id);
  if (!step) return state;
  return { ...state, testsReadyCommands: { ...state.testsReadyCommands, [step.step_id]: payload.command } };
}

// Файл, реально записанный CLI (успешный FS_CALL write/edit) в рамках текущего 'sent' шага
// агента — источник для verification'ой проверки "файл всё ещё на диске" (задача A.3) и,
// отдельно, для git_checkpoints (не отсюда — mainLoop использует step.files напрямую там).
export function recordWrittenFile(state: PlanExecutionState, agentId: string, path: string): PlanExecutionState {
  const step = state.plan.steps.find((s) => s.agent_id === agentId && state.stepStatus[s.step_id] === 'sent');
  if (!step) return state;
  const existing = state.writtenFiles[step.step_id] ?? [];
  if (existing.includes(path)) return state;
  return { ...state, writtenFiles: { ...state.writtenFiles, [step.step_id]: [...existing, path] } };
}

export interface VerifyContext {
  cwd: string;
  timeoutMs: number;
  logsDir: string;
  verifyFn?: (params: VerifyParams) => Promise<VerifyVerdict>;
}

// RESULT: DONE/FAILED от агента, исполняющего текущий шаг. selfAssessmentThreshold —
// config.self_assessment_threshold; verifyCtx — окружение для verification (задача A.7): реальный
// прогон тестов вместо доверия DONE на слово. Порядок отказов: явный FAILED -> самооценка ниже
// порога -> verification (белый список/exit code/таймаут/файл пропал/unverified).
export interface ApplyResultOutcome {
  state: PlanExecutionState;
  event: ExecutionEvent;
  unverified?: boolean;
  step?: PlanStep; // шаг, к которому относился этот RESULT — mainLoop использует для checkpoint (files/summary)
}

export async function applyResult(
  state: PlanExecutionState,
  msg: BusMessage,
  selfAssessmentThreshold: number,
  verifyCtx: VerifyContext,
): Promise<ApplyResultOutcome> {
  const payload = msg.payload as ResultPayload;
  const step = stepForTaskId(state, payload.task_id);
  if (!step) return { state, event: { kind: 'progress' } }; // RESULT не про этот план — игнор

  if (payload.status === 'FAILED') {
    const stepStatus = { ...state.stepStatus, [step.step_id]: 'failed' as StepStatus };
    return {
      state: { ...state, stepStatus },
      event: { kind: 'escalate', reason: `step ${step.step_id} (${step.agent_id}) FAILED: ${payload.summary}` },
      step,
    };
  }

  if (payload.self_assessment && payload.self_assessment.percent < selfAssessmentThreshold) {
    const stepStatus = { ...state.stepStatus, [step.step_id]: 'failed' as StepStatus };
    return {
      state: { ...state, stepStatus },
      event: {
        kind: 'escalate',
        reason: `step ${step.step_id} (${step.agent_id}) self-assessment ${payload.self_assessment.percent}% < ${selfAssessmentThreshold}%: ${payload.self_assessment.reasoning}`,
      },
      step,
    };
  }

  const verify = verifyCtx.verifyFn ?? verifyStep;
  const verdict = await verify({
    taskId: payload.task_id,
    command: state.testsReadyCommands[step.step_id],
    cwd: verifyCtx.cwd,
    timeoutMs: verifyCtx.timeoutMs,
    logsDir: verifyCtx.logsDir,
    writtenFiles: state.writtenFiles[step.step_id],
  });

  if (verdict.kind === 'failed' || verdict.kind === 'rejected') {
    const stepStatus = { ...state.stepStatus, [step.step_id]: 'failed' as StepStatus };
    return {
      state: { ...state, stepStatus },
      event: { kind: 'escalate', reason: `step ${step.step_id} (${step.agent_id}) verification failed: ${verdict.reason}` },
      step,
    };
  }

  const unverifiedSteps = verdict.kind === 'unverified' ? new Set(state.unverifiedSteps).add(step.step_id) : state.unverifiedSteps;
  const stepStatus = { ...state.stepStatus, [step.step_id]: 'done' as StepStatus };
  const newState = { ...state, stepStatus, unverifiedSteps };
  return { state: newState, event: completionEvent(newState), unverified: verdict.kind === 'unverified', step };
}

// WRITE вне заявленных files (pathGuard вернул FILE_NOT_OWNED) — тоже повод эскалации
// (spec_plan_execution "Когда будим оркестратора"), не только молчаливый ERROR агенту.
export function applyOwnershipViolation(state: PlanExecutionState, agentId: string, attemptedPath: string): { state: PlanExecutionState; event: ExecutionEvent } {
  const entry = Object.entries(state.stepStatus).find(([id, status]) => status === 'sent' && state.plan.steps.find((s) => s.step_id === Number(id))?.agent_id === agentId);
  if (!entry) return { state, event: { kind: 'progress' } };
  const stepId = Number(entry[0]);
  const stepStatus = { ...state.stepStatus, [stepId]: 'failed' as StepStatus };
  return {
    state: { ...state, stepStatus },
    event: { kind: 'escalate', reason: `step ${stepId} (${agentId}) wrote outside its files: ${attemptedPath}` },
  };
}

// Ничего не может продвинуться дальше, но план не завершён — обычно следствие FAILED-шага, чьи
// зависимые никогда не откроются (spec_plan_execution "план исчерпан").
export function isExhausted(state: PlanExecutionState): boolean {
  if (isComplete(state)) return false;
  const anyInFlight = state.plan.steps.some((s) => state.stepStatus[s.step_id] === 'sent');
  if (anyInFlight) return false;
  return sendableSteps(state).length === 0;
}

export function isComplete(state: PlanExecutionState): boolean {
  return state.plan.steps.every((s) => state.stepStatus[s.step_id] === 'done');
}

export function planCompleteNotify(): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_COMPLETE' };
  return { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

export function escalationNotify(reason: string): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_ESCALATION', details: reason };
  return { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

// files текущего (status: 'sent') шага агента — источник для pathGuard уровень-3
// (spec_write_path_validation §3, задача C.14). null: агент не участвует в плане, или у него
// сейчас нет активного шага — уровень-3 пропускается, как при отсутствии плана.
export function currentStepFilesForAgent(state: PlanExecutionState, agentId: string): string[] | null {
  const step = state.plan.steps.find((s) => s.agent_id === agentId && state.stepStatus[s.step_id] === 'sent');
  return step ? step.files : null;
}

// task_id текущего (status: 'sent') шага агента — источник для git_checkpoints (задача B.8):
// "первый WRITE в рамках task_id" нужен именно этот task_id, не step_id.
export function currentTaskIdForAgent(state: PlanExecutionState, agentId: string): string | null {
  const step = state.plan.steps.find((s) => s.agent_id === agentId && state.stepStatus[s.step_id] === 'sent');
  return step ? (state.taskIds[step.step_id] ?? null) : null;
}

// Дедуп STATUS (ARCHITECTURE §8): состояние агента фиксируется, но во время механического
// исполнения плана рутинный WORKING/IDLE переход НЕ повод будить оркестратора (эскалация только
// по исключениям — см. applyResult/applyOwnershipViolation выше) — toOrchestrator здесь
// намеренно всегда undefined, дедуп сводит любую последовательность STATUS к нулю сообщений.
export function dedupeStatus(state: PlanExecutionState, msg: BusMessage): { state: PlanExecutionState; toOrchestrator?: BusMessage } {
  if (msg.type !== 'STATUS') return { state };
  const payload = msg.payload as StatusPayload;
  const lastStatus = { ...state.lastStatus, [msg.from]: payload.state };
  return { state: { ...state, lastStatus } };
}

export function stopExecution(state: PlanExecutionState): PlanExecutionState {
  return { ...state, stopped: true };
}
