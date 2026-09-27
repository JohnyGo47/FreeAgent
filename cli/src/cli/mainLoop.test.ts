import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusWriter } from '../bus/write.ts';
import { rotateIfNeeded, DEFAULT_ROTATION_CONFIG } from '../bus/rotation.ts';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './mainLoop.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function line(id: string, from: string, to: string, type: string, payload: unknown = {}): string {
  return JSON.stringify({ id, from, to, type, ts: new Date().toISOString(), payload });
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-mainloop-'));
}

test('full cycle: extension writes to incoming → CLI merges → routes → registry reflects current status', async (t) => {
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

test('invalid destination: ERROR goes to the main bus, no commands have been written', async (t) => {
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

test('bus_rotation: cursor ahead of cut point -> reader continues without breaks and without duplicates', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'incoming'), { recursive: true });

  const busPath = join(dir, 'message_bus.jsonl');
  const writer = await BusWriter.create(busPath);
  for (let i = 0; i < 600; i++) await writer.mergeOnce([line(`m${i}`, 'coder1', 'cli', 'STATUS', { state: 'IDLE' })]);

  const state: MainLoopState = { registry: {}, buffered: {}, cursor: 0 };
  await runMainLoopOnce(dir, writer, state);
  assert.equal(state.cursor, 600); // the cursor has reached the end - ahead of the future cut point

  const now = Date.now();
  const rotated = await rotateIfNeeded(busPath, join(dir, 'message_bus_archive'), { ...DEFAULT_ROTATION_CONFIG, thresholdBytes: 0, keepMinMessages: 200, keepMinMs: 0 }, now);
  assert.equal(rotated.rotated, true); // archive took seq 1..400, 401..600 remained

  await writer.mergeOnce([line('m601', 'coder1', 'cli', 'STATUS', { state: 'IDLE' })]);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    await runMainLoopOnce(dir, writer, state);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(state.cursor, 601); // continued exactly from the next message, without re-processing
  assert.equal(warnings.length, 0); // nothing is missing - nothing to warn about
});

test('bus_rotation: cursor behind the cut point -> reader starts from the first available seq, warning is displayed', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'incoming'), { recursive: true });

  const busPath = join(dir, 'message_bus.jsonl');
  const writer = await BusWriter.create(busPath);
  for (let i = 0; i < 600; i++) await writer.mergeOnce([line(`m${i}`, 'coder1', 'cli', 'STATUS', { state: 'IDLE' })]);

  // The cursor is behind (200) from what will be archived (1..400) - for example, the reader is long
  // didn't start.
  const state: MainLoopState = { registry: {}, buffered: {}, cursor: 200 };

  const now = Date.now();
  const rotated = await rotateIfNeeded(busPath, join(dir, 'message_bus_archive'), { ...DEFAULT_ROTATION_CONFIG, thresholdBytes: 0, keepMinMessages: 200, keepMinMs: 0 }, now);
  assert.equal(rotated.rotated, true);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    await runMainLoopOnce(dir, writer, state);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(state.cursor, 600); // reached the end of the remaining file (401..600), nothing was lost
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\d+ messages skipped \(archived\)/);
});
