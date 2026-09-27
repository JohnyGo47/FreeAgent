import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseHealthTracker, type FailurePatterns } from './responseHealth.ts';

const patterns: FailurePatterns = {
  unavailable: ['service is temporarily unavailable'],
  rate_limited: ['rate limit exceeded'],
  context_full: ['maximum context length'],
};

function base(overrides: Partial<Parameters<ResponseHealthTracker['classify']>[0]> = {}) {
  return {
    text: 'a normal, healthy, tagged response',
    parsedMessageCount: 1,
    patterns,
    threadCharCount: 1000,
    contextWindow: 100000,
    contextThresholdPct: 60,
    ...overrides,
  };
}

test('each of the four classes is detected according to its own characteristic', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base({ text: 'oops, service is temporarily unavailable, try later' })), 'unavailable');
  assert.equal(t.classify(base({ text: 'oops, rate limit exceeded' })), 'rate_limited');
  assert.equal(t.classify(base({ text: 'error: maximum context length reached' })), 'context_full');
  assert.equal(t.classify(base({ text: 'huh', parsedMessageCount: 0 })), null); // once — not a trigger yet
  assert.equal(t.classify(base({ text: 'huh again', parsedMessageCount: 0 })), 'no_tags'); // twice in a row — trigger
});

test('no_tags: once is not a trigger, twice in a row is a trigger', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base({ text: 'short', parsedMessageCount: 0 })), null);
  const healthy = t.classify(base({ text: 'a normal, healthy, tagged response' }));
  assert.equal(healthy, null);
  // after a healthy response the counter is reset - the next short one again does not trigger on its own
  assert.equal(t.classify(base({ text: 'short again', parsedMessageCount: 0 })), null);
});

test('context_full by thread character counter (without a pattern in the text)', () => {
  const t = new ResponseHealthTracker();
  const klass = t.classify(base({ text: 'ordinary text, no failure phrase', threadCharCount: 65000, contextWindow: 100000, contextThresholdPct: 60 }));
  assert.equal(klass, 'context_full');
});

test('under the context threshold and without patterns is a healthy answer', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base()), null);
});
