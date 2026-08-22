import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOffscreenDocument, type OffscreenApi } from './ensureOffscreen.ts';

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
