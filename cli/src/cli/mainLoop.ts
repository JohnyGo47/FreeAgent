// Главный цикл CLI (spec_cli §"Главный цикл"): merge → маршрутизация → обновление реестра.
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
  planCompleteNotify,
  escalationNotify,
} from './planExecution.ts';

export interface MainLoopState {
  registry: AgentsRegistry;
  buffered: Record<string, BusMessage[]>;
  cursor: number; // seq главной шины, не байтовый offset и не номер строки (ARCHITECTURE §4) —
  // переживает ротацию (spec_bus_rotation): файл целиком перечитывается каждый тик, поэтому
  // "застревание" на позиции невозможно, а seq остаётся валиден после перезаписи файла.
  gate?: PlanGate; // текущая задача: ждём/получили/approved план (spec_cli_plan_mode). Опционален
  // только для обратной совместимости старых литералов состояния в тестах — runMainLoopOnce
  // материализует IDLE_GATE, если не задан.
  execution?: PlanExecutionState; // существует только пока approved-план исполняется (spec_plan_execution)
}

// Раунд nextTasks() → реальная отправка через router.route() (буферизация SWITCHING/INITIALIZING
// — задача B.12, router.ts её уже умеет, здесь не переписывается).
function dispatchPlanTasks(execution: PlanExecutionState, registry: AgentsRegistry, buffered: Record<string, BusMessage[]>, commands: Delivery[]): PlanExecutionState {
  const round = nextTasks(execution);
  for (const task of round.tasks) {
    const routed = route(task, registry, buffered);
    commands.push(...routed.toCommands);
  }
  return round.state;
}

