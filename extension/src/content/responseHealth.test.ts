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

test('каждый из четырёх классов детектируется по своему признаку', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base({ text: 'oops, service is temporarily unavailable, try later' })), 'unavailable');
  assert.equal(t.classify(base({ text: 'oops, rate limit exceeded' })), 'rate_limited');
  assert.equal(t.classify(base({ text: 'error: maximum context length reached' })), 'context_full');
  assert.equal(t.classify(base({ text: 'huh', parsedMessageCount: 0 })), null); // once — not a trigger yet
  assert.equal(t.classify(base({ text: 'huh again', parsedMessageCount: 0 })), 'no_tags'); // twice in a row — trigger
});

test('no_tags: один раз — не триггер, два подряд — триггер', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base({ text: 'short', parsedMessageCount: 0 })), null);
  const healthy = t.classify(base({ text: 'a normal, healthy, tagged response' }));
  assert.equal(healthy, null);
  // после здорового ответа счётчик сброшен — следующий короткий снова не триггерит сам по себе
  assert.equal(t.classify(base({ text: 'short again', parsedMessageCount: 0 })), null);
});

test('context_full по счётчику символов треда (без паттерна в тексте)', () => {
  const t = new ResponseHealthTracker();
  const klass = t.classify(base({ text: 'ordinary text, no failure phrase', threadCharCount: 65000, contextWindow: 100000, contextThresholdPct: 60 }));
  assert.equal(klass, 'context_full');
});

test('под порогом контекста и без паттернов — здоровый ответ', () => {
  const t = new ResponseHealthTracker();
  assert.equal(t.classify(base()), null);
});
