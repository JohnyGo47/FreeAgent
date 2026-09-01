// spec_git_checkpoints — реальный git-репозиторий во временной папке на каждый тест (не мок git,
// ГОТОВО КОГДА требует факта: git log/git show после реальных commit/add/revert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  preTaskCheckpoint,
  doneCheckpoint,
  undoCheckpoint,
  isCheckpointable,
  loadCheckpoints,
  saveCheckpoints,
  checkpointsPath,
  type CheckpointEntry,
} from './gitCheckpoints.ts';

const execFileAsync = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'freeagent-checkpoints-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'a@a.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'a'], { cwd: dir });
  await execFileAsync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }); // детерминизм на Windows
  await writeFile(join(dir, 'README.md'), 'init\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

async function log(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['log', '--format=%s'], { cwd: dir });
  return stdout.trim().split('\n');
}

async function showFiles(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['show', '--stat', '--format=', ref], { cwd: dir });
  return stdout
    .trim()
    .split('\n')
    .filter((l) => l.includes('|')) // отсекает сводную строку "N files changed, ..."
    .map((l) => l.split('|')[0].trim());
}

// --- Test 1: WRITE -> DONE -> два коммита с верными префиксами, только затронутые файлы ---

test('preTaskCheckpoint + doneCheckpoint: два реальных коммита, верные префиксы, только files шага', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const before = await preTaskCheckpoint(dir, 'task-1');
  assert.ok('hash' in before, JSON.stringify(before));

  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
  const after = await doneCheckpoint(dir, 'task-1', ['src/a.ts'], 'implemented a');
  assert.ok('hash' in after, JSON.stringify(after));

  const messages = await log(dir);
  assert.equal(messages[0], 'freeagent: task-1 — implemented a');
  assert.equal(messages[1], 'freeagent: pre-task task-1');

  const files = await showFiles(dir, (after as { hash: string }).hash);
  assert.deepEqual(files, ['src/a.ts']);
});

// --- Test 2/3: /undo (последний / по task_id) через git revert, файлы возвращаются к pre-task ---

test('undoCheckpoint: git revert реально возвращает файл к pre-task содержимому', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'x.ts'), 'v1\n', 'utf8');
  await execFileAsync('git', ['add', 'x.ts'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

  await preTaskCheckpoint(dir, 'task-1');
  await writeFile(join(dir, 'x.ts'), 'v2 broken\n', 'utf8');
  const done = await doneCheckpoint(dir, 'task-1', ['x.ts'], 'oops');
  assert.ok('hash' in done);

  const entry: CheckpointEntry = { task_id: 'task-1', files: ['x.ts'], pre_task_commit: 'x', done_commit: (done as { hash: string }).hash, ts: new Date().toISOString() };
  const outcome = await undoCheckpoint(dir, entry);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  const content = await readFile(join(dir, 'x.ts'), 'utf8');
  assert.equal(content, 'v1\n');
});

test('/undo <task_id>: из трёх задач откатывает только указанную', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const entries: CheckpointEntry[] = [];
  for (const [taskId, file, content] of [
    ['task-1', 'a.ts', 'a-done\n'],
    ['task-2', 'b.ts', 'b-done\n'],
    ['task-3', 'c.ts', 'c-done\n'],
  ] as const) {
    await preTaskCheckpoint(dir, taskId);
    await writeFile(join(dir, file), content, 'utf8');
    const done = await doneCheckpoint(dir, taskId, [file], `wrote ${file}`);
    assert.ok('hash' in done);
    entries.push({ task_id: taskId, files: [file], pre_task_commit: 'x', done_commit: (done as { hash: string }).hash, ts: new Date().toISOString() });
  }

  const target = entries.find((e) => e.task_id === 'task-2')!;
  const outcome = await undoCheckpoint(dir, target);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  assert.equal(await readFile(join(dir, 'a.ts'), 'utf8'), 'a-done\n'); // task-1 нетронута
  assert.equal(await readFile(join(dir, 'c.ts'), 'utf8'), 'c-done\n'); // task-3 нетронута
  await assert.rejects(readFile(join(dir, 'b.ts'), 'utf8')); // task-2 откачена (revert удалил файл, которого не было в pre-task)
});

test('undoCheckpoint: конфликт revert -> остановка с деталями, не резолвится автоматически', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'y.ts'), 'base\n', 'utf8');
  await execFileAsync('git', ['add', 'y.ts'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

  await preTaskCheckpoint(dir, 'task-1');
  await writeFile(join(dir, 'y.ts'), 'task-1 change\n', 'utf8');
  const done = await doneCheckpoint(dir, 'task-1', ['y.ts'], 'change y');

  // Более поздний коммит трогает ту же строку -> revert task-1 конфликтует.
  await writeFile(join(dir, 'y.ts'), 'later unrelated change\n', 'utf8');
  await execFileAsync('git', ['add', 'y.ts'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'later'], { cwd: dir });

  const entry: CheckpointEntry = { task_id: 'task-1', files: ['y.ts'], pre_task_commit: 'x', done_commit: (done as { hash: string }).hash, ts: new Date().toISOString() };
  const outcome = await undoCheckpoint(dir, entry);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.conflict, true);
    assert.match(outcome.detail, /conflict/i);
  }
  // Конфликт оставлен как есть — не резолвим автоматически (не abort, не auto-continue).
  const { stdout: status } = await execFileAsync('git', ['status', '--short'], { cwd: dir });
  assert.match(status, /y\.ts/);
});

