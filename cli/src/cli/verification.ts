// CLI устанавливает факт запуском тестов, не верит RESULT: DONE на слово (spec_verification,
// ARCHITECTURE §9). Design note (spec): verification НЕ знает про план — принимает задачу/тесты,
// возвращает вердикт; кто позвал (plan_execution) — не её дело, обратной зависимости нет.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Белый список (задача A.2): проверяется по токенам (argv[0]/argv[1]), не по сырой строке —
// "их аргументы" разрешены и идут дальше нетронутыми. На POSIX защита от инъекции структурная:
// spawn с shell:false и argv-массивом — `;`/`&&`/бэктики никогда не интерпретируются шеллом,
// какой бы ни была строка. На Windows shell обязателен для .cmd (см. SAFE_ARG_RE ниже) — там
// защита не структурная, а через отказ на любом небезопасном символе аргумента.
const ALLOW_RULES: ((argv: string[]) => boolean)[] = [
  (a) => a[0] === 'npm' && a[1] === 'test',
  (a) => a[0] === 'npm' && a[1] === 'run' && /^test:[\w-]+$/.test(a[2] ?? ''),
  (a) => a[0] === 'pnpm' && a[1] === 'test',
  (a) => a[0] === 'yarn' && a[1] === 'test',
  (a) => a[0] === 'pytest',
  (a) => a[0] === 'go' && a[1] === 'test',
  (a) => a[0] === 'cargo' && a[1] === 'test',
  (a) => a[0] === 'jest',
  (a) => a[0] === 'vitest',
];

// Упрощённый токенайзер: пробелы + "..."/'...' без экранирования внутри. Тестовые команды почти
// всегда без пробелов в путях; полноценный shell-lexer — за рамками того, что здесь нужно
// (ponytail: добавить, если реально понадобится команда с пробелом в пути).
function tokenize(command: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Windows не умеет исполнять .cmd/.bat (npm/pnpm/yarn/локальные jest.cmd) без участия shell
// (подтверждено эмпирически: spawn('npm.cmd', ..., {shell:false}) -> EINVAL). Поэтому на win32
// runCommand зовёт spawn с shell:true — а Node сам предупреждает: "arguments are not escaped,
// only concatenated" (реальный вектор инъекции через &/|/^ и т.п.). Закрываем его не экранированием
// (это как раз тот тонкий код, где легко ошибиться), а отказом: каждый токен аргумента обязан
// состоять только из "безопасных" символов, иначе вся команда ERROR ещё до spawn — на любой ОС,
// не только Windows (defense-in-depth). Легитимным командам тестраннера (пути, флаги, `--`,
// имена тестов без пробелов) этого достаточно; пробелы внутри одного аргумента и настоящие
// shell-метасимволы просто не пропускаются, а не "аккуратно экранируются".
const SAFE_ARG_RE = /^[\w.\-/:@=+,]+$/;

export interface AllowedCommandCheck {
  allowed: boolean;
  argv: string[];
}

export function checkAllowedCommand(command: string): AllowedCommandCheck {
  const argv = tokenize(command.trim());
  const knownBinary = argv.length > 0 && ALLOW_RULES.some((rule) => rule(argv));
  const argsSafe = argv.every((tok) => SAFE_ARG_RE.test(tok));
  return { allowed: knownBinary && argsSafe, argv };
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Тип совпадает с node:child_process.spawn — тесты подменяют её моком, продакшен зовёт настоящую.
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; timeout: number; killSignal: NodeJS.Signals; detached?: boolean },
) => ChildProcess;

// Убивает дерево процессов, не только прямого потомка. На win32 shell:true оборачивает
// исполняемый .cmd в cmd.exe — proc.pid тогда PID cmd.exe, а не тестраннера под ним; native
// spawn({timeout}) убивает только его, реальный процесс продолжает жить (проверено эмпирически:
// без taskkill /T тестовый "долгий процесс" переживает свой таймаут). taskkill /T убивает всё
// дерево. На POSIX process.kill(-pid) убивает группу процессов (detached:true ниже делает proc
// лидером своей группы).
async function killTree(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(proc.pid), '/T', '/F']).catch(() => {});
  } else {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

export async function runCommand(argv: string[], cwd: string, timeoutMs: number, spawnFn: SpawnFn = spawn): Promise<RunResult> {
  return new Promise((resolve) => {
    // shell:true только на win32 — единственный способ исполнить .cmd/.bat (npm и т.п.), см.
    // комментарий у SAFE_ARG_RE про то, чем это компенсируется. На POSIX shell:false как и раньше.
    // detached:true (POSIX) делает proc лидером собственной группы процессов — нужно killTree.
    let proc: ChildProcess;
    try {
      proc = spawnFn(argv[0], argv.slice(1), {
        cwd,
        shell: process.platform === 'win32',
        timeout: 0, // таймаут — свой, ниже: native timeout не добивает дерево процессов на win32
        killSignal: 'SIGKILL',
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: String(err instanceof Error ? err.message : err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(proc);
    }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer | string) => (stdout += String(d)));
    proc.stderr?.on('data', (d: Buffer | string) => (stderr += String(d)));
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut: timedOut || (code === null && signal !== null) });
    });
  });
}

