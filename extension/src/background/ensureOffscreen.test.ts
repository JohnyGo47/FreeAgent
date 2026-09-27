import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOffscreenDocument, sendWhenReady, type OffscreenApi } from './ensureOffscreen.ts';

function fakeOffscreen(initiallyExists: boolean): OffscreenApi & { createCalls: number } {
  let exists = initiallyExists;
  return {
    createCalls: 0,
    async hasDocument() {
      return exists;
    },
    async createDocument() {
      this.createCalls += 1;
      exists = true;
    },
  };
}

test('creates the offscreen document when none exists', async () => {
  const api = fakeOffscreen(false);
  await ensureOffscreenDocument(api);
  assert.equal(api.createCalls, 1);
});

test('repeated calls do not duplicate an existing document', async () => {
  const api = fakeOffscreen(false);
  await ensureOffscreenDocument(api);
  await ensureOffscreenDocument(api);
  await ensureOffscreenDocument(api);
  assert.equal(api.createCalls, 1);
});

test('does nothing when the document already existed', async () => {
  const api = fakeOffscreen(true);
  await ensureOffscreenDocument(api);
  assert.equal(api.createCalls, 0);
});

test('uses runtime contexts when Chrome has no offscreen.hasDocument', async () => {
  let createCalls = 0;
  await ensureOffscreenDocument(
    { async createDocument() { createCalls += 1; } },
    {
      getURL: (path) => `chrome-extension://test/${path}`,
      async getContexts(filter) {
        assert.deepEqual(filter, {
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: ['chrome-extension://test/offscreen.html'],
        });
        return [{}];
      },
    },
  );
  assert.equal(createCalls, 0);
});

test('retries messages while a newly created offscreen document starts', async () => {
  let calls = 0;
  const result = await sendWhenReady(async () => {
    calls += 1;
    if (calls < 3) throw new Error('Receiving end does not exist');
    return { ok: true };
  }, 3, 0);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});
