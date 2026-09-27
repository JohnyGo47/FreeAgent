import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseAfterPrompt } from './responseAfterPrompt.ts';

const prompt = '[MSG | from: cli | to: coder2 | type: TASK]\n{"task_id":"86417bc8","description":"FS read extension/manifest.json"}\n[/MSG]';
const fs = '[FS | op: read | path: extension/manifest.json]';

test('finds a repeated FS response even when older turns disappeared and counts decreased', () => {
  const baseline = `old task\n${fs}\nold task\n${fs}`;
  assert.equal(responseAfterPrompt(`${prompt}\n${fs}`, baseline, prompt), fs);
});

test('ignores protocol examples in the submitted prompt and old responses', () => {
  const withExample = `${prompt}\nExample: ${fs}`;
  assert.equal(responseAfterPrompt(`${fs}\n${withExample}\nFooter`, fs, withExample), null);
  assert.equal(responseAfterPrompt(`${prompt}\n${fs}`, `${prompt}\n${fs}`, prompt), null);
});

test('matches rendered whitespace and preserves TESTS_READY plus RESULT together', () => {
  const blocks = '[MSG | to: cli | type: TESTS_READY]\n{"command":"npm test"}\n[/MSG]\n[MSG | to: orchestrator | type: RESULT]\n{"status":"DONE"}\n[/MSG]';
  assert.equal(responseAfterPrompt(`${prompt.replace(/\n/g, '\n\n')}\n${blocks}`, '', prompt), blocks);
});

test('preserves multiline FS writes and does not match a different task', () => {
  const write = '[FS | op: write | path: a.txt | end: ---END---]\nfirst\n  second\n---END---';
  assert.equal(responseAfterPrompt(`${prompt}\n${write}`, '', prompt), write);
  assert.equal(responseAfterPrompt('unrelated conversation', '', prompt), null);
});
