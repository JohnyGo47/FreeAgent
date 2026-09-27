import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { planRotation, rotateIfNeeded, rotationConfigFromThreshold, DEFAULT_ROTATION_CONFIG } from './rotation.ts';
import { parseBusLine, type BusMessage } from '../../../shared/bus-types/index.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-rotation-'));
}

function msg(seq: number, type: BusMessage['type'] = 'STATUS', payload: unknown = {}, tsMs = Date.now()): BusMessage {
  return { id: `m${seq}`, seq, from: 'coder1', to: 'orchestrator', type, ts: new Date(tsMs).toISOString(), payload };
}

test('planRotation: messages are less than the threshold -> rotation is not needed, all messages remain', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(i + 1));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000 }, Date.now());
  assert.equal(plan.archive.length, 0);
  assert.equal(plan.keep.length, 10);
});

test('planRotation: "last 1000" wins when the hour window is narrower (messages are sparse in time)', () => {
  const now = Date.now();
  // 10s between messages * 1500 = ~4h17m total range - hour window only covers
  // tail (~360 messages), the “last 1000” rule holds more.
  const messages = Array.from({ length: 1500 }, (_, i) => msg(i + 1, 'STATUS', {}, now - (1500 - i) * 10000));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 }, now);
  assert.equal(plan.keep.length, 1000);
  assert.equal(plan.archive.length, 500);
  assert.equal(plan.keep[0].seq, 501);
});

test('planRotation: the hour window wins when it is wider than the "last 1000" (whichever is larger is what remains)', () => {
  const now = Date.now();
  // 1s between messages * 1500 = 25 minutes of total range - all messages within the hourly
  // windows, it holds more (all 1500) than the "last 1000" rule.
  const messages = Array.from({ length: 1500 }, (_, i) => msg(i + 1, 'STATUS', {}, now - (1500 - i) * 1000));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 }, now);
  assert.equal(plan.keep.length, 1500);
  assert.equal(plan.archive.length, 0);
});

test('TASK without RESULT before the cut point -> the point is moved back, the pair remains in keep together', () => {
  const now = Date.now();
  const messages: BusMessage[] = [];
  for (let i = 1; i <= 999; i++) messages.push(msg(i, 'STATUS', {}, now - (1500 - i) * 1000));
  // seq 1000: TASK without RESULT, neither in archive nor in keep - CLI has not yet received a response.
  messages.push({ id: 'task1', seq: 1000, from: 'orchestrator', to: 'coder1', type: 'TASK', ts: new Date(now - 500000).toISOString(), payload: { task_id: 't1', description: 'x' } });
  for (let i = 1001; i <= 1500; i++) messages.push(msg(i, 'STATUS', {}, now - (1500 - i) * 1000));

  // The naive "last 400" boundary would fall on seq 1101 (index 1100), leaving task1 (index 999,
  // seq 1000) in archive - but it doesn't have a RESULT anywhere in the set, so the boundary must move
  // back to his position.
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 400, keepMinMs: 0 }, now);
  const taskInArchive = plan.archive.some((m) => m.seq === 1000);
  assert.equal(taskInArchive, false, 'TASK without RESULT must not be cut off from the kept tail');
  assert.ok(plan.keep.some((m) => m.seq === 1000));
});

test('rotateIfNeeded: file greater than threshold -> rotation, archive created, main file contains last 1000 messages', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  const archiveDir = join(dir, 'message_bus_archive');

  const now = Date.now();
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify(msg(i + 1, 'STATUS', { pad: 'x'.repeat(4000) }, now - (1500 - i) * 10000)));
  await writeFile(busPath, lines.join('\n') + '\n', 'utf8');

  const result = await rotateIfNeeded(busPath, archiveDir, { ...DEFAULT_ROTATION_CONFIG, thresholdBytes: 1_000_000, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 }, now);
  assert.equal(result.rotated, true);

  const remaining = (await readFile(busPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  assert.equal(remaining.length, 1000);
  const firstKept = parseBusLine(remaining[0]);
  assert.equal(firstKept.ok && firstKept.msg.seq, 501);

  const archiveFiles = await readdir(archiveDir);
  assert.equal(archiveFiles.length, 1);
  assert.match(archiveFiles[0], /^bus_.*\.jsonl\.gz$/);
  const archived = gunzipSync(await readFile(join(archiveDir, archiveFiles[0]))).toString('utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(archived.length, 500);
});

test('rotation threshold is configurable (freeagent.config.json): a low threshold forces rotation of a small file', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify(msg(i + 1)));
  await writeFile(busPath, lines.join('\n') + '\n', 'utf8');

  const notRotated = await rotateIfNeeded(busPath, join(dir, 'archive'), rotationConfigFromThreshold(5 * 1024 * 1024), Date.now());
  assert.equal(notRotated.rotated, false); // small file, default 5MB threshold is not broken

  // keepMinMs: 0 - all 1500 messages were created "just now", a one-hour window would keep them all;
  // here only the fact that the threshold is triggered from the config is important, not the choice of the cut point.
  const rotated = await rotateIfNeeded(busPath, join(dir, 'archive'), { ...rotationConfigFromThreshold(1), keepMinMs: 0 }, Date.now());
  assert.equal(rotated.rotated, true); // the same file, the threshold from the config is lowered to 1 byte
});

test('rotateIfNeeded: file is less than threshold -> no rotation is performed', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  await writeFile(busPath, JSON.stringify(msg(1)) + '\n', 'utf8');

  const result = await rotateIfNeeded(busPath, join(dir, 'archive'), DEFAULT_ROTATION_CONFIG, Date.now());
  assert.equal(result.rotated, false);
});

test('crash between writing the archive and overwriting the main file -> re-rotation is safe', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  const archiveDir = join(dir, 'message_bus_archive');

  const now = Date.now();
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify(msg(i + 1, 'STATUS', { pad: 'x'.repeat(4000) }, now - (1500 - i) * 10000)));
  await writeFile(busPath, lines.join('\n') + '\n', 'utf8');

  const config = { ...DEFAULT_ROTATION_CONFIG, thresholdBytes: 1_000_000, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 };

  // Simulate a fall “between recording the archive and overwriting the main one”: we are already writing the archive ourselves
  // in advance, the main file remains untouched (as if rotateIfNeeded had fallen after step 4).
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'bus_stale.jsonl.gz'), 'not a real gzip, simulates a leftover partial archive');

  // The main file is still full (1500 messages) - the rotation should safely be repeated from scratch.
  const result = await rotateIfNeeded(busPath, archiveDir, config, now);
  assert.equal(result.rotated, true);
  const remaining = (await readFile(busPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  assert.equal(remaining.length, 1000);

  const sizeAfter = (await stat(busPath)).size;
  assert.ok(sizeAfter > 0);
});
