// Главный цикл CLI (spec_cli §"Главный цикл"): merge → маршрутизация → обновление реестра.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { makeBatchFromContent } from '../../../shared/bus-source.ts';
import type { BusWriter } from '../bus/write.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import { scanIncoming } from './mergeIncoming.ts';
import { route, flushBuffered, type Delivery } from './router.ts';
import { applyMessageToRegistry } from './applyMessage.ts';
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
  for (const line of batch.linesAfter(state.cursor)) {
    state.cursor = line.position;
    const parsed = parseBusLine(line.text);
    if (!parsed.ok) continue;
    const msg = parsed.msg;

    state.registry = applyMessageToRegistry(msg, state.registry);
    if (msg.type === 'READY' && state.registry[msg.from]?.status === 'IDLE') {
      commands.push(...flushBuffered(msg.from, state.registry, state.buffered));
    }

    const routed = route(msg, state.registry, state.buffered);
    commands.push(...routed.toCommands);
    if (routed.toBus) {
      await writer.mergeOnce([JSON.stringify(routed.toBus)]);
    }
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
