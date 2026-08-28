import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMessageToRegistry, handleFsCall, handleRegisterRequest } from './applyMessage.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage, RegisterPayload } from '../../../shared/bus-types/index.ts';

function registry(): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'SWITCHING' } };
}

function msg(from: string, type: BusMessage['type'], payload: unknown = {}): BusMessage {
  return { id: 'x', from, to: 'cli', type, ts: new Date().toISOString(), payload };
}

test('READY from an agent moves it to IDLE', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'READY'), registry());
  assert.equal(updated.coder1.status, 'IDLE');
});

test('STATUS payload WORKING/IDLE updates the agent status', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'STATUS', { state: 'WORKING' }), registry());
  assert.equal(updated.coder1.status, 'WORKING');
});

test('RESULT (task finished) moves the agent back to IDLE', () => {
  const updated = applyMessageToRegistry(msg('coder1', 'RESULT', { task_id: 't1', status: 'DONE', summary: 'ok' }), registry());
  assert.equal(updated.coder1.status, 'IDLE');
});

test('unrelated message types leave the registry unchanged', () => {
  const before = registry();
  const updated = applyMessageToRegistry(msg('orchestrator', 'TASK'), before);
  assert.deepEqual(updated, before);
});

test('handleFsCall: FS_CALL runs through the fs pipeline and replies FS_RESULT to the caller', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-fscall-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const call = msg('coder1', 'FS_CALL');
  call.payload = '[FS | op: write | path: notes.md | kind: doc | end: ---FS_END---]\nhello\n---FS_END---';

  const reply = await handleFsCall(root, call);
  assert.ok(reply);
  assert.equal(reply?.from, 'cli');
  assert.equal(reply?.to, 'coder1');
  assert.equal(reply?.type, 'FS_RESULT');
  assert.match(reply?.payload as string, /\[FS_RESULT\]/);
  assert.match(reply?.payload as string, /"ok":true/);

  const written = await readFile(join(root, 'notes.md'), 'utf8');
  assert.equal(written, 'hello');
});

test('handleFsCall: non-FS_CALL message is not handled here', async () => {
  const reply = await handleFsCall('unused', msg('coder1', 'TASK'));
  assert.equal(reply, null);
});

async function skillsDirWithCoder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'freeagent-register-'));
  await mkdir(join(dir, 'skills'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'coder.md'),
    ['---', 'name: coder', 'summary: пишет код', '---', '# Coder role body'].join('\n'),
    'utf8',
  );
  await writeFile(
    join(dir, 'skills', 'orchestrator.md'),
    ['---', 'name: orchestrator', 'summary: координирует агентов', '---', '# Orchestrator role body'].join('\n'),
    'utf8',
  );
  return dir;
}

test('handleRegisterRequest: known role -> agent registered as INITIALIZING, INIT command produced', async (t) => {
  const dir = await skillsDirWithCoder();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const payload: RegisterPayload = { role: 'coder', llm_url: 'https://example.com', tab_id: 1 };
  const registerMsg: BusMessage = { id: 'x', from: 'browser_a', to: 'cli', type: 'REGISTER_REQUEST', ts: new Date().toISOString(), payload };

  const outcome = await handleRegisterRequest(dir, {}, registerMsg);
  assert.equal(outcome.registry.coder1.status, 'INITIALIZING');
  assert.equal(outcome.registry.coder1.instance_id, 'browser_a');
  assert.ok(outcome.toCommand);
  assert.match((outcome.toCommand?.message.payload as { args: { text: string } }).args.text, /# Coder role body/);
});

test('handleRegisterRequest: unknown role -> ERROR reply, no registry entry created', async (t) => {
  const dir = await skillsDirWithCoder();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const payload: RegisterPayload = { role: 'ghost_role', llm_url: 'https://example.com', tab_id: 1 };
  const registerMsg: BusMessage = { id: 'x', from: 'browser_a', to: 'cli', type: 'REGISTER_REQUEST', ts: new Date().toISOString(), payload };

  const outcome = await handleRegisterRequest(dir, {}, registerMsg);
  assert.deepEqual(outcome.registry, {});
  assert.ok(outcome.toBus);
  assert.equal(outcome.toBus?.type, 'ERROR');
});

test('handleRegisterRequest: registering the orchestrator embeds the current roster as extraContext', async (t) => {
  const dir = await skillsDirWithCoder();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const existingRegistry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  const payload: RegisterPayload = { role: 'orchestrator', llm_url: 'https://example.com', tab_id: 2 };
  const registerMsg: BusMessage = { id: 'x', from: 'browser_b', to: 'cli', type: 'REGISTER_REQUEST', ts: new Date().toISOString(), payload };

  const outcome = await handleRegisterRequest(dir, existingRegistry, registerMsg);
  assert.equal(outcome.registry.orchestrator1.role, 'orchestrator');
  const text = (outcome.toCommand?.message.payload as { args: { text: string } }).args.text;
  assert.match(text, /coder1 \[IDLE\] пишет код/);
});
