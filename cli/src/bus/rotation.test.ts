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

test('planRotation: сообщений меньше порога -> ротация не нужна, все сообщения остаются', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(i + 1));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000 }, Date.now());
  assert.equal(plan.archive.length, 0);
  assert.equal(plan.keep.length, 10);
});

test('planRotation: "последние 1000" побеждает, когда часовое окно уже (сообщения разрежены по времени)', () => {
  const now = Date.now();
  // 10с между сообщениями * 1500 = ~4ч17м общего диапазона — часовое окно покрывает только
  // хвост (~360 сообщений), правило "последние 1000" держит больше.
  const messages = Array.from({ length: 1500 }, (_, i) => msg(i + 1, 'STATUS', {}, now - (1500 - i) * 10000));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 }, now);
  assert.equal(plan.keep.length, 1000);
  assert.equal(plan.archive.length, 500);
  assert.equal(plan.keep[0].seq, 501);
});

test('planRotation: часовое окно побеждает, когда оно шире "последних 1000" (что больше — то и остаётся)', () => {
  const now = Date.now();
  // 1с между сообщениями * 1500 = 25 минут общего диапазона — все сообщения внутри часового
  // окна, оно держит больше (все 1500), чем правило "последние 1000".
  const messages = Array.from({ length: 1500 }, (_, i) => msg(i + 1, 'STATUS', {}, now - (1500 - i) * 1000));
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 }, now);
  assert.equal(plan.keep.length, 1500);
  assert.equal(plan.archive.length, 0);
});

test('TASK без RESULT перед точкой разреза -> точка сдвинута назад, пара осталась в keep вместе', () => {
  const now = Date.now();
  const messages: BusMessage[] = [];
  for (let i = 1; i <= 999; i++) messages.push(msg(i, 'STATUS', {}, now - (1500 - i) * 1000));
  // seq 1000: TASK без RESULT, ни в архиве, ни в keep — CLI ещё не получил ответ.
  messages.push({ id: 'task1', seq: 1000, from: 'orchestrator', to: 'coder1', type: 'TASK', ts: new Date(now - 500000).toISOString(), payload: { task_id: 't1', description: 'x' } });
  for (let i = 1001; i <= 1500; i++) messages.push(msg(i, 'STATUS', {}, now - (1500 - i) * 1000));

  // Наивная граница "последние 400" легла бы на seq 1101 (index 1100), оставив task1 (index 999,
  // seq 1000) в archive — но у него нет RESULT нигде в наборе, поэтому граница обязана сдвинуться
  // назад до его позиции.
  const plan = planRotation(messages, { ...DEFAULT_ROTATION_CONFIG, keepMinMessages: 400, keepMinMs: 0 }, now);
  const taskInArchive = plan.archive.some((m) => m.seq === 1000);
  assert.equal(taskInArchive, false, 'TASK without RESULT must not be cut off from the kept tail');
  assert.ok(plan.keep.some((m) => m.seq === 1000));
});

test('rotateIfNeeded: файл больше порога -> ротация, архив создан, основной файл содержит последние 1000 сообщений', async (t) => {
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

test('порог ротации конфигурируем (freeagent.config.json): низкий порог форсирует ротацию маленького файла', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify(msg(i + 1)));
  await writeFile(busPath, lines.join('\n') + '\n', 'utf8');

  const notRotated = await rotateIfNeeded(busPath, join(dir, 'archive'), rotationConfigFromThreshold(5 * 1024 * 1024), Date.now());
  assert.equal(notRotated.rotated, false); // маленький файл, дефолтный 5MB порог не пробит

  // keepMinMs: 0 — все 1500 сообщений созданы "только что", часовое окно держало бы их все;
  // здесь важен только сам факт срабатывания порога из конфига, не выбор точки разреза.
  const rotated = await rotateIfNeeded(busPath, join(dir, 'archive'), { ...rotationConfigFromThreshold(1), keepMinMs: 0 }, Date.now());
  assert.equal(rotated.rotated, true); // тот же файл, порог из конфига опущен до 1 байта
});

test('rotateIfNeeded: файл меньше порога -> ротация не выполняется', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  await writeFile(busPath, JSON.stringify(msg(1)) + '\n', 'utf8');

  const result = await rotateIfNeeded(busPath, join(dir, 'archive'), DEFAULT_ROTATION_CONFIG, Date.now());
  assert.equal(result.rotated, false);
});

test('падение между записью архива и перезаписью основного файла -> повторная ротация безопасна', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busPath = join(dir, 'message_bus.jsonl');
  const archiveDir = join(dir, 'message_bus_archive');

  const now = Date.now();
  const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify(msg(i + 1, 'STATUS', { pad: 'x'.repeat(4000) }, now - (1500 - i) * 10000)));
  await writeFile(busPath, lines.join('\n') + '\n', 'utf8');

  const config = { ...DEFAULT_ROTATION_CONFIG, thresholdBytes: 1_000_000, keepMinMessages: 1000, keepMinMs: 60 * 60 * 1000 };

  // Симулируем падение "между записью архива и перезаписью основного": архив уже пишем сами
  // заранее, основной файл остаётся нетронутым (как если бы rotateIfNeeded упал после шага 4).
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'bus_stale.jsonl.gz'), 'not a real gzip, simulates a leftover partial archive');

  // Основной файл всё ещё полный (1500 сообщений) — ротация должна безопасно повториться с нуля.
  const result = await rotateIfNeeded(busPath, archiveDir, config, now);
  assert.equal(result.rotated, true);
  const remaining = (await readFile(busPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  assert.equal(remaining.length, 1000);

  const sizeAfter = (await stat(busPath)).size;
  assert.ok(sizeAfter > 0);
});
