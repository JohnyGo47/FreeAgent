import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from './init.ts';
import { STRUCTURE_FILES, STRUCTURE_DIRS } from '../../../shared/bus-structure.ts';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'freeagent-init-'));
}

test('clean folder: full structure, config with uuid, 5 built-in skills, .freeagentignore', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await runInit(dir, { noGit: true });
  assert.equal(result.alreadyInitialized, false);
  assert.match(result.projectId, /^[0-9a-f-]{36}$/);

  const freeagentDir = join(dir, 'freeagent');
  for (const f of STRUCTURE_FILES) assert.ok((await readFile(join(freeagentDir, f), 'utf8').catch(() => null)) !== null, f);
  for (const d of STRUCTURE_DIRS) assert.ok((await readdir(join(freeagentDir, d)).catch(() => null)) !== null, d);

  const config = JSON.parse(await readFile(join(freeagentDir, 'freeagent.config.json'), 'utf8'));
  assert.equal(config.project_id, result.projectId);

  const skills = await readdir(join(freeagentDir, 'skills'));
  assert.equal(skills.length, 5);
  assert.ok(skills.includes('orchestrator.md'));

  assert.ok((await readFile(join(dir, '.freeagentignore'), 'utf8').catch(() => null)) !== null);
});

test('repeat init without --force: message, nothing touched', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await runInit(dir, { noGit: true });
  const second = await runInit(dir, { noGit: true });

  assert.equal(second.alreadyInitialized, true);
  const config = JSON.parse(await readFile(join(dir, 'freeagent', 'freeagent.config.json'), 'utf8'));
  assert.equal(config.project_id, first.projectId, 'project_id unchanged — nothing was touched');
});

test('--force: config recreated with new project_id, skills untouched', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await runInit(dir, { noGit: true });
  const skillPath = join(dir, 'freeagent', 'skills', 'coder.md');
  await writeFile(skillPath, '# my edited coder role\n', 'utf8');

  const second = await runInit(dir, { noGit: true, force: true });
  assert.equal(second.alreadyInitialized, false);
  assert.notEqual(second.projectId, first.projectId);

  const config = JSON.parse(await readFile(join(dir, 'freeagent', 'freeagent.config.json'), 'utf8'));
  assert.equal(config.project_id, second.projectId);
  assert.equal(await readFile(skillPath, 'utf8'), '# my edited coder role\n');
});

test('no git, no --no-git: asks to init; confirming runs git init', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  let asked = false;
  let gitInitRan = false;
  const result = await runInit(dir, {
    confirmGitInit: async () => {
      asked = true;
      return true;
    },
    execGitInit: async () => {
      gitInitRan = true;
    },
  });

  assert.equal(asked, true);
  assert.equal(gitInitRan, true);
  assert.equal(result.gitInitialized, true);
});

// spec_git_checkpoints задача B.13: "ПОСТОЯННЫЙ warning в TUI" — не только в момент этого вызова
// init (result.checkpointsDisabledWarning), но и в следующих сессиях, поэтому config.git_checkpoints
// персистируется как false, не только возвращается в результате.
test('--no-git: warning, continues without asking, git_checkpoints:false персистируется в конфиге', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  let asked = false;
  const result = await runInit(dir, {
    noGit: true,
    confirmGitInit: async () => {
      asked = true;
      return true;
    },
  });

  assert.equal(asked, false);
  assert.equal(result.gitInitialized, false);
  assert.equal(result.checkpointsDisabledWarning, true);

  const config = JSON.parse(await readFile(join(dir, 'freeagent', 'freeagent.config.json'), 'utf8'));
  assert.equal(config.git_checkpoints, false);
});

test('.gitignore already contains /freeagent/: line is not duplicated', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n/freeagent/\n', 'utf8');

  await runInit(dir, {});

  const content = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.equal(content.split('\n').filter((l) => l === '/freeagent/').length, 1);
});

test('existing coder.md in skills: not overwritten, new skills still copied in', async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'freeagent', 'skills'), { recursive: true });
  await writeFile(join(dir, 'freeagent', 'skills', 'coder.md'), '# custom coder\n', 'utf8');

  await runInit(dir, { noGit: true });

  const skills = await readdir(join(dir, 'freeagent', 'skills'));
  assert.equal(await readFile(join(dir, 'freeagent', 'skills', 'coder.md'), 'utf8'), '# custom coder\n');
  assert.ok(skills.includes('orchestrator.md'));
  assert.equal(skills.length, 5);
});