// Сверка имён тестов (задача A.5): наивное substring-сравнение — достаточно для "предупредить",
// не для точного парсинга вывода 8 разных test runner'ов (jest/pytest/go test печатают имена
// по-разному). Расхождение — warning, не блокирует (spec constraint).
export interface TestNameComparison {
  ok: boolean;
  warning?: string;
}

export function compareTestNames(stdout: string, expectedNames: string[]): TestNameComparison {
  const missing = expectedNames.filter((name) => !stdout.includes(name));
  if (missing.length === 0) return { ok: true };
  return { ok: false, warning: `имена тестов расходятся со спекой, не найдены в выводе: ${missing.join(', ')}` };
}

async function writeRunLog(logsDir: string, taskId: string, command: string, result: RunResult): Promise<string> {
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  const path = join(logsDir, `verify-${taskId}-${Date.now()}.log`);
  const body = [
    `task_id: ${taskId}`,
    `command: ${command}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
    '',
  ].join('\n');
  await appendFile(path, body, 'utf8');
  return path;
}

export interface VerifyParams {
  taskId: string;
  command?: string; // отсутствует -> unverified (задача A.4, "первый шаг любой спеки")
  cwd: string; // директория проекта (fsRoot)
  timeoutMs: number;
  logsDir: string;
  writtenFiles?: string[]; // файлы, которые агент реально записал за этот шаг — проверяются
  // на существование до всякого TESTS_READY (адаптация "WRITE заявлен, файла нет" под
  // архитектуру этого репозитория: CLI сам пишет файлы через FS_CALL, агент не может "заявить"
  // запись без того, чтобы CLI её выполнил — но файл теоретически может пропасть между записью
  // и верификацией; проверка ловит именно это, а не гипотетическую ложь агента)
  expectedTestNames?: string[]; // раздел Tests из спеки задачи — сверка имён (задача A.5).
  // Ничто в текущем плане (PlanStep) не несёт ссылку на спеку/ожидаемые имена — источника этих
  // данных пока нет в проводке (PlanStep = {step_id,agent_id,description,files,depends_on}, без
  // поля под спеку). compareTestNames реализована и протестирована независимо; здесь параметр
  // остаётся неподключённым до появления такого источника — это НЕ тихий пропуск, задел явный.
  runCommandFn?: typeof runCommand;
  spawnFn?: SpawnFn;
}

export type VerifyVerdict =
  | { kind: 'unverified' }
  | { kind: 'ok'; log: string; testNameWarning?: string }
  | { kind: 'failed'; reason: string; log?: string; testNameWarning?: string }
  | { kind: 'rejected'; reason: string };

export async function verifyStep(params: VerifyParams): Promise<VerifyVerdict> {
  for (const f of params.writtenFiles ?? []) {
    const exists = await stat(join(params.cwd, f)).then(() => true).catch(() => false);
    if (!exists) return { kind: 'failed', reason: `claimed WRITE but file is missing on disk: ${f}` };
  }

  if (!params.command) return { kind: 'unverified' };

  const { allowed, argv } = checkAllowedCommand(params.command);
  if (!allowed) return { kind: 'rejected', reason: `command not in whitelist: ${params.command}` };

  const run = params.runCommandFn ?? ((a, cwd, timeout) => runCommand(a, cwd, timeout, params.spawnFn));
  const result = await run(argv, params.cwd, params.timeoutMs);
  const log = await writeRunLog(params.logsDir, params.taskId, params.command, result);

  const testNameWarning = params.expectedTestNames?.length ? compareTestNames(result.stdout, params.expectedTestNames).warning : undefined;

  if (result.timedOut) return { kind: 'failed', reason: `test command timed out after ${params.timeoutMs}ms, process killed`, log, testNameWarning };
  if (result.exitCode !== 0) return { kind: 'failed', reason: result.stderr.trim() || `exit code ${result.exitCode}`, log, testNameWarning };
  return { kind: 'ok', log, testNameWarning };
}
