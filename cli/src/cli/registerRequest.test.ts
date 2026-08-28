// REGISTER_REQUEST через главный цикл (spec_init_agent): расширение пишет incoming → CLI мержит,
// присваивает agent_id, инжектит INIT в commands/<instance_id>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './mainLoop.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

function line(id: string, from: string, to: string, type: string, payload: unknown = {}): string {
  return JSON.stringify({ id, from, to, type, ts: new Date().toISOString(), payload });
}

async function projectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-register-e2e-'));
}

test('REGISTER_REQUEST: agent_id assigned, registry updated, INIT command routed to the registering instance', async (t) => {
  const projectRoot = await projectDir();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');
  await mkdir(join(freeagentDir, 'incoming'), { recursive: true });
  await mkdir(join(freeagentDir, 'skills'), { recursive: true });
  await writeFile(
    join(freeagentDir, 'skills', 'coder.md'),
    ['---', 'name: coder', 'summary: пишет код', '---', '# Coder role body'].join('\n'),
    'utf8',
  );

  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('m1', 'browser_a', 'cli', 'REGISTER_REQUEST', { role: 'coder', llm_url: 'https://example.com', tab_id: 1 }) + '\n',
    'utf8',
  );

  const { BusWriter } = await import('../bus/write.ts');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: {}, buffered: {}, cursor: 0 };

  const { commands } = await runMainLoopOnce(freeagentDir, writer, state);

  assert.equal(state.registry.coder1.status, 'INITIALIZING');
  assert.equal(state.registry.coder1.instance_id, 'browser_a');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].instanceId, 'browser_a');
  assert.equal(commands[0].message.type, 'COMMAND');

  await appendCommands(freeagentDir, commands);
  const commandsFile = await readFile(join(freeagentDir, 'commands', 'browser_a.jsonl'), 'utf8');
  assert.match(commandsFile, /"command":"INIT"/);
  assert.match(commandsFile, /# Coder role body/);
});

test('REGISTER_REQUEST for an unknown role: ERROR lands on the main bus, no registry entry', async (t) => {
  const projectRoot = await projectDir();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');
  await mkdir(join(freeagentDir, 'incoming'), { recursive: true });
  await mkdir(join(freeagentDir, 'skills'), { recursive: true });

  await writeFile(
    join(freeagentDir, 'incoming', 'browser_a.jsonl'),
    line('m1', 'browser_a', 'cli', 'REGISTER_REQUEST', { role: 'ghost_role', llm_url: 'https://example.com', tab_id: 1 }) + '\n',
    'utf8',
  );

  const { BusWriter } = await import('../bus/write.ts');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry: {}, buffered: {}, cursor: 0 };

  const { commands } = await runMainLoopOnce(freeagentDir, writer, state);

  assert.deepEqual(state.registry, {});
  assert.equal(commands.length, 0);
  const bus = await readFile(join(freeagentDir, 'message_bus.jsonl'), 'utf8');
  assert.match(bus, /"type":"ERROR"/);
});

test('INIT timeout: an agent stuck INITIALIZING past init_timeout_ms flips to INIT_FAILED on the next tick', async (t) => {
  const projectRoot = await projectDir();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');
  await mkdir(join(freeagentDir, 'incoming'), { recursive: true });
  await writeFile(join(freeagentDir, 'freeagent.config.json'), JSON.stringify({ init_timeout_ms: 1000 }), 'utf8');

  const registry: AgentsRegistry = {
    coder1: {
      agent_id: 'coder1',
      instance_id: 'browser_a',
      tab_id: 1,
      role: 'coder',
      status: 'INITIALIZING',
      registered_at: new Date(Date.now() - 5000).toISOString(),
    },
  };

  const { BusWriter } = await import('../bus/write.ts');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };

  await runMainLoopOnce(freeagentDir, writer, state);
  assert.equal(state.registry.coder1.status, 'INIT_FAILED');
});
