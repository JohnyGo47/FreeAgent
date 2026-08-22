import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BusMessage } from '../../../shared/bus-types/index.ts';
import { NodeFsSource, BusReader } from './read.ts';

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-read-'));
}

function msg(id: string, to = 'coder1', extra: Partial<BusMessage> = {}): string {
  return JSON.stringify({
    id,
    from: 'orchestrator',
    to,
    type: 'STATUS',
    ts: '2026-08-02T14:04:22Z',
    payload: { state: 'IDLE' },
    ...extra,
  });
}

// Stops right after receiving the n-th item, without asking the generator for the
// next one — simulates a consumer that crashed mid-processing.
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

// Like collectN, but also asks for one item past the n-th before giving up — this is
// the "consumer requested the next item" signal that acks the n-th message, so its
// cursor gets persisted. Simulates normal processing (no crash). Requires an
// (n+1)-th message to already be on disk, so that extra request resolves against a
// real yield instead of blocking on a live fs-watch event — cancelling a generator
// stuck inside that wait hangs on this platform, which the ack step must avoid.
async function collectNAndAck<T>(gen: AsyncGenerator<T>, n: number, timeoutMs = 4000): Promise<T[]> {
  const results: T[] = [];
  const run = (async () => {
    for (let i = 0; i < n; i++) {
      const { value, done } = await gen.next();
      if (done) break;
      results.push(value as T);
    }
    await gen.next(); // the ack: peeks the next item, forcing the n-th item's cursor save to run
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout: got ${results.length}/${n} messages`)), timeoutMs),
  );
  try {
    await Promise.race([run, timeout]);
  } finally {
    await gen.return(undefined).catch(() => {});
  }
  return results;
}

test('reading from scratch delivers all messages in order', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, [msg('id-1'), msg('id-2'), msg('id-3')].join('\n') + '\n', 'utf8');

    const reader = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const got = await collectN(reader.messages(), 3);
    assert.deepEqual(got.map((m) => m.id), ['id-1', 'id-2', 'id-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('consumer crash mid-processing (message received, next not requested) redelivers it on restart', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, [msg('id-1'), msg('id-2'), msg('id-3')].join('\n') + '\n', 'utf8');

    const first = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const firstBatch = await collectN(first.messages(), 2); // gets id-2, never asks for the next item
    assert.deepEqual(firstBatch.map((m) => m.id), ['id-1', 'id-2']);

    // at-least-once: id-2 was never acked (no next-item request after it), so it
    // must be redelivered, not silently dropped. Dupes on redelivery are gated by
    // id dedup at the write/integration layer, not here.
    const second = new BusReader(new NodeFsSource(busPath), 'reader1', dir); // simulates restart, same reader_id
    const secondBatch = await collectN(second.messages(), 1);
    assert.deepEqual(secondBatch.map((m) => m.id), ['id-2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restarting after fully processed messages does not redeliver them', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, [msg('id-1'), msg('id-2'), msg('id-3')].join('\n') + '\n', 'utf8');

    const first = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const firstBatch = await collectNAndAck(first.messages(), 2); // acks id-2 by requesting the next item
    assert.deepEqual(firstBatch.map((m) => m.id), ['id-1', 'id-2']);

    const second = new BusReader(new NodeFsSource(busPath), 'reader1', dir); // simulates restart, same reader_id
    const secondBatch = await collectN(second.messages(), 1);
    assert.deepEqual(secondBatch.map((m) => m.id), ['id-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a broken line in the middle is skipped, following ones still delivered', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, [msg('id-1'), 'not json at all', msg('id-2')].join('\n') + '\n', 'utf8');

    const reader = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const got = await collectN(reader.messages(), 2);
    assert.deepEqual(got.map((m) => m.id), ['id-1', 'id-2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filter by "to" delivers only own messages plus broadcast', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(
      busPath,
      [msg('id-1', 'coder1'), msg('id-2', 'coder2'), msg('id-3', 'broadcast')].join('\n') + '\n',
      'utf8',
    );

    const reader = new BusReader(
      new NodeFsSource(busPath),
      'reader-coder1',
      dir,
      (m) => m.to === 'coder1' || m.to === 'broadcast',
    );
    const got = await collectN(reader.messages(), 2);
    assert.deepEqual(got.map((m) => m.id), ['id-1', 'id-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a trailing line without a newline is not delivered until the newline appears', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, msg('id-1') + '\n' + msg('id-2'), 'utf8'); // no trailing \n

    const reader = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const gen = reader.messages();
    const got = await collectN(gen, 1);
    assert.deepEqual(got.map((m) => m.id), ['id-1']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('messages written while reading are delivered', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    await writeFile(busPath, msg('id-1') + '\n', 'utf8');

    const reader = new BusReader(new NodeFsSource(busPath), 'reader1', dir);
    const gen = reader.messages();
    const pending = collectN(gen, 2);

    await new Promise((r) => setTimeout(r, 200));
    await appendFile(busPath, msg('id-2') + '\n', 'utf8');

    const got = await pending;
    assert.deepEqual(got.map((m) => m.id), ['id-1', 'id-2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
