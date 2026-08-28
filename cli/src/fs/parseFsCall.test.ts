// Case-таблица parseFsCall (spec_file_access шаг 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFsCall } from './parseFsCall.ts';

test('clean call without body (list)', () => {
  const { calls } = parseFsCall('[FS | op: list | path: src | depth: 2]');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.op, 'list');
  assert.equal(calls[0].args.path, 'src');
  assert.equal(calls[0].args.depth, '2');
});

test('write body containing |, triple backticks and a tag-like line is preserved verbatim', () => {
  const text = [
    '[FS | op: write | path: src/x.ts | kind: code | end: ---FS_END---]',
    'const x = a | b;',
    '```ts',
    'not a real tag: [FS | op: read | path: y]',
    '```',
    '---FS_END---',
  ].join('\n');
  const { calls } = parseFsCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.op, 'write');
  assert.equal(
    calls[0].args.body,
    'const x = a | b;\n```ts\nnot a real tag: [FS | op: read | path: y]\n```',
  );
});

test('prose tail after end marker is not treated as a second call', () => {
  const text = [
    '[FS | op: write | path: a.ts | end: ---FS_END---]',
    'content',
    '---FS_END---',
    'Now I will wait for the result.',
  ].join('\n');
  const { calls } = parseFsCall(text);
  assert.equal(calls.length, 1);
});

test('two calls in one turn are both parsed (dispatcher decides MULTIPLE_CALLS)', () => {
  const text = '[FS | op: read | path: a.ts]\n[FS | op: read | path: b.ts]';
  const { calls } = parseFsCall(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.path, 'a.ts');
  assert.equal(calls[1].args.path, 'b.ts');
});

test('edit splits body on ---OLD---/---NEW---', () => {
  const text = [
    '[FS | op: edit | path: src/router.ts | end: ---FS_END---]',
    '---OLD---',
    '  private handlers = [];',
    '---NEW---',
    '  private handlers: Handler[] = [];',
    '---FS_END---',
  ].join('\n');
  const { calls } = parseFsCall(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.op, 'edit');
  assert.equal(calls[0].args.old, '  private handlers = [];');
  assert.equal(calls[0].args.new, '  private handlers: Handler[] = [];');
});
