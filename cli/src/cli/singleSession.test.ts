import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSessionLock, SessionAlreadyRunning } from './singleSession.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-session-'));
}

test('the second CLI session refuses to start with a clear error while the first one is locked', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await acquireSessionLock(dir);
  await assert.rejects(() => acquireSessionLock(dir), SessionAlreadyRunning);

  await first.release();
  const second = await acquireSessionLock(dir);
  await second.release();
});

test('lock from a dead process (non-existent pid) is reused, does not block a new session', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, '.cli.lock'), String(999999), 'utf8');

  const session = await acquireSessionLock(dir);
  await session.release();
});
