// CLI main loop (spec_cli §"Main loop"): merge → routing → registry update.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { log } from '../../../shared/log.ts';
import type { BusWriter } from '../bus/write.ts';
import { type AgentsRegistry, validAgentIds } from '../registry/registry.ts';
import { loadConfig, type FreeAgentConfig } from '../config/config.ts';
import { scanIncoming } from './mergeIncoming.ts';
import { route, flushBuffered, type Delivery } from './router.ts';
import { applyMessageToRegistry, handleFsCall, handleRegisterRequest, handleTabState, handleResponseHealth, handleSwitchReady } from './applyMessage.ts';
import { checkInitTimeouts } from '../agents/initAgent.ts';
import { rotateIfNeeded, rotationConfigFromThreshold } from '../bus/rotation.ts';
import { parseFsCall } from '../fs/parseFsCall.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';
import {
  IDLE_GATE,
  type PlanGate,
  startTask,
  isBlockedByGate,
  checkTimeout,
  receivePlanText,
  pauseCommand,
  planViolationNotify,
  replanCommand,
  planGiveUpNotify,
} from './planMode.ts';
import {
  type PlanExecutionState,
  startExecution,
  nextTasks,
  applyResult,
  applyOwnershipViolation,
  dedupeStatus,
  currentStepFilesForAgent,
  currentTaskIdForAgent,
  recordTestsReady,
  recordWrittenFile,
  planCompleteNotify,
  escalationNotify,
} from './planExecution.ts';
import { loadCheckpoints, saveCheckpoints, preTaskCheckpoint, doneCheckpoint, isGitRepo, type CheckpointEntry } from './gitCheckpoints.ts';
import type { NotifyPayload, ResultPayload } from '../../../shared/bus-types/index.ts';

export interface MainLoopState {
  registry: AgentsRegistry;
  buffered: Record<string, BusMessage[]>;
  cursor: number; // main bus seq, not byte offset and not line number (ARCHITECTURE §4) -
  // undergoes rotation (spec_bus_rotation): the entire file is reread every tick, so
  // "getting stuck" on a position is impossible, and seq remains valid after rewriting the file.
  gate?: PlanGate; // current task: waiting for/received/approved plan (spec_cli_plan_mode). Optional
  // only for backward compatibility of old state literals in tests - runMainLoopOnce
  // materializes IDLE_GATE if not specified.
  execution?: PlanExecutionState; // exists only while the approved plan is being executed (spec_plan_execution)
}

// Round nextTasks() → actual sending via router.route() (buffering SWITCHING/INITIALIZING
// - task B.12, router.ts already knows how to do it, it is not rewritten here).
function dispatchPlanTasks(execution: PlanExecutionState, registry: AgentsRegistry, buffered: Record<string, BusMessage[]>, commands: Delivery[]): PlanExecutionState {
  const round = nextTasks(execution);
  for (const task of round.tasks) {
    const routed = route(task, registry, buffered);
    commands.push(...routed.toCommands);
  }
  return round.state;
}

// unverified is visible to the user and is not presented as verified (spec_verification task A.4) —
// self-NOTIFY (to:'cli', like planViolationNotify) + direct output to CLI terminal, not just /log.
function unverifiedNotify(stepId: number, agentId: string): BusMessage {
  const payload: NotifyPayload = { event: 'STEP_UNVERIFIED', agent_id: agentId, details: `step ${stepId} closed without TESTS_READY — unverified` };
  return { id: randomUUID(), from: 'cli', to: 'cli', type: 'NOTIFY', ts: new Date().toISOString(), payload };
}

// git_checkpoints (task B.13): checkpoints are disabled explicitly (`git_checkpoints: false` in the config,
// init.ts puts this when the user has abandoned `git init`) or .git is physically missing
// (the project was moved/git was deleted manually after init) - in both cases we silently skip here,
// TUI shows a permanent warning from the config separately (App.ts).
async function checkpointsEnabled(fsRoot: string, config: FreeAgentConfig): Promise<boolean> {
  if (config.git_checkpoints === false) return false;
  return isGitRepo(fsRoot);
}