export async function runMainLoopOnce(
  freeagentDir: string,
  writer: BusWriter,
  state: MainLoopState,
): Promise<{ commands: Delivery[] }> {
  await scanIncoming(join(freeagentDir, 'incoming'), writer);

  const content = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8').catch(() => '');
  const lines = content.split('\n').filter((l) => l.length > 0);

  // Курсор мог указывать на seq, ушедший в архив при ротации (spec_bus_rotation) — первый
  // доступный в файле seq теперь больше state.cursor+1. Это не ошибка (сообщения уже обработаны
  // до ротации), но предупредить стоит: разрыв виден только один раз, на первом тике после ротации.
  if (state.cursor > 0 && lines.length > 0) {
    const firstParsed = parseBusLine(lines[0]);
    if (firstParsed.ok && typeof firstParsed.msg.seq === 'number' && firstParsed.msg.seq > state.cursor + 1) {
      const skipped = firstParsed.msg.seq - state.cursor - 1;
      log.warn(`main bus: пропущено ${skipped} сообщений (в архиве) — курсор ${state.cursor} -> ${firstParsed.msg.seq}`);
    }
  }

  const commands: Delivery[] = [];
  let cachedConfig: FreeAgentConfig | undefined;
  const getConfig = async (): Promise<FreeAgentConfig> => {
    if (cachedConfig === undefined) cachedConfig = (await loadConfig(freeagentDir)).config;
    return cachedConfig;
  };

  if (state.gate === undefined) state.gate = { ...IDLE_GATE };
  // Начало тика: план только что approved извне (TUI [Enter]/[e], bin.ts создаёт state.execution)
  // или прошлый тик освободил файл занятого шага — оба случая дают новые sendable-шаги без
  // участия входящего сообщения этого тика.
  if (state.execution) {
    state.execution = dispatchPlanTasks(state.execution, state.registry, state.buffered, commands);
  }

  for (const lineText of lines) {
    const parsed = parseBusLine(lineText);
    if (!parsed.ok) continue; // битая строка — пропустить и залогировать (ARCHITECTURE §4); полный
    // перечитывать файл каждый тик, поэтому "застрять" на мусорной строке невозможно
    const msg = parsed.msg;
    if (typeof msg.seq !== 'number' || msg.seq <= state.cursor) continue; // уже обработано на прошлом тике
    state.cursor = msg.seq;

    // READY во время переключения на бэкап (spec_backup_agents) — распознаётся по switching_step
    // ДО обычного applyMessageToRegistry, иначе тот молча увёл бы статус в IDLE/STANDBY мимо
    // процедуры переключения.
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
      const isWriteLike = parseFsCall(modelText).calls.some((c) => c.args.op === 'write' || c.args.op === 'edit');

      // Enforcement на стороне CLI (spec_cli_plan_mode задача A.3): WRITE/EDIT до APPROVED по
      // текущей задаче -> агент на паузу, пользователь уведомлён. Не полагаемся на дисциплину
      // модели (роль ей об этом говорит, но слабая модель может проигнорировать).
      if (isWriteLike && isBlockedByGate(state.gate ?? IDLE_GATE)) {
        commands.push(...route(pauseCommand(msg.from), state.registry, state.buffered).toCommands);
        await writer.mergeOnce([JSON.stringify(planViolationNotify(msg.from, `${msg.from} отправил WRITE/EDIT до APPROVED плана`))]);
        continue;
      }

      // Уровень-3 (spec_write_path_validation §3, задача C): files текущего шага агента в активном
      // плане; null/undefined вне плана или в yolo — пропускается внутри pathGuard.
      const ownedFiles = state.execution ? currentStepFilesForAgent(state.execution, msg.from) : undefined;
      const reply = await handleFsCall(fsRoot, msg, ownedFiles);
      if (reply) {
        if (isWriteLike && state.execution && ownedFiles && typeof reply.payload === 'string' && reply.payload.includes('"code":"FILE_NOT_OWNED"')) {
          const violation = applyOwnershipViolation(state.execution, msg.from, modelText);
          state.execution = violation.state;
          if (violation.event.kind === 'escalate') {
            await writer.mergeOnce([JSON.stringify(escalationNotify(violation.event.reason))]);
          }
        }
        const routedReply = route(reply, state.registry, state.buffered);
        commands.push(...routedReply.toCommands);
        if (routedReply.toBus) {
          await writer.mergeOnce([JSON.stringify(routedReply.toBus)]);
        }
      }
      continue; // FS_CALL адресован 'cli' — обычный route() ниже вернул бы пустой toCommands
    }

    // Новая задача от пользователя — гейт стартует здесь, но TASK всё равно должен дойти до
    // оркестратора обычным route() ниже (без continue): без текста задачи он не может выдать план.
    if (msg.type === 'TASK' && msg.from === 'user' && msg.to === 'orchestrator') {
      const config = await getConfig();
      state.gate = startTask(msg.id || `t-${msg.seq}`, Date.now(), config.mode);
      state.execution = undefined;
    }

    // Задача A.3/A.1: оркестратор шлёт TASK агенту напрямую, минуя plan_execution, пока план не
    // approved — заблокировать. Легитимные TASK от plan_execution идут с from:'cli', этой ветки
    // не касаются.
    if (msg.type === 'TASK' && msg.from === 'orchestrator' && msg.to !== 'cli' && msg.to !== 'extension' && isBlockedByGate(state.gate ?? IDLE_GATE)) {
      commands.push(...route(pauseCommand(msg.to), state.registry, state.buffered).toCommands);
      await writer.mergeOnce([JSON.stringify(planViolationNotify(msg.from, `оркестратор начал без плана: TASK -> ${msg.to} до APPROVED`))]);
      continue;
    }

    // Ответ оркестратора на ожидание плана: [PLAN]...[/PLAN] в сыром тексте (та же схема
    // проводки, что FS_CALL — payload возит текст как есть, парсит только CLI).
    if (msg.type === 'PLAN' && msg.from === 'orchestrator') {
      const rawText = typeof msg.payload === 'string' ? msg.payload : '';
      const { gate: nextGate, outcome } = receivePlanText(state.gate ?? IDLE_GATE, rawText, validAgentIds(state.registry));
      state.gate = nextGate;
      if (outcome.kind === 'retry') {
        await writer.mergeOnce([JSON.stringify(replanCommand(outcome.message))]);
      } else if (outcome.kind === 'show_raw') {
        await writer.mergeOnce([JSON.stringify(planGiveUpNotify(outcome.rawText))]);
      }
      // 'ready'/'ignored': ничего на шину — TUI подхватывает новый gate из состояния на рендере
      continue;
    }

    // RESULT шага исполняемого плана (spec_plan_execution). На счастливом пути (progress) — 0
    // сообщений оркестратору (continue без mergeOnce); эскалация/завершение — единственные случаи,
    // когда он вообще узнаёт про план в процессе.
    if (msg.type === 'RESULT' && msg.to === 'orchestrator' && state.execution) {
      const config = await getConfig();
      const outcome = applyResult(state.execution, msg, config.self_assessment_threshold);
      state.execution = outcome.state;

      if (outcome.event.kind === 'escalate') {
        await writer.mergeOnce([JSON.stringify(escalationNotify(outcome.event.reason))]);
      } else if (outcome.event.kind === 'complete') {
        await writer.mergeOnce([JSON.stringify(planCompleteNotify())]);
        state.execution = undefined;
        state.gate = { ...IDLE_GATE }; // задача закрыта, гейт свободен для следующей
      } else {
        state.execution = dispatchPlanTasks(state.execution, state.registry, state.buffered, commands);
      }
      continue;
    }

    // Дедуп STATUS (ARCHITECTURE §8, задача B.11): во время исполнения плана рутинный переход
    // WORKING/IDLE не повод будить оркестратора — эскалация только по исключениям выше.
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
      continue; // REGISTER_REQUEST адресован 'cli' — обычный route() ниже вернул бы пустой toCommands
    }

    if (msg.type === 'TAB_STATE') {
      const outcome = await handleTabState(freeagentDir, state.registry, msg);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue; // TAB_STATE адресован 'cli' — обычный route() ниже вернул бы пустой toCommands
    }

    if (msg.type === 'RESPONSE_HEALTH') {
      const config = await getConfig();
      const outcome = await handleResponseHealth(freeagentDir, state.registry, msg, config);
      state.registry = outcome.registry;
      if (outcome.toCommand) commands.push(outcome.toCommand);
      if (outcome.toBus) await writer.mergeOnce([JSON.stringify(outcome.toBus)]);
      continue; // RESPONSE_HEALTH адресован 'cli' — обычный route() ниже вернул бы пустой toCommands
    }

    const routed = route(msg, state.registry, state.buffered);
    commands.push(...routed.toCommands);
    if (routed.toBus) {
      await writer.mergeOnce([JSON.stringify(routed.toBus)]);
    }
  }

  // Таймаут ожидания плана (spec_cli_plan_mode constraint): 120с без валидного [PLAN] -> сырой
  // ответ (если был) показывается пользователю, предложен повтор. checkTimeout — no-op вне
  // awaiting_plan, безопасно звать каждый тик.
  if (state.gate.status === 'awaiting_plan') {
    const timedOut = checkTimeout(state.gate, Date.now());
    if (timedOut.status === 'timed_out') {
      state.gate = timedOut;
      await writer.mergeOnce([JSON.stringify(planGiveUpNotify(state.gate.rawText ?? '(нет ответа за 120с)'))]);
    }
  }

  // Таймаут ожидания READY (spec_init_agent): INITIALIZING дольше init_timeout_ms → INIT_FAILED.
  if (Object.values(state.registry).some((a) => a.status === 'INITIALIZING')) {
    const config = await getConfig();
    state.registry = checkInitTimeouts(state.registry, Date.now(), config.init_timeout_ms);
  }

  // Ротация главной шины (spec_bus_rotation) — в конце тика, после того как все сообщения этого
  // тика уже обработаны и учтены в state.cursor (seq); rotateIfNeeded — no-op ниже порога размера.
  const config = await getConfig();
  await rotateIfNeeded(
    join(freeagentDir, 'message_bus.jsonl'),
    join(freeagentDir, 'message_bus_archive'),
    rotationConfigFromThreshold(config.bus_rotation_threshold_bytes),
    Date.now(),
  );

  return { commands };
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
