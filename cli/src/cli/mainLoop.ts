// Главный цикл CLI (spec_cli §"Главный цикл"): merge → маршрутизация → обновление реестра.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { log } from '../../../shared/log.ts';
import type { BusWriter } from '../bus/write.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import { loadConfig, type FreeAgentConfig } from '../config/config.ts';
import { scanIncoming } from './mergeIncoming.ts';
import { route, flushBuffered, type Delivery } from './router.ts';
import { applyMessageToRegistry, handleFsCall, handleRegisterRequest, handleTabState, handleResponseHealth, handleSwitchReady } from './applyMessage.ts';
import { checkInitTimeouts } from '../agents/initAgent.ts';
import { rotateIfNeeded, rotationConfigFromThreshold } from '../bus/rotation.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

export interface MainLoopState {
  registry: AgentsRegistry;
  buffered: Record<string, BusMessage[]>;
  cursor: number; // seq главной шины, не байтовый offset и не номер строки (ARCHITECTURE §4) —
  // переживает ротацию (spec_bus_rotation): файл целиком перечитывается каждый тик, поэтому
  // "застревание" на позиции невозможно, а seq остаётся валиден после перезаписи файла.
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
      const reply = await handleFsCall(fsRoot, msg);
      if (reply) {
        const routedReply = route(reply, state.registry, state.buffered);
        commands.push(...routedReply.toCommands);
        if (routedReply.toBus) {
          await writer.mergeOnce([JSON.stringify(routedReply.toBus)]);
        }
      }
      continue; // FS_CALL адресован 'cli' — обычный route() ниже вернул бы пустой toCommands
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
