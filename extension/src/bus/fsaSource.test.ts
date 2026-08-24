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

// Мок FileSystemObserver — только та часть API, что использует FsaSource.
class FakeObserver {
  static instances: FakeObserver[] = [];
  callback: () => void;
  disconnected = false;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }
  async observe(_handle: unknown): Promise<void> {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback();
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

test('with FileSystemObserver available, a fired change yields the updated content', async (t) => {
  const g = globalThis as { FileSystemObserver?: unknown };
  const prev = g.FileSystemObserver;
  g.FileSystemObserver = FakeObserver;
  t.after(() => {
    g.FileSystemObserver = prev;
  });

  const handle = new FakeFileHandle('line-one\n');
  const source = new FsaSource(handle as unknown as FileSystemFileHandle);
  const gen = source.watch();

  const first = await gen.next();
  assert.deepEqual(first.value!.linesAfter(0).map((l: BusLine) => l.text), ['line-one']);

  const secondPromise = gen.next();
  await new Promise((r) => setTimeout(r, 10)); // let the generator construct+observe before it awaits the wake signal
  handle.content += 'line-two\n';
  const observer = FakeObserver.instances.at(-1)!;
  observer.fire();

  const second = await secondPromise;
  assert.deepEqual(second.value!.linesAfter('line-one\n'.length).map((l: BusLine) => l.text), ['line-two']);
  await gen.return(undefined);
});

test('without FileSystemObserver, falls back to polling and still picks up changes', async () => {
  const g = globalThis as { FileSystemObserver?: unknown };
  const prev = g.FileSystemObserver;
  delete g.FileSystemObserver;

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