// First WRITE within task_id -> pre-task commit marker (task B.8). checkpoints.json -
// source of truth "whether there was already a pre-task for this task_id" (survives CLI restart, not only
// in-memory tick state).
async function ensurePreTaskCheckpoint(freeagentDir: string, fsRoot: string, taskId: string, files: string[]): Promise<void> {
  const entries = await loadCheckpoints(freeagentDir);
  if (entries.some((e) => e.task_id === taskId)) return;
  const outcome = await preTaskCheckpoint(fsRoot, taskId);
  if ('error' in outcome) {
    log.warn(`git_checkpoints: pre-task ${taskId} failed: ${outcome.error}`);
    return;
  }
  const entry: CheckpointEntry = { task_id: taskId, files, pre_task_commit: outcome.hash, ts: new Date().toISOString() };
  await saveCheckpoints(freeagentDir, [...entries, entry]);
}

// RESULT: DONE after successful verification -> done commit (task B.8), updates the same record
// checkpoints.json, which was created by ensurePreTaskCheckpoint.
async function ensureDoneCheckpoint(freeagentDir: string, fsRoot: string, taskId: string, files: string[], summary: string): Promise<void> {
  const entries = await loadCheckpoints(freeagentDir);
  const idx = entries.findIndex((e) => e.task_id === taskId);
  if (idx === -1) return; // there was no pre-task (for example, WRITE never happened) - nothing to close
  const outcome = await doneCheckpoint(fsRoot, taskId, files, summary);
  if ('error' in outcome) {
    log.warn(`git_checkpoints: done-commit ${taskId} failed: ${outcome.error}`);
    return;
  }
  const updated = [...entries];
  updated[idx] = { ...updated[idx], done_commit: outcome.hash, summary };
  await saveCheckpoints(freeagentDir, updated);
}

