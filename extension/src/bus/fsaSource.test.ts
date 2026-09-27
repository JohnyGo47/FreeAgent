import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsaSource } from './fsaSource.ts';
import type { BusLine } from '../../../shared/bus-source.ts';

class FakeFileHandle {
  content: string;
  constructor(initial = '') {
    this.content = initial;
  }
  async getFile(): Promise<{ text(): Promise<string> }> {
    const snapshot = this.content;
    return { text: async () => snapshot };
  }
}

async function collectN<T>(gen: AsyncGenerator<T>, n: number, timeoutMs = 2000): Promise<T[]> {
  const results: T[] = [];
  const collect = (async () => {
    for await (const item of gen) {
      results.push(item);
      if (results.length >= n) return;
    }
  })();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout: got ${results.length}/${n}`)), timeoutMs),
  );
  try {
    await Promise.race([collect, timeout]);
  } finally {
    await gen.return(undefined).catch(() => {});
  }
  return results;
}

test('initial watch() yields the content already on disk', async () => {
  const handle = new FakeFileHandle('line-one\n');
  const source = new FsaSource(handle as unknown as FileSystemFileHandle);

  const [batch] = await collectN(source.watch(), 1);
  const lines = batch.linesAfter(0);
  assert.deepEqual(lines.map((l: BusLine) => l.text), ['line-one']);
});

test('polling picks up changes even if an experimental FileSystemObserver exists', async () => {
  const g = globalThis as { FileSystemObserver?: unknown };
  const prev = g.FileSystemObserver;
  g.FileSystemObserver = class BrokenObserver {};

  try {
    const handle = new FakeFileHandle('line-one\n');
    const source = new FsaSource(handle as unknown as FileSystemFileHandle, 20); // fast poll for the test
    const gen = source.watch();

    const first = await gen.next();
    assert.deepEqual(first.value!.linesAfter(0).map((l: BusLine) => l.text), ['line-one']);

    handle.content += 'line-two\n';
    const second = await gen.next();
    assert.deepEqual(second.value!.linesAfter('line-one\n'.length).map((l: BusLine) => l.text), ['line-two']);
    await gen.return(undefined);
  } finally {
    g.FileSystemObserver = prev;
  }
});
