// Tier 2 (CLI merge → main bus) is the only PR-1 coverage.
// Tier 1 (offscreen extension writer) moved to PR-2 according to ROADMAP.md
//("PR-2 - Extension framework: ... message_bus_write Tier 1 ...");
// the extension does not yet exist in PR-1 (the integration check in the spec directly stipulates this).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { BusWriter } from './write.ts';

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-write-'));
}

function line(id: string, from = 'coder1', to = 'orchestrator'): string {
  return JSON.stringify({
    id,
    from,
    to,
    type: 'STATUS',
    ts: '2026-08-02T14:04:22Z',
    payload: { state: 'IDLE' },
  });
}

async function readBusLines(busPath: string): Promise<string[]> {
  const content = await readFile(busPath, 'utf8').catch(() => '');
  return content.split('\n').filter((l) => l.length > 0);
}

test('merge from several incoming sources: all messages land in main bus, seq monotonic', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const writer = await BusWriter.create(busPath);

    await writer.mergeOnce([line('id-1'), line('id-2')]);
    await writer.mergeOnce([line('id-3')]);

    const lines = await readBusLines(busPath);
    assert.equal(lines.length, 3);
    const seqs = lines.map((l) => parseBusLine(l)).map((r) => (r.ok ? r.msg.seq : undefined));
    assert.deepEqual(seqs, [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('10 concurrent merges via Promise.all: no dupes, no broken lines', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const writer = await BusWriter.create(busPath);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writer.mergeOnce([line(`concurrent-${i}`)])),
    );

    const lines = await readBusLines(busPath);
    assert.equal(lines.length, 10);
    const parsedSeqs = new Set<number>();
    for (const l of lines) {
      const result = parseBusLine(l);
      assert.equal(result.ok, true, `line should parse: ${l}`);
      if (result.ok && result.msg.seq !== undefined) parsedSeqs.add(result.msg.seq);
    }
    assert.equal(parsedSeqs.size, 10, 'seq values must be unique');
    assert.deepEqual([...parsedSeqs].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seq restoration: restart with non-empty bus continues from max + 1', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const seed = [
      { ...JSON.parse(line('seed-1')), seq: 1 },
      { ...JSON.parse(line('seed-2')), seq: 2 },
      { ...JSON.parse(line('seed-3')), seq: 3 },
    ];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(busPath, seed.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

    const writer = await BusWriter.create(busPath); // simulates CLI restart
    await writer.mergeOnce([line('after-restart')]);

    const lines = await readBusLines(busPath);
    assert.equal(lines.length, 4);
    const last = parseBusLine(lines[3]);
    assert.equal(last.ok, true);
    if (last.ok) assert.equal(last.msg.seq, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two live writers cannot assign the same seq', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const first = await BusWriter.create(busPath);
    const second = await BusWriter.create(busPath);

    await first.mergeOnce([line('first-writer')]);
    await second.mergeOnce([line('second-writer')]);

    const lines = await readBusLines(busPath);
    const seqs = lines.map((l) => parseBusLine(l)).map((r) => (r.ok ? r.msg.seq : undefined));
    assert.deepEqual(seqs, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dedup by id: two incoming lines with the same id merge to one', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const writer = await BusWriter.create(busPath);

    await writer.mergeOnce([line('dup-id'), line('dup-id')]);

    const lines = await readBusLines(busPath);
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dedup survives CLI restart: id already in bus tail is not re-merged', async () => {
  const dir = await makeTmpDir();
  try {
    const busPath = join(dir, 'message_bus.jsonl');
    const first = await BusWriter.create(busPath);
    await first.mergeOnce([line('persisted-id')]);

    const secondAfterRestart = await BusWriter.create(busPath);
    await secondAfterRestart.mergeOnce([line('persisted-id')]);

    const lines = await readBusLines(busPath);
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
