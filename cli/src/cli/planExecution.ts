// The approved plan is executed mechanically by the CLI (spec_plan_execution, ARCHITECTURE §8/§10).
// The orchestrator wakes up only on exceptions: RESULT: FAILED, self-esteem below threshold, WRITE
// outside the files step, agent FAILED after attempts, plan exhausted. All functions here are pure - I/O
// (TASK routing via router.ts with its buffering of transition statuses, FS entry,
// saving state) does mainLoop.ts.
import { randomUUID } from 'node:crypto';
import type { BusMessage, NotifyPayload, PlanPayload, PlanStep, ResultPayload, StatusPayload, TaskPayload, TestsReadyPayload } from '../../../shared/bus-types/index.ts';
import { verifyStep, type VerifyParams, type VerifyVerdict } from './verification.ts';

export type StepStatus = 'pending' | 'sent' | 'done' | 'failed';

export interface PlanExecutionState {
  plan: PlanPayload;
  stepStatus: Record<number, StepStatus>;
  taskIds: Record<number, string>; // step_id -> task_id of the sent TASK, to match RESULT
  testsReadyCommands: Record<number, string>; // step_id -> command from TESTS_READY (task A.3/A.7)
  writtenFiles: Record<number, string[]>; // step_id -> files actually written during this step (FS_CALL write/edit)
  unverifiedSteps: Set<number>; // steps closed without TESTS_READY (task A.4) - visible to the user
  stopped: boolean; // /stop (task B.13): current tasks are being finalized, new ones are not leaving
  lastStatus: Record<string, StatusPayload['state']>; // dedup STATUS by agent_id
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

// Intersection of files among ready ones → sequentially; disjoint → parallel
// (ARCHITECTURE §10). Greedy by order of steps in the plan: file occupied by already 'sent' step or more
// an early step of the same round, blocks a later one - it remains 'pending' and leaves
// next round, when the file is free (RESULT by owner).
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

// TESTS_READY {task_id, command} - CLI simply remembers the command against the step; the launch itself
// deferred until RESULT: DONE (applyResult below), where it decides whether the step is closed
// (spec_plan_execution contract clause 5, spec_verification step protocol).
export function recordTestsReady(state: PlanExecutionState, msg: BusMessage): PlanExecutionState {
  if (msg.type !== 'TESTS_READY') return state;
  const payload = msg.payload as TestsReadyPayload;
  const step = stepForTaskId(state, payload.task_id);
  if (!step) return state;
  return { ...state, testsReadyCommands: { ...state.testsReadyCommands, [step.step_id]: payload.command } };
}

// File actually written by CLI (successful FS_CALL write/edit) within the current 'sent' step
// agent - source for verification check "the file is still on disk" (task A.3) and,
// separately, for git_checkpoints (not from here - mainLoop uses step.files directly there).
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

// RESULT: DONE/FAILED from the agent executing the current step. selfAssessmentThreshold —
// config.self_assessment_threshold; verifyCtx - environment for verification (task A.7): real
// running tests instead of taking DONE's word for it. Failure order: obvious FAILED -> lower self-esteem
// threshold -> verification (white list/exit code/timeout/file missing/unverified).
export interface ApplyResultOutcome {
  state: PlanExecutionState;
  event: ExecutionEvent;
  unverified?: boolean;
  step?: PlanStep; // step this RESULT belonged to - mainLoop uses for checkpoint (files/summary)
}

export async function applyResult(
  state: PlanExecutionState,
  msg: BusMessage,
  selfAssessmentThreshold: number,
  verifyCtx: VerifyContext,
): Promise<ApplyResultOutcome> {
  const payload = msg.payload as ResultPayload;
  const step = stepForTaskId(state, payload.task_id);
  if (!step) return { state, event: { kind: 'progress' } }; // RESULT is not about this plan - ignore

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

// WRITE outside the declared files (pathGuard returned FILE_NOT_OWNED) - also a reason for escalation
// (spec_plan_execution "When we wake up the orchestrator"), not only a silent ERROR to the agent.
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

// Nothing can progress further, but the plan is not complete - usually a consequence of a FAILED step whose
// dependents will never open (spec_plan_execution "plan exhausted").
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

// files of the current (status: 'sent') agent step - source for pathGuard level-3
// (spec_write_path_validation §3, task C.14). null: the agent is not participating in the plan, or has
// there is no active step now - level-3 is skipped, as if there is no plan.
export function currentStepFilesForAgent(state: PlanExecutionState, agentId: string): string[] | null {
  const step = state.plan.steps.find((s) => s.agent_id === agentId && state.stepStatus[s.step_id] === 'sent');
  return step ? step.files : null;
}

// task_id of the current (status: 'sent') agent step - source for git_checkpoints (task B.8):
// "the first WRITE within task_id" requires this particular task_id, not step_id.
export function currentTaskIdForAgent(state: PlanExecutionState, agentId: string): string | null {
  const step = state.plan.steps.find((s) => s.agent_id === agentId && state.stepStatus[s.step_id] === 'sent');
  return step ? (state.taskIds[step.step_id] ?? null) : null;
}

// Dedup STATUS (ARCHITECTURE §8): the agent's state is fixed, but during mechanical
// plan execution routine WORKING/IDLE transition is NOT a reason to wake up the orchestrator (escalation only
// by exception - see applyResult/applyOwnershipViolation above) - toOrchestrator here
// intentionally always undefined, dedup reduces any STATUS sequence to zero messages.
export function dedupeStatus(state: PlanExecutionState, msg: BusMessage): { state: PlanExecutionState; toOrchestrator?: BusMessage } {
  if (msg.type !== 'STATUS') return { state };
  const payload = msg.payload as StatusPayload;
  const lastStatus = { ...state.lastStatus, [msg.from]: payload.state };
  return { state: { ...state, lastStatus } };
}

export function stopExecution(state: PlanExecutionState): PlanExecutionState {
  return { ...state, stopped: true };
}
