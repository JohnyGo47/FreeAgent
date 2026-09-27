import assert from 'node:assert/strict';
import test from 'node:test';
import { sendToContent } from './tabMessaging.ts';

test('injects the content bundle and retries when an existing tab has no receiver', async () => {
  const calls: string[] = [];
  let first = true;
  const result = await sendToContent(
    {
      async sendMessage() {
        calls.push('send');
        if (first) {
          first = false;
          throw new Error('Receiving end does not exist');
        }
        return { accepted: true };
      },
    },
    {
      async executeScript() {
        calls.push('inject');
        return [];
      },
    },
    42,
    { type: 'PING' },
  );

  assert.deepEqual(calls, ['send', 'inject', 'send']);
  assert.deepEqual(result, { accepted: true });
});

test('does not inject when the content script already answers', async () => {
  let injections = 0;
  await sendToContent(
    { async sendMessage() { return { state: 'alive' }; } },
    { async executeScript() { injections += 1; return []; } },
    42,
    { type: 'PING' },
  );
  assert.equal(injections, 0);
});
