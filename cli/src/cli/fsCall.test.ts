// Wiring [FS]/[FS_RESULT] through the bus (micro-PR before PR-5): full path, not just in-memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toTagFormat, fromTagFormat, type BusMessage } from '../../../shared/bus-types/index.ts';
import { BusWriter } from '../bus/write.ts';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './mainLoop.ts';
import type { AgentsRegistry } from '../registry/registry.ts';

async function projectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-fscall-e2e-'));
}

test('FS_CALL: tag layer -> jsonl file -> parseBusLine -> dispatch -> parseFsCall, body survives verbatim; FS_RESULT routed only to the caller', async (t) => {
  const projectRoot = await projectDir();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const freeagentDir = join(projectRoot, 'freeagent');
  await mkdir(join(freeagentDir, 'incoming'), { recursive: true });

  const heredocBody = [
    '[FS | op: write | path: notes.md | kind: doc | end: ---FS_END---]',
    '```ts',
    'const x = 1; // pipe | and `backtick`',
    '```',
    '[FS | op: read | path: fake.md]',
    '---FS_END---',
  ].join('\n');

  const original: BusMessage = {
    id: '',
    from: 'coder1',
    to: 'cli',
    type: 'FS_CALL',
    ts: new Date().toISOString(),
    payload: heredocBody,
  };

  // tag-layer: as if the content script parsed the model's response (toTagFormat/fromTagFormat do not change)
  const tagged = toTagFormat(original);
  const [extracted] = fromTagFormat(tagged);
  assert.ok(extracted);
  assert.equal(extracted.payload, heredocBody, 'the layer tag did not touch the heredoc body');

  const withId: BusMessage = { ...extracted, id: randomUUID() };

  // file layer: real jsonl string, real write/read
  await writeFile(join(freeagentDir, 'incoming', 'browser_a.jsonl'), JSON.stringify(withId) + '\n', 'utf8');

  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };

  const { commands } = await runMainLoopOnce(freeagentDir, writer, state);

  assert.equal(commands.length, 1, 'FS_RESULT is addressed to exactly one recipient - the calling agent');
  assert.equal(commands[0].instanceId, 'browser_a');
  assert.equal(commands[0].message.type, 'FS_RESULT');
  assert.equal(commands[0].message.to, 'coder1', 'FS_RESULT addressed to the instance/agent of the caller, not broadcast');

  const rendered = commands[0].message.payload as string;
  assert.match(rendered, /"ok":true/);

  const writtenFile = await readFile(join(projectRoot, 'notes.md'), 'utf8');
  assert.equal(
    writtenFile,
    ['```ts', 'const x = 1; // pipe | and `backtick`', '```', '[FS | op: read | path: fake.md]'].join('\n'),
    'body heredoc (backtics, |, nested tag-like string) reached disk verbatim',
  );

  await appendCommands(freeagentDir, commands);
  const commandsFile = await readFile(join(freeagentDir, 'commands', 'browser_a.jsonl'), 'utf8');
  assert.match(commandsFile, /"type":"FS_RESULT"/, 'FS_RESULT is injected via commands/<instance_id>, not directly from the CLI');
});
