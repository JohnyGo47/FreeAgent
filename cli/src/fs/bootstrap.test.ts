import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBootstrapTree, bootstrapInjectionText } from './bootstrap.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-bootstrap-'));
  await mkdir(join(root, 'src', 'bus'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'src', 'bus', 'router.ts'), 'x', 'utf8');
  await writeFile(join(root, 'node_modules', 'noise.js'), 'x', 'utf8');
  return root;
}

test('bootstrap tree reaches real paths depth 2-3, junk filtered', async () => {
  const root = await makeProject();
  try {
    const res = await buildBootstrapTree(root);
    assert.equal(res.ok, true);
    if (res.ok) {
      const tree = (res.data as { tree: Record<string, unknown> }).tree;
      assert.equal('node_modules' in tree, false);
      assert.ok('src' in tree);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrapInjectionText wraps as [FS_RESULT]', async () => {
  const root = await makeProject();
  try {
    const text = await bootstrapInjectionText(root);
    assert.match(text, /^\[FS_RESULT\]\n/);
    assert.match(text, /\[\/FS_RESULT\]$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
