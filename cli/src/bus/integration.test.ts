// Integration check из spec_message_bus_write / spec_message_bus_read:
// Node-скрипт пишет 5 строк в incoming/mock_instance.jsonl (эмуляция расширения, которого
// ещё нет в PR-1) → CLI мержит → читатель главной шины видит все 5 с монотонным seq.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusWriter } from './write.ts';
import { NodeFsSource, BusReader } from './read.ts';

async function collectN<T>(gen: AsyncGenerator<T>, n: number, timeoutMs = 4000): Promise<T[]> {
  const results: T[] = [];
  const collect = (async () => {
    for await (const item of gen) {
      results.push(item);
      if (results.length >= n) return;
    }
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout: got ${results.length}/${n} messages`)), timeoutMs),
  );
  try {
    await Promise.race([collect, timeout]);
  } finally {
    await gen.return(undefined).catch(() => {});
  }
  return results;
}

test('incoming -> merge -> main bus -> reader, 5 messages with monotonic seq', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freeagent-integration-'));
  try {
    const incomingDir = join(dir, 'incoming');
    await mkdir(incomingDir, { recursive: true });
    const incomingPath = join(incomingDir, 'mock_instance.jsonl');

    const mockLines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        id: `mock-${i}`,
        from: 'mock_instance',
        to: 'orchestrator',
        type: 'READY',
        ts: '2026-08-02T14:04:22Z',
        payload: {},
      }),
    );
    await writeFile(incomingPath, mockLines.join('\n') + '\n', 'utf8');

    const busPath = join(dir, 'message_bus.jsonl');
    const writer = await BusWriter.create(busPath);
    const { appended } = await writer.mergeOnce(mockLines);
    assert.equal(appended, 5);

    const reader = new BusReader(new NodeFsSource(busPath), 'integration-reader', dir);
    const got = await collectN(reader.messages(), 5);

    assert.deepEqual(
      got.map((m) => m.id),
      mockLines.map((_, i) => `mock-${i}`),
    );
    const seqs = got.map((m) => m.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
