// spec_context_privacy_filter (PR-7, task B): secrets do not go into the READ/tree of the free LLM.
// Real files on disk, real read()/list() - not a filter mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read } from './read.ts';
import { list } from './list.ts';

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freeagent-privacy-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://user:pass@host/db\n', 'utf8');
  await writeFile(join(root, 'secrets', 'api.key'), 'PRIVATE_KEY_MATERIAL', 'utf8');
  await writeFile(
    join(root, 'src', 'config.ts'),
    [
      'export const API_KEY = "sk-liveTestToken1234567890";',
      'export const FROM_ENV = process.env.API_KEY;',
      'export function helper() { return 1; }',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(root, 'test.env.example'), 'DATABASE_URL=your_url_here\n', 'utf8');
  return root;
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  return { warnings, restore: () => (console.warn = original) };
}

test('.env is excluded entirely from READ', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, '.env');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PRIVACY_EXCLUDED');
    assert.equal(cap.warnings.length, 1);
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('secrets/api.key excluded from READ (built-in *.key pattern)', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, 'secrets/api.key');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PRIVACY_EXCLUDED');
    assert.equal(cap.warnings.length, 1);
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('config.ts: quoted secret value masked, rest of code untouched', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, 'src/config.ts');
    assert.equal(res.ok, true);
    if (res.ok) {
      const content = (res.data as { content: string }).content;
      assert.equal(content.includes('sk-liveTestToken1234567890'), false);
      assert.match(content, /\[REDACTED/);
      assert.match(content, /export function helper\(\) \{ return 1; \}/);
    }
    assert.equal(cap.warnings.length, 1);
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('config.ts: process.env.API_KEY reference is NOT filtered', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, 'src/config.ts');
    assert.equal(res.ok, true);
    if (res.ok) {
      const content = (res.data as { content: string }).content;
      assert.match(content, /process\.env\.API_KEY/);
    }
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('.freeagentignore secrets/ hides files from READ and from list tree', async () => {
  const root = await makeProject();
  await writeFile(join(root, '.freeagentignore'), 'secrets/\n', 'utf8');
  await writeFile(join(root, 'secrets', 'plain.txt'), 'not a builtin secret pattern', 'utf8');
  const cap = captureWarnings();
  try {
    const res = await read(root, 'secrets/plain.txt');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PRIVACY_EXCLUDED');

    const tree = await list(root, '.', 2);
    assert.equal(tree.ok, true);
    if (tree.ok) {
      const treeData = (tree.data as { tree: Record<string, unknown> }).tree;
      assert.equal('secrets' in treeData, false);
    }
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('tree: .env and *.key files absent from list output without .freeagentignore', async () => {
  const root = await makeProject();
  try {
    const tree = await list(root, '.', 2);
    assert.equal(tree.ok, true);
    if (tree.ok) {
      const treeData = (tree.data as { tree: Record<string, unknown> }).tree;
      assert.equal('.env' in treeData, false);
      const rootFiles = ('.' in treeData ? (treeData['.'] as string[]) : []) as string[];
      assert.equal(rootFiles.includes('.env'), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin rules work without .freeagentignore present', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, '.env');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'PRIVACY_EXCLUDED');
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('env-like non-excluded file masks KEY=value even without a recognizable secret shape', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const res = await read(root, 'test.env.example');
    assert.equal(res.ok, true);
    if (res.ok) {
      const content = (res.data as { content: string }).content;
      assert.equal(content.includes('your_url_here'), false);
      assert.match(content, /\[REDACTED/);
    }
    assert.equal(cap.warnings.length, 1);
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('integration: 3 reads -> 3 warnings total (2 excluded, 1 masked)', async () => {
  const root = await makeProject();
  const cap = captureWarnings();
  try {
    const envRes = await read(root, '.env');
    const keyRes = await read(root, 'secrets/api.key');
    const configRes = await read(root, 'src/config.ts');

    assert.equal(envRes.ok, false);
    assert.equal(keyRes.ok, false);
    assert.equal(configRes.ok, true);
    assert.equal(cap.warnings.length, 3);
  } finally {
    cap.restore();
    await rm(root, { recursive: true, force: true });
  }
});
