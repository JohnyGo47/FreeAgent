import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBusLine } from '../../../shared/bus-types/index.ts';
import { InstanceBusWriter } from './instanceBusWriter.ts';

// Mock FileSystemFileHandle - only that part of the contract that uses Tier 1 (spec_message_bus_write).
class FakeFileHandle {
  private content = '';

  async getFile(): Promise<{ size: number }> {
    return { size: this.content.length };
  }

  async createWritable(_opts?: { keepExistingData?: boolean }): Promise<{
    write(chunk: { type: 'write'; position: number; data: string }): Promise<void>;
    close(): Promise<void>;
  }> {
    return {
      write: async (chunk) => {
        this.content = this.content.slice(0, chunk.position) + chunk.data;
      },
      close: async () => {},
    };
  }

  read(): string {
    return this.content;
  }
}

test('Tier 1: single entry - valid JSON in file', async () => {
  const handle = new FakeFileHandle();
  const writer = new InstanceBusWriter(handle as unknown as FileSystemFileHandle);

  await writer.send({ from: 'coder1', to: 'orchestrator', type: 'READY', ts: '2026-08-02T14:04:22Z', payload: {} });

  const lines = handle.read().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = parseBusLine(lines[0]);
  assert.equal(parsed.ok, true);
});

test('Tier 1: id is set by the writer when creating (crypto.randomUUID)', async () => {
  const handle = new FakeFileHandle();
  const writer = new InstanceBusWriter(handle as unknown as FileSystemFileHandle);

  await writer.send({ from: 'coder1', to: 'orchestrator', type: 'READY', ts: '2026-08-02T14:04:22Z', payload: {} });

  const parsed = parseBusLine(handle.read().trim());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.ok(parsed.msg.id.length > 0, 'id must be set by the writer');
});

test('Tier 1: 10 consecutive send() - order preserved, no losses (no file lock)', async () => {
  const handle = new FakeFileHandle();
  const writer = new InstanceBusWriter(handle as unknown as FileSystemFileHandle);

  for (let i = 0; i < 10; i++) {
    await writer.send({ from: 'coder1', to: 'orchestrator', type: 'READY', ts: '2026-08-02T14:04:22Z', payload: { i } });
  }

  const lines = handle.read().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 10);
  const order = lines.map((l) => (JSON.parse(l) as { payload: { i: number } }).payload.i);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('Tier 1: 10 concurrent send() via Promise.all - queue serializes record, no losses', async () => {
  const handle = new FakeFileHandle();
  const writer = new InstanceBusWriter(handle as unknown as FileSystemFileHandle);

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writer.send({ from: 'coder1', to: 'orchestrator', type: 'READY', ts: '2026-08-02T14:04:22Z', payload: { i } }),
    ),
  );

  const lines = handle.read().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 10);
  for (const l of lines) assert.equal(parseBusLine(l).ok, true);
});
