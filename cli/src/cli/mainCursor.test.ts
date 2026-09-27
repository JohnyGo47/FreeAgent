import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMainCursor, saveMainCursor } from './mainCursor.ts';

test('main cursor survives a CLI restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freeagent-main-cursor-'));
  try {
    assert.equal(await loadMainCursor(dir), 0);
    await saveMainCursor(dir, 42);
    assert.equal(await loadMainCursor(dir), 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