export async function runMainLoopOnce(
  freeagentDir: string,
  writer: BusWriter,
  state: MainLoopState,
): Promise<{ commands: Delivery[]; processed: BusMessage[] }> {
  await scanIncoming(join(freeagentDir, 'incoming'), writer);

  const content = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8').catch(() => '');
  const lines = content.split('\n').filter((l) => l.length > 0);

  // The cursor could point to a seq that went into the archive during rotation (spec_bus_rotation) - the first
  // available in the seq file is now greater than state.cursor+1. This is not an error (the messages have already been processed
  // before rotation), but it’s worth warning: the gap is visible only once, on the first tick after rotation.
  if (state.cursor > 0 && lines.length > 0) {
    const firstParsed = parseBusLine(lines[0]);
    if (firstParsed.ok && typeof firstParsed.msg.seq === 'number' && firstParsed.msg.seq > state.cursor + 1) {
      const skipped = firstParsed.msg.seq - state.cursor - 1;
      log.warn(`main bus: ${skipped} messages skipped (archived) - cursor ${state.cursor} -> ${firstParsed.msg.seq}`);
    }
  }

  const commands: Delivery[] = [];
  const processed: BusMessage[] = [];
  let cachedConfig: FreeAgentConfig | undefined;
  const getConfig = async (): Promise<FreeAgentConfig> => {
    if (cachedConfig === undefined) cachedConfig = (await loadConfig(freeagentDir)).config;
    return cachedConfig;
  };

  if (state.gate === undefined) state.gate = { ...IDLE_GATE };
  // Start of tick: plan just approved externally (TUI [Enter]/[e], bin.ts creates state.execution)
  // or the last tick freed the file of a busy step - both cases give new sendable steps without
  // participation of the incoming message of this tick.
  if (state.execution) {
    state.execution = dispatchPlanTasks(state.execution, state.registry, state.buffered, commands);
  }

  for (const lineText of lines) {
    const parsed = parseBusLine(lineText);
    if (!parsed.ok) continue; // broken line - skip and log (ARCHITECTURE §4); full
    // reread the file every tick, so it’s impossible to get stuck on a garbage line
    const msg = parsed.msg;
    if (typeof msg.seq !== 'number' || msg.seq <= state.cursor) continue; // already processed on the last tick
    state.cursor = msg.seq;
    processed.push(msg);

    // READY while switching to backup (spec_backup_agents) - recognized by switching_step
    // BEFORE the usual applyMessageToRegistry, otherwise it would silently move the status to IDLE/STANDBY by
    // switching procedures.
    if (msg.type === 'READY' && state.registry[msg.from]?.switching_step) {
      const outcome = await handleSwitchReady(freeagentDir, state.registry, msg, state.buffered);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toCommands) commands.push(...outcome.toCommands);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue;
    }

    state.registry = applyMessageToRegistry(msg, state.registry);
    if (msg.type === 'READY' && state.registry[msg.from]?.status === 'IDLE') {
      commands.push(...flushBuffered(msg.from, state.registry, state.buffered));
    }

    if (msg.type === 'FS_CALL') {
      const config = await getConfig();
      const fsRoot = join(dirname(freeagentDir), config.project_root);
      const modelText = typeof msg.payload === 'string' ? msg.payload : '';
      const { calls } = parseFsCall(modelText);
      const isWriteLike = calls.some((c) => c.args.op === 'write' || c.args.op === 'edit');

      // Enforcement on the CLI side (spec_cli_plan_mode task A.3): WRITE/EDIT to APPROVED by
      // current task -> agent paused, user notified. We don't rely on discipline
      // models (the role tells her this, but a weak model can ignore it).
      if (isWriteLike && isBlockedByGate(state.gate ?? IDLE_GATE)) {
        commands.push(...route(pauseCommand(msg.from), state.registry, state.buffered).toCommands);
        await writer.mergeOnce([JSON.stringify(planViolationNotify(msg.from, `${msg.from} sent WRITE/EDIT before plan APPROVED`))]);
        continue;
      }

      // Level-3 (spec_write_path_validation §3, task C): files of the current agent step in the active
      // plan; null/undefined outside of plan or in yolo - skipped inside pathGuard.
      const ownedFiles = state.execution ? currentStepFilesForAgent(state.execution, msg.from) : undefined;
      const reply = await handleFsCall(fsRoot, msg, ownedFiles);
      if (reply) {
        const succeeded = typeof reply.payload === 'string' && reply.payload.includes('"ok":true');
        if (isWriteLike && state.execution && ownedFiles && typeof reply.payload === 'string' && reply.payload.includes('"code":"FILE_NOT_OWNED"')) {
          const violation = applyOwnershipViolation(state.execution, msg.from, modelText);
          state.execution = violation.state;
          if (violation.event.kind === 'escalate') {
            await writer.mergeOnce([JSON.stringify(escalationNotify(violation.event.reason))]);
          }
        } else if (isWriteLike && succeeded && state.execution) {
          // Successful write/edit within a plan step - taken into account for verification (task A.3:
          // "the file is still on disk" to RESULT:DONE) and start/continue a git checkpoint for the task
          // (task B.8: first WRITE within task_id -> pre-task commit).
          const writtenPath = calls[0]?.args.path;
          if (writtenPath) {
            state.execution = recordWrittenFile(state.execution, msg.from, writtenPath);
            const taskId = currentTaskIdForAgent(state.execution, msg.from);
            const config = await getConfig();
            if (taskId && (await checkpointsEnabled(fsRoot, config))) {
              const stepFiles = currentStepFilesForAgent(state.execution, msg.from) ?? [];
              await ensurePreTaskCheckpoint(freeagentDir, fsRoot, taskId, stepFiles);
            }
          }
        }
        const routedReply = route(reply, state.registry, state.buffered);
        commands.push(...routedReply.toCommands);
        if (routedReply.toBus) {
          await writer.mergeOnce([JSON.stringify(routedReply.toBus)]);
        }
      }
      continue; // FS_CALL is addressed to 'cli' - the normal route() below would return an empty toCommands
    }

    // TESTS_READY {task_id, command} - CLI remembers the command against the step; the run itself is postponed
    // until RESULT:DONE (spec_verification step protocol, spec_plan_execution contract clause 5).
    if (msg.type === 'TESTS_READY' && state.execution) {
      state.execution = recordTestsReady(state.execution, msg);
      continue; // addressed to 'cli' - normal route() below would return empty toCommands
    }

    // New task from the user - the gate starts here, but TASK must still reach
    // orchestrator with the usual route() below (without continue): without the task text, it cannot issue a plan.
    if (msg.type === 'TASK' && msg.from === 'user' && msg.to === 'orchestrator') {
      const config = await getConfig();
      state.gate = startTask(msg.id || `t-${msg.seq}`, Date.now(), config.mode);
      state.execution = undefined;
    }

    // Task A.3/A.1: the orchestrator sends TASK to the agent directly, bypassing plan_execution, until the plan
    // approved - block. Legitimate TASKs from plan_execution come from:'cli', this branch
    // don't touch.
    if (msg.type === 'TASK' && msg.from === 'orchestrator' && msg.to !== 'cli' && msg.to !== 'extension' && isBlockedByGate(state.gate ?? IDLE_GATE)) {
      commands.push(...route(pauseCommand(msg.to), state.registry, state.buffered).toCommands);
      await writer.mergeOnce([JSON.stringify(planViolationNotify(msg.from, `orchestrator started without plan: TASK -> ${msg.to} to APPROVED`))]);
      continue;
    }

    // Orchestrator response to waiting for a plan: [PLAN]...[/PLAN] in raw text (same scheme
    // postings that FS_CALL - payload carries the text as is, parses only the CLI).
    if (msg.type === 'PLAN' && msg.from === 'orchestrator') {
      const rawText = typeof msg.payload === 'string' ? msg.payload : '';
      const { gate: nextGate, outcome } = receivePlanText(state.gate ?? IDLE_GATE, rawText, validAgentIds(state.registry));
      state.gate = nextGate;
      if (outcome.kind === 'retry') {
        await writer.mergeOnce([JSON.stringify(replanCommand(outcome.message))]);
      } else if (outcome.kind === 'show_raw') {
        await writer.mergeOnce([JSON.stringify(planGiveUpNotify(outcome.rawText))]);
      }
      // 'ready'/'ignored': nothing on the bus - TUI picks up the new gate from the state on the render
      continue;
    }

    // RESULT of the executable plan step (spec_plan_execution). On a happy journey (progress) - 0
    // messages to the orchestrator (continue without mergeOnce); escalation/termination are the only cases
    // when he even learns about the plan in progress. RESULT:DONE is now actually verified
    // (spec_verification task A.7) - applyResult calls verifyStep internally, does not take DONE's word for it.
    if (msg.type === 'RESULT' && msg.to === 'orchestrator' && state.execution) {
      const config = await getConfig();
      const fsRoot = join(dirname(freeagentDir), config.project_root);
      const outcome = await applyResult(state.execution, msg, config.self_assessment_threshold, {
        cwd: fsRoot,
        timeoutMs: config.test_timeout_ms,
        logsDir: join(freeagentDir, 'logs'),
      });
      state.execution = outcome.state;

      if (outcome.event.kind === 'escalate') {
        await writer.mergeOnce([JSON.stringify(escalationNotify(outcome.event.reason))]);
      } else {
        // The step has actually closed (progress/complete, not escalate) - done checkpoint (task B.8) and,
        // if verifyStep returned unverified, a visible flag to the user (task A.4).
        if (outcome.step && (await checkpointsEnabled(fsRoot, config))) {
          const payload = msg.payload as ResultPayload;
          await ensureDoneCheckpoint(freeagentDir, fsRoot, payload.task_id, outcome.step.files, payload.summary);
        }
        if (outcome.unverified && outcome.step) {
          const notice = unverifiedNotify(outcome.step.step_id, outcome.step.agent_id);
          log.warn(`unverified: step ${outcome.step.step_id} (${outcome.step.agent_id}) closed without TESTS_READY`);
          await writer.mergeOnce([JSON.stringify(notice)]);
        }

        if (outcome.event.kind === 'complete') {
          await writer.mergeOnce([JSON.stringify(planCompleteNotify())]);
          state.execution = undefined;
          state.gate = { ...IDLE_GATE }; // task is closed, gate is free for the next one
        } else {
          state.execution = dispatchPlanTasks(state.execution, state.registry, state.buffered, commands);
        }
      }
      continue;
    }

    // Dedup STATUS (ARCHITECTURE §8, task B.11): during plan execution, routine transition
    // WORKING/IDLE is not a reason to wake up the orchestrator - escalation only for exceptions above.
    if (msg.type === 'STATUS' && msg.to === 'orchestrator' && state.execution) {
      const result = dedupeStatus(state.execution, msg);
      state.execution = result.state;
      if (result.toOrchestrator) await writer.mergeOnce([JSON.stringify(result.toOrchestrator)]);
      continue;
    }

    if (msg.type === 'REGISTER_REQUEST') {
      const outcome = await handleRegisterRequest(freeagentDir, state.registry, msg);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue; // REGISTER_REQUEST is addressed to 'cli' - the normal route() below would return an empty toCommands
    }

    if (msg.type === 'TAB_STATE') {
      const outcome = await handleTabState(freeagentDir, state.registry, msg);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue; // TAB_STATE is addressed to 'cli' - a normal route() below would return an empty toCommands
    }

    if (msg.type === 'RESPONSE_HEALTH') {
      const config = await getConfig();
      const outcome = await handleResponseHealth(freeagentDir, state.registry, msg, config);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue; // RESPONSE_HEALTH is addressed to 'cli' - a normal route() below would return an empty toCommands
    }

    const routed = route(msg, state.registry, state.buffered);
    commands.push(...routed.toCommands);
    if (routed.toBus) {
      await writer.mergeOnce([JSON.stringify(routed.toBus)]);
    }
  }

  // Plan waiting timeout (spec_cli_plan_mode constraint): 120s without a valid [PLAN] -> raw
  // the answer (if any) is shown to the user and a repeat is offered. checkTimeout - no-op outside
  // awaiting_plan, it's safe to call every tick.
  if (state.gate.status === 'awaiting_plan') {
    const timedOut = checkTimeout(state.gate, Date.now());
    if (timedOut.status === 'timed_out') {
      state.gate = timedOut;
      await writer.mergeOnce([JSON.stringify(planGiveUpNotify(state.gate.rawText ?? '(no response in 120s)'))]);
    }
  }

  // Wait timeout READY (spec_init_agent): INITIALIZING longer than init_timeout_ms → INIT_FAILED.
  if (Object.values(state.registry).some((a) => a.status === 'INITIALIZING')) {
    const config = await getConfig();
    state.registry = checkInitTimeouts(state.registry, Date.now(), config.init_timeout_ms);
  }

  // Rotation of the main bus (spec_bus_rotation) - at the end of the tick, after all messages for this
  // ticks have already been processed and taken into account in state.cursor (seq); rotateIfNeeded - no-op below the size threshold.
  const config = await getConfig();
  await rotateIfNeeded(
    join(freeagentDir, 'message_bus.jsonl'),
    join(freeagentDir, 'message_bus_archive'),
    rotationConfigFromThreshold(config.bus_rotation_threshold_bytes),
    Date.now(),
  );

  return { commands, processed };
}

export async function appendCommands(freeagentDir: string, commands: Delivery[]): Promise<void> {
  const commandsDir = join(freeagentDir, 'commands');
  await mkdir(commandsDir, { recursive: true });
  const byInstance = new Map<string, string[]>();
  for (const { instanceId, message } of commands) {
    (byInstance.get(instanceId) ?? byInstance.set(instanceId, []).get(instanceId)!).push(JSON.stringify(message));
  }
  for (const [instanceId, lines] of byInstance) {
    await appendFile(join(commandsDir, `${instanceId}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }
}
