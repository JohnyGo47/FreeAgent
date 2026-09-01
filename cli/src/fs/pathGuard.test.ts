// Новое поведение PR-7 (spec_write_path_validation A): паттерн-матчинг защищённых путей
// (расширяет PROTECTED_SEGMENTS из PR-4), симлинк-эскейп, Windows case-insensitive префикс.
// Базовые traversal/.git/.env кейсы уже покрыты fsFunctions.test.ts — здесь только новое.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWritePath } from './pathGuard.ts';
import { write } from './write.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-pathguard-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true });
  return root;
}

test('write: .env.local rejected (pattern, not exact match)', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, '.env.local', 'X=1', 'code');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write: *.pem rejected regardless of directory', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, 'secrets/server.pem', '-----BEGIN-----', 'code');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write: id_rsa* rejected', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, 'secrets/id_rsa', 'PRIVATE', 'code');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write: node_modules/ rejected (new segment vs PR-4)', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, 'node_modules/pkg/index.js', 'evil', 'code');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'FORBIDDEN_PATH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write: normal src file still accepted', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, 'src/auth.ts', 'export {}', 'code');
    assert.equal(res.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symlink pointing outside root is rejected via realpath', async (t) => {
  const root = await makeProject();
  try {
    const outside = await mkdtemp(join(tmpdir(), 'freeagent-outside-'));
    try {
      await symlink(outside, join(root, 'escape'), 'dir');
    } catch (err) {
      t.skip(`cannot create symlink on this platform/permissions: ${String(err)}`);
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const res = await validateWritePath(root, 'escape/pwned.txt');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.error.code, 'PATH_ESCAPE');
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('error message does not leak the absolute project root', async () => {
  const root = await makeProject();
  try {
    const res = await write(root, '.env.local', 'X=1', 'code');
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.message.includes(root), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

if (process.platform === 'win32') {
  test('windows: case-insensitive prefix still accepted for write', async () => {
    const root = await makeProject();
    try {
      const res = await write(root, 'SRC\\Auth.ts', 'export {}', 'code');
      assert.equal(res.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
