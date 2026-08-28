// Главный цикл CLI (spec_cli §"Главный цикл"): merge → маршрутизация → обновление реестра.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { makeBatchFromContent } from '../../../shared/bus-source.ts';
import type { BusWriter } from '../bus/write.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import { loadConfig, type FreeAgentConfig } from '../config/config.ts';
import { scanIncoming } from './mergeIncoming.ts';
import { route, flushBuffered, type Delivery } from './router.ts';
import { applyMessageToRegistry, handleFsCall, handleRegisterRequest } from './applyMessage.ts';
import { checkInitTimeouts } from '../agents/initAgent.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

export interface MainLoopState {
  registry: AgentsRegistry;
  buffered: Record<string, BusMessage[]>;
  cursor: number;
}

export async function runMainLoopOnce(
  freeagentDir: string,
  writer: BusWriter,
  state: MainLoopState,
): Promise<{ commands: Delivery[] }> {
  await scanIncoming(join(freeagentDir, 'incoming'), writer);

  const content = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8').catch(() => '');
  const batch = makeBatchFromContent(content);

  const commands: Delivery[] = [];
  let cachedConfig: FreeAgentConfig | undefined;
  const getConfig = async (): Promise<FreeAgentConfig> => {
    if (cachedConfig === undefined) cachedConfig = (await loadConfig(freeagentDir)).config;
    return cachedConfig;
  };

  for (const line of batch.linesAfter(state.cursor)) {
    state.cursor = line.position;
    const parsed = parseBusLine(line.text);
    if (!parsed.ok) continue;
    const msg = parsed.msg;

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