// --- Test 4: staged-изменения пользователя не попадают в чекпоинт ---

test('staged изменения пользователя в другом файле не попадают ни в pre-task, ни в done коммит', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'user_work.ts'), 'user staged work\n', 'utf8');
  await execFileAsync('git', ['add', 'user_work.ts'], { cwd: dir });

  await preTaskCheckpoint(dir, 'task-1');
  await writeFile(join(dir, 'task_file.ts'), 'task output\n', 'utf8');
  const done = await doneCheckpoint(dir, 'task-1', ['task_file.ts'], 'wrote task file');
  assert.ok('hash' in done);

  for (const ref of ['HEAD~1', 'HEAD']) {
    const files = await showFiles(dir, ref);
    assert.equal(files.includes('user_work.ts'), false, `${ref} must not include user's staged file`);
  }
  const { stdout: status } = await execFileAsync('git', ['status', '--short'], { cwd: dir });
  assert.match(status, /A\s+user_work\.ts/); // всё ещё staged, как оставил пользователь
});

// --- Test 5: два параллельных шага -> два коммита, файлы не перемешаны ---

test('два параллельных шага (последовательные await, как в реальном mainLoop) -> два раздельных коммита', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'p.ts'), 'p\n', 'utf8');
  await writeFile(join(dir, 'q.ts'), 'q\n', 'utf8');

  // git commit одновременно из двух процессов конфликтует по .git/index.lock — реалистичная
  // модель этого репозитория (mainLoop однопоточный, RESULT обрабатываются последовательно), не
  // настоящая параллельность на уровне ОС — поэтому pre-task коммиты тоже строго
  // последовательные await, не Promise.all.
  await preTaskCheckpoint(dir, 'task-p');
  await preTaskCheckpoint(dir, 'task-q');
  const donePResult = await doneCheckpoint(dir, 'task-p', ['p.ts'], 'done p');
  const doneQResult = await doneCheckpoint(dir, 'task-q', ['q.ts'], 'done q');
  assert.ok('hash' in donePResult);
  assert.ok('hash' in doneQResult);

  const filesP = await showFiles(dir, (donePResult as { hash: string }).hash);
  const filesQ = await showFiles(dir, (doneQResult as { hash: string }).hash);
  assert.deepEqual(filesP, ['p.ts']);
  assert.deepEqual(filesQ, ['q.ts']);
});

// --- Test 7: /freeagent/ отсутствует во всех чекпоинтах ---

test('isCheckpointable: /freeagent/ и privacy-паттерны исключены (общий источник, не дублируем)', () => {
  assert.equal(isCheckpointable('freeagent/message_bus.jsonl'), false);
  assert.equal(isCheckpointable('src/auth.ts'), true);
  assert.equal(isCheckpointable('.env'), false);
  assert.equal(isCheckpointable('secrets/id_rsa'), false);
});

test('doneCheckpoint: файлы вне isCheckpointable молча пропущены при add, коммит всё равно создаётся', async (t) => {
  const dir = await gitRepo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'freeagent'), { recursive: true });
  await writeFile(join(dir, 'freeagent', 'message_bus.jsonl'), 'noise\n', 'utf8');
  await writeFile(join(dir, 'ok.ts'), 'fine\n', 'utf8');

  await preTaskCheckpoint(dir, 'task-1');
  const done = await doneCheckpoint(dir, 'task-1', ['freeagent/message_bus.jsonl', 'ok.ts'], 'mixed');
  assert.ok('hash' in done);
  const files = await showFiles(dir, (done as { hash: string }).hash);
  assert.deepEqual(files, ['ok.ts']);
});

// --- checkpoints.json load/save round-trip ---

test('checkpoints.json: load/save round-trip, отсутствующий файл -> пустой массив', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'freeagent-checkpoints-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.deepEqual(await loadCheckpoints(dir), []);

  const entries: CheckpointEntry[] = [{ task_id: 't1', files: ['a.ts'], pre_task_commit: 'h1', done_commit: 'h2', summary: 's', ts: new Date().toISOString() }];
  await saveCheckpoints(dir, entries);
  assert.deepEqual(await loadCheckpoints(dir), entries);
  assert.ok((await readFile(checkpointsPath(dir), 'utf8')).includes('t1'));
});
