import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, saveRegistry, isValidAddressee, validAgentIds } from './registry.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-registry-'));
}

test('missing registry file loads as empty', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadRegistry(dir), {});
});

test('save then load round-trips agent entries', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await saveRegistry(dir, {
    coder1: { agent_id: 'coder1', instance_id: 'browser_a1', tab_id: 42, role: 'coder', status: 'IDLE' },
  });
  const registry = await loadRegistry(dir);
  assert.equal(registry.coder1.status, 'IDLE');
});

test('isValidAddressee: known agent_id and "broadcast" are valid, unknown is not', () => {
  const registry = { coder1: { agent_id: 'coder1', instance_id: 'x', tab_id: 1, role: 'coder', status: 'IDLE' as const } };
  assert.equal(isValidAddressee(registry, 'coder1'), true);
  assert.equal(isValidAddressee(registry, 'broadcast'), true);
  assert.equal(isValidAddressee(registry, 'coder5'), false);
});

test('validAgentIds lists registered agent_ids', () => {
  const registry = {
    coder1: { agent_id: 'coder1', instance_id: 'x', tab_id: 1, role: 'coder', status: 'IDLE' as const },
    tester1: { agent_id: 'tester1', instance_id: 'y', tab_id: 2, role: 'tester', status: 'WORKING' as const },
  };
  assert.deepEqual(validAgentIds(registry).sort(), ['coder1', 'tester1']);
});
