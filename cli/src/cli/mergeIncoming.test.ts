import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusWriter } from '../bus/write.ts';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { scanIncoming } from './mergeIncoming.ts';

function line(id: string, from: string): string {
  return JSON.stringify({ id, from, to: 'orchestrator', type: 'STATUS', ts: new Date().toISOString(), payload: {} });
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-mergeincoming-'));
}

test('merge собирает из нескольких incoming в правильном порядке с монотонным seq', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const incomingDir = join(dir, 'incoming');
  await mkdir(incomingDir, { recursive: true });
  await writeFile(join(incomingDir, 'browser_a.jsonl'), line('a-1', 'browser_a') + '\n' + line('a-2', 'browser_a') + '\n', 'utf8');
  await writeFile(join(incomingDir, 'browser_b.jsonl'), line('b-1', 'browser_b') + '\n', 'utf8');

  const busPath = join(dir, 'message_bus.jsonl');
  const writer = await BusWriter.create(busPath);
  const { appended } = await scanIncoming(incomingDir, writer);
  assert.equal(appended, 3);

  const busLines = (await readFile(busPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  const seqs = busLines.map((l) => parseBusLine(l)).map((r) => (r.ok ? r.msg.seq : undefined));
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('re-scanning the same unchanged incoming files does not duplicate entries (dedup by id)', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const incomingDir = join(dir, 'incoming');
  await mkdir(incomingDir, { recursive: true });
  await writeFile(join(incomingDir, 'browser_a.jsonl'), line('a-1', 'browser_a') + '\n', 'utf8');

  const busPath = join(dir, 'message_bus.jsonl');
  const writer = await BusWriter.create(busPath);
  await scanIncoming(incomingDir, writer);
  const second = await scanIncoming(incomingDir, writer);

  assert.equal(second.appended, 0);
  const busLines = (await readFile(busPath, 'utf8')).split('\n').filter((l) => l.length > 0);
  assert.equal(busLines.length, 1);
});

test('incoming truncate после успешного мержа: файл пуст, следующее чтение начинается с чистого листа (spec_bus_rotation)', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const incomingDir = join(dir, 'incoming');
  await mkdir(incomingDir, { recursive: true });
  const filePath = join(incomingDir, 'browser_a.jsonl');
  await writeFile(filePath, line('a-1', 'browser_a') + '\n', 'utf8');

  const writer = await BusWriter.create(join(dir, 'message_bus.jsonl'));
  await scanIncoming(incomingDir, writer);
  assert.equal(await readFile(filePath, 'utf8'), '');

  // "курсор сброшен в 0": новая запись в тот же файл после truncate мержится с нуля, не считается дублем.
  await writeFile(filePath, line('a-2', 'browser_a') + '\n', 'utf8');
  const { appended } = await scanIncoming(incomingDir, writer);
  assert.equal(appended, 1);
});
