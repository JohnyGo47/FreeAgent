import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { validateMemory } from './validateMemory.ts';

const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MEMORY_TEMPLATE.md'), 'utf8');

test('full template -> ok', () => {
  const result = validateMemory(TEMPLATE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('missing Next steps -> error naming the section', () => {
  const withoutNextSteps = TEMPLATE.replace(/## Next steps[\s\S]*?(?=## Warnings)/, '');
  const result = validateMemory(withoutNextSteps);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Next steps')));
});

test('missing Current state -> error naming the section', () => {
  const withoutCurrentState = TEMPLATE.replace(/## Current state[\s\S]*?(?=## Completed)/, '');
  const result = validateMemory(withoutCurrentState);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('Current state')));
});

test('> 4000 chars -> warning, not an error', () => {
  const long = TEMPLATE + 'x'.repeat(4001);
  const result = validateMemory(long);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('4000')));
});

test('NONE in optional sections -> ok', () => {
  const md = [
    '## Current state',
    'working on it',
    '## Completed',
    'NONE',
    '## In progress',
    'NONE',
    '## Key decisions',
    'NONE',
    '## Files touched',
    'NONE',
    '## Next steps',
    '1. continue',
    '## Warnings',
    'NONE',
  ].join('\n');
  const result = validateMemory(md);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('nested code fence deeper than one level -> warning', () => {
  const md = TEMPLATE + '\n````\n```\ninner\n```\n````\n';
  const result = validateMemory(md);
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes('nested')));
});
