import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from './config.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-config-'));
}

test('missing config: all defaults, not initialized, work is not blocked', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { config, initialized } = await loadConfig(dir);
  assert.equal(initialized, false);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('partial config: missing fields are taken from default', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'freeagent.config.json'), JSON.stringify({ mode: 'yolo' }), 'utf8');

  const { config, initialized } = await loadConfig(dir);
  assert.equal(initialized, true);
  assert.equal(config.mode, 'yolo');
  assert.equal(config.context_threshold_pct, DEFAULT_CONFIG.context_threshold_pct);
});

test('unknown field is preserved when overwritten', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'freeagent.config.json'), JSON.stringify({ some_future_field: 'kept' }), 'utf8');

  const { config } = await loadConfig(dir);
  await saveConfig(dir, config);

  const onDisk = JSON.parse(await readFile(join(dir, 'freeagent.config.json'), 'utf8'));
  assert.equal(onDisk.some_future_field, 'kept');
});

test('project_id matches between two independent config reads → connection confirmed', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await loadConfig(dir);
  first.config.project_id = 'fixed-uuid';
  await saveConfig(dir, first.config);

  const second = await loadConfig(dir);
  assert.equal(second.config.project_id, 'fixed-uuid');
  assert.equal(second.initialized, true);
});

test('folder without config → initialized: false (signal to warn about an uninitialized folder)', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { initialized } = await loadConfig(dir);
  assert.equal(initialized, false);
});
