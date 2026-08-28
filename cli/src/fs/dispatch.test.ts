// Диспетчер: все коды ошибок enum + happy path каждой операции (spec_file_access шаг 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, renderFsResult } from './dispatch.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-dispatch-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'hello\n', 'utf8');
  return root;
}

test('UNKNOWN_OP for unrecognized op', async () => {
  const root = await makeProject();
  try {
    const res = await dispatch(root, { op: 'delete', path: 'src/a.ts' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'UNKNOWN_OP');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('BAD_ARGS when required arg missing', async () => {
  const root = await makeProject();
  try {
    const res = await dispatch(root, { op: 'read' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'BAD_ARGS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PATH_ESCAPE for traversal', async () => {
  const root = await makeProject();
  try {
    const res = await dispatch(root, { op: 'read', path: '../outside.txt' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PATH_ESCAPE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FORBIDDEN_PATH for write into .git', async () => {
  const root = await makeProject();
  try {
    const res = await dispatch(root, { op: 'write', path: '.git/config', body: 'x', kind: 'code' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('NOT_FOUND for missing file', async () => {
  const root = await makeProject();
  try {
    const res = await dispatch(root, { op: 'read', path: 'src/missing.ts' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'NOT_FOUND');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AMBIGUOUS_MATCH for non-unique edit old', async () => {
  const root = await makeProject();
  try {
    await writeFile(join(root, 'dup.ts'), 'x\nx\n', 'utf8');
    const res = await dispatch(root, { op: 'edit', path: 'dup.ts', old: 'x', new: 'y' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'AMBIGUOUS_MATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FILE_TOO_LARGE for oversized read', async () => {
  const root = await makeProject();
  try {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(200_001), 'utf8');
    const res = await dispatch(root, { op: 'read', path: 'big.txt' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FILE_TOO_LARGE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('happy path for all five ops + renderFsResult shape', async () => {
  const root = await makeProject();
  try {
    const listRes = await dispatch(root, { op: 'list', path: '.', depth: '1' });
    assert.equal(listRes.ok, true);

    const searchRes = await dispatch(root, { op: 'search', query: 'hello', type: 'content' });
    assert.equal(searchRes.ok, true);

    const readRes = await dispatch(root, { op: 'read', path: 'src/a.ts' });
    assert.equal(readRes.ok, true);

    const writeRes = await dispatch(root, { op: 'write', path: 'src/b.ts', body: 'x', kind: 'test' });
    assert.equal(writeRes.ok, true);

    const editRes = await dispatch(root, { op: 'edit', path: 'src/a.ts', old: 'hello', new: 'bye' });
    assert.equal(editRes.ok, true);

    const rendered = renderFsResult(editRes);
    assert.match(rendered, /^\[FS_RESULT\]\n/);
    assert.match(rendered, /\[\/FS_RESULT\]$/);
    assert.deepEqual(JSON.parse(rendered.split('\n')[1]), editRes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
