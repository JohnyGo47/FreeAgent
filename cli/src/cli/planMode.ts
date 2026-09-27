// Plan mode - default, enforcement on the CLI side, not on the model discipline (spec_cli_plan_mode,
// ARCHITECTURE §8/§10). The gate lives on one current task: not yet approved, no TASK from
// the orchestrator does not pass to the agent, nor WRITE/EDIT from any agent - mainLoop.ts blocks them
// itself (isBlockedByGate), relying on this module only for the state.
import { randomUUID } from 'node:crypto';
import type { BusMessage, CommandPayload, NotifyPayload, PlanPayload } from '../../../shared/bus-types/index.ts';
import { parsePlanText, validatePlan, planRetryOutcome, buildPlanRetryMessage } from '../orchestrator/plan.ts';

export const PLAN_TIMEOUT_MS = 10 * 60_000;

export type PlanGateStatus = 'idle' | 'awaiting_plan' | 'plan_ready' | 'approved' | 'yolo' | 'timed_out';

export interface PlanGate {
  status: PlanGateStatus;
  taskId?: string;
  requestedAt?: number;
  plan?: PlanPayload;
  attempts: number;
  rawText?: string; // last raw response from the orchestrator - to be shown during retreat/timeout
}

export const IDLE_GATE: PlanGate = { status: 'idle', attempts: 0 };

// New task from the user (/do, /btw) - start the gate. Yolo skips it entirely: agents
// receive TASK immediately, the mode indicator in the statusbar reflects this (spec constraint "yolo → TASK
// immediately + indicator").
export function startTask(taskId: string, now: number, mode: 'plan' | 'yolo'): PlanGate {
  if (mode === 'yolo') return { status: 'yolo', taskId, attempts: 0 };
  return { status: 'awaiting_plan', taskId, requestedAt: now, attempts: 0 };
}

export function switchMode(gate: PlanGate, mode: 'plan' | 'yolo'): PlanGate {
  if (mode === 'yolo') return { status: 'yolo', taskId: gate.taskId, attempts: 0 };
  return gate.status === 'yolo' ? { ...IDLE_GATE } : gate;
}

export function isApproved(gate: PlanGate): boolean {
  return gate.status === 'approved' || gate.status === 'yolo';
}

// Any TASK from the orchestrator to the agent or WRITE/EDIT from the agent, not yet approved - block
// (COMMAND: PAUSE + notification, collected in mainLoop.ts). 'idle' intentionally does NOT block: before
// start of the first task, the gate does not gate anything (no task - nothing to protect); they only block
// phases of a task that has actually started, but has not yet been approved.
export function isBlockedByGate(gate: PlanGate): boolean {
  return gate.status === 'awaiting_plan' || gate.status === 'plan_ready' || gate.status === 'timed_out';
}

export function checkTimeout(gate: PlanGate, now: number, timeoutMs: number = PLAN_TIMEOUT_MS): PlanGate {
  if (gate.status !== 'awaiting_plan' || gate.requestedAt === undefined) return gate;
  if (now - gate.requestedAt < timeoutMs) return gate;
  return { ...gate, status: 'timed_out' };
}

export type PlanIntakeOutcome =
  | { kind: 'ignored' } // PLAN did not arrive in the waiting phase - late/duplicate response
  | { kind: 'retry'; message: string } // retreat 1-2 (spec_md_orchestrator "Plan B")
  | { kind: 'show_raw'; rawText: string } // retreat 3 - give up, show raw text
  | { kind: 'ready'; plan: PlanPayload };

// Parse + validate orchestrator response to [PLAN]. The common point with plan_execution (task B.8) is
// both use validatePlan from orchestrator/plan.ts, do not duplicate the check.
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

// [Enter] in TUI.
export function approvePlan(gate: PlanGate): PlanGate {
  if (gate.status !== 'plan_ready') return gate;
  return { ...gate, status: 'approved' };
}

// [Esc] in TUI - the task is canceled entirely, the gate is reset.
export function cancelPlan(): PlanGate {
  return { ...IDLE_GATE };
}

export type ReviseOutcome = { gate: PlanGate; toOrchestrator: BusMessage } | { gate: PlanGate; error: string };

// Serialize the plan back to the same STEP format for $EDITOR - what the user edits
// parsePlanText/revisePlan should be able to be read without loss (round-trip).
export function planToEditableText(plan: PlanPayload): string {
  const lines = plan.steps.map(
    (s) => `STEP ${s.step_id} | ${s.agent_id} | ${s.description} | FILES: ${s.files.join(', ')} | DEPENDS: ${s.depends_on.join(', ') || 'none'}`,
  );
  return ['[PLAN]', ...lines, '[/PLAN]'].join('\n');
}

// [e] in TUI: the plan is edited as markdown (same STEP format) in $EDITOR. Edited text
// becomes a plan directly - a second round through the orchestrator is not needed: the plan is already
// verified by a human, drive it back and forth just so that the CLI can do the same
// parse, it would be worth the orchestrator context without mechanical benefit (ARCHITECTURE principle 1).
// PLAN_REVISED still goes to the orchestrator - informationally, so that its own context is not
// diverged from what is actually being implemented.
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

// Enforcement on the CLI side (constraint spec_cli_plan_mode): TASK from the orchestrator to the agent or
// WRITE/EDIT from the agent, not yet approved - the agent is paused.
export function pauseCommand(agentId: string): BusMessage {
  const payload: CommandPayload = { command: 'PAUSE', agent_id: agentId };
  return { id: randomUUID(), from: 'cli', to: agentId, type: 'COMMAND', ts: new Date().toISOString(), payload };
}

// Notification to the user (not the orchestrator - this is not a solution for him, but a fact of violation
// protocol, cheap mechanical truth, ARCHITECTURE §12) - to: 'cli', like responseHealth/
// backupAgents NOTIFY, visible via /log.
export function planViolationNotify(agentId: string, details: string): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_MODE_VIOLATION', agent_id: agentId, details };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

// Digression 1-2 (“Plan B”, spec_md_orchestrator): rewrite the plan strictly according to the format.
export function replanCommand(instructionText: string): BusMessage {
  const payload: CommandPayload = { command: 'REPLAN', args: { text: instructionText } };
  return { id: randomUUID(), from: 'cli', to: 'orchestrator', type: 'COMMAND', ts: new Date().toISOString(), payload };
}

// Pause 3 and timeout 120s - both lead to the same thing: show the user raw text,
// suggest a repeat (spec constraint). to: 'cli' - same self-NOTIFY principle as pauseCommand's
// notification.
export function planGiveUpNotify(rawText: string): BusMessage {
  const payload: NotifyPayload = { event: 'PLAN_TIMEOUT_OR_GIVEUP', details: rawText };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}
