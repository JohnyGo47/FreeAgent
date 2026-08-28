// End-to-end без LLM: играешь модель руками (spec_file_access шаг 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFsTurn } from './pipeline.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-pipeline-'));
  await mkdir(join(root, 'src', 'bus'), { recursive: true });
  await writeFile(join(root, 'src', 'bus', 'router.ts'), 'export class MessageBus {\n  private handlers = [];\n}\n', 'utf8');
  return root;
}

test('round trip: search -> read -> edit, full text through pipeline', async () => {
  const root = await makeProject();
  try {
    const searchTurn = await runFsTurn(root, 'thinking...\n[FS | op: search | query: class MessageBus | type: content | path: src]');
    assert.equal(searchTurn.results[0].ok, true);
    assert.match(searchTurn.rendered[0], /\[FS_RESULT\]/);

    const readTurn = await runFsTurn(root, '[FS | op: read | path: src/bus/router.ts]');
    assert.equal(readTurn.results[0].ok, true);
    if (readTurn.results[0].ok) {
      assert.match((readTurn.results[0].data as { content: string }).content, /MessageBus/);
    }

    const editText = [
      '[FS | op: edit | path: src/bus/router.ts | end: ---FS_END---]',
      '---OLD---',
      '  private handlers = [];',
      '---NEW---',
      '  private handlers: Handler[] = [];',
      '---FS_END---',
    ].join('\n');
    const editTurn = await runFsTurn(root, editText);
    assert.equal(editTurn.results[0].ok, true);

    const verify = await runFsTurn(root, '[FS | op: read | path: src/bus/router.ts]');
    if (verify.results[0].ok) {
      assert.match((verify.results[0].data as { content: string }).content, /Handler\[\]/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no [FS] call -> hasCall false', async () => {
  const root = await makeProject();
  try {
    const turn = await runFsTurn(root, 'just thinking out loud, no call here');
    assert.equal(turn.hasCall, false);
    assert.deepEqual(turn.results, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two calls in one turn -> first executed, second is MULTIPLE_CALLS', async () => {
  const root = await makeProject();
  try {
    const turn = await runFsTurn(root, '[FS | op: read | path: src/bus/router.ts]\n[FS | op: read | path: src/bus/router.ts]');
    assert.equal(turn.results.length, 2);
    assert.equal(turn.results[0].ok, true);
    assert.equal(turn.results[1].ok, false);
    if (!turn.results[1].ok) assert.equal(turn.results[1].error.code, 'MULTIPLE_CALLS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
