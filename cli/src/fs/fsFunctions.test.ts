// Ручной прогон пяти fs.*-функций на реальной ФС (spec_file_access, порядок реализации шаг 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read } from './read.ts';
import { list } from './list.ts';
import { search } from './search.ts';
import { write } from './write.ts';
import { edit } from './edit.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-fs-'));
  await mkdir(join(root, 'src', 'bus'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(root, 'src', 'bus', 'router.ts'), 'export class MessageBus {\n  private handlers = [];\n}\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'noise', 'utf8');
  await writeFile(join(root, '.env'), 'SECRET=1', 'utf8');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '', 'utf8');
  return root;
}

test('read: valid path returns content', async () => {
  const root = await makeProject();
  try {
    const res = await read(root, 'src/bus/router.ts');
    assert.equal(res.ok, true);
    if (res.ok) assert.match((res.data as { content: string }).content, /MessageBus/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read: traversal escape rejected', async () => {
  const root = await makeProject();
  try {
    const res = await read(root, '../../etc/passwd');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PATH_ESCAPE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read: absolute path rejected as PATH_ESCAPE', async () => {
  const root = await makeProject();
  try {
    const res = await read(root, '/etc/passwd');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PATH_ESCAPE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write/edit into protected path -> FORBIDDEN_PATH, file untouched', async () => {
  const root = await makeProject();
  try {
    const w = await write(root, '.git/config', 'evil', 'code');
    assert.equal(w.ok, false);
    if (!w.ok) assert.equal(w.error.code, 'FORBIDDEN_PATH');

    const e = await edit(root, '.env', 'SECRET=1', 'SECRET=2');
    assert.equal(e.ok, false);
    if (!e.ok) assert.equal(e.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list: filters node_modules/.git, depth respected', async () => {
  const root = await makeProject();
  try {
    const res = await list(root, '.', 1);
    assert.equal(res.ok, true);
    if (res.ok) {
      const tree = (res.data as { tree: Record<string, unknown> }).tree;
      assert.equal('node_modules' in tree, false);
      assert.equal('.git' in tree, false);
      assert.ok('src' in tree);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('search: content finds line + reason', async () => {
  const root = await makeProject();
  try {
    const res = await search(root, 'class MessageBus', 'content', 'src');
    assert.equal(res.ok, true);
    if (res.ok) {
      const results = (res.data as { results: { path: string; matches: { line: number }[] }[] }).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].path, 'src/bus/router.ts');
      assert.equal(results[0].matches[0].line, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write: new file then overwrite reports created correctly', async () => {
  const root = await makeProject();
  try {
    const first = await write(root, 'src/new.ts', 'export const a = 1;\n', 'code');
    assert.equal(first.ok, true);
    if (first.ok) assert.equal((first.data as { created: boolean }).created, true);

    const second = await write(root, 'src/new.ts', 'export const a = 2;\n', 'code');
    assert.equal(second.ok, true);
    if (second.ok) assert.equal((second.data as { created: boolean }).created, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit: unique old -> replaced; ambiguous -> AMBIGUOUS_MATCH', async () => {
  const root = await makeProject();
  try {
    const ok = await edit(root, 'src/bus/router.ts', '  private handlers = [];', '  private handlers: Handler[] = [];');
    assert.equal(ok.ok, true);

    await writeFile(join(root, 'dup.ts'), 'x\nx\n', 'utf8');
    const ambiguous = await edit(root, 'dup.ts', 'x', 'y');
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.equal(ambiguous.error.code, 'AMBIGUOUS_MATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
