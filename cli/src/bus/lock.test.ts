import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from './lock.ts';

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-lock-'));
}

test('busy lock: second call waits and runs after release', async () => {
  const dir = await makeTmpDir();
  try {
    const lockPath = join(dir, 'message_bus.lock');
    const fd = await open(lockPath, 'wx'); // hold the lock manually

    const order: string[] = [];
    const waiter = withLock(lockPath, async () => {
      order.push('second');
    });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(order.length, 0, 'second call must still be waiting');

    order.push('release');
    await fd.close();
    await unlink(lockPath);

    await waiter;
    assert.deepEqual(order, ['release', 'second']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lock file is removed even if the locked function throws', async () => {
  const dir = await makeTmpDir();
  try {
    const lockPath = join(dir, 'message_bus.lock');
    await assert.rejects(
      withLock(lockPath, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    await assert.rejects(access(lockPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
