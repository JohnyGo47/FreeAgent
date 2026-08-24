import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusWriter } from '../bus/write.ts';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './mainLoop.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function line(id: string, from: string, to: string, type: string, payload: unknown = {}): string {
  return JSON.stringify({ id, from, to, type, ts: new Date().toISOString(), payload });
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-mainloop-'));
}

test('полный цикл: расширение пишет в incoming → CLI мержит → маршрутизирует → реестр отражает актуальный статус', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'incoming'), { recursive: true });
  await writeFile(
    join(dir, 'incoming', 'browser_a.jsonl'),
    line('m1', 'orchestrator', 'coder1', 'TASK', { task_id: 't1', description: 'do it' }) + '\n',
    'utf8',
  );

  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  const writer = await BusWriter.create(join(dir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };

  const { commands } = await runMainLoopOnce(dir, writer, state);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].instanceId, 'browser_a');

  await appendCommands(dir, commands);
  const commandsFile = await readFile(join(dir, 'commands', 'browser_a.jsonl'), 'utf8');
  assert.match(commandsFile, /"type":"TASK"/);
});

test('невалидный адресат: ERROR уходит в главную шину, ни одна команда не написана', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'incoming'), { recursive: true });
  await writeFile(
    join(dir, 'incoming', 'browser_a.jsonl'),
    line('m1', 'orchestrator', 'coder5', 'TASK', { task_id: 't1', description: 'x' }) + '\n',
    'utf8',
  );

  const writer = await BusWriter.create(join(dir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: {}, buffered: {}, cursor: 0 };

  const { commands } = await runMainLoopOnce(dir, writer, state);
  assert.equal(commands.length, 0);

  const bus = await readFile(join(dir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /"type":"ERROR"/);
});
