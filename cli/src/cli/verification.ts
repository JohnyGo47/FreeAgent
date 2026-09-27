// CLI establishes the fact by running tests, does not believe RESULT: DONE at its word (spec_verification,
// ARCHITECTURE §9). Design note (spec): verification does NOT know about the plan - accepts the task/tests,
// returns verdict; who called (plan_execution) is none of her business, there is no inverse relationship.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Whitelist (task A.2): checked by tokens (argv[0]/argv[1]), not by raw string -
// "their arguments" are resolved and move on untouched. On POSIX, injection protection is structural:
// spawn with shell:false and argv array - `;`/`&&`/backticks are never interpreted by the shell,
// whatever the string is. On Windows shell is required for .cmd (see SAFE_ARG_RE below) - there
// protection is not structural, but through a refusal on any unsafe argument symbol.
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

// Simplified tokenizer: spaces + "..."/'...' without escaping inside. Test commands almost
// always without spaces in paths; full-fledged shell-lexer - beyond what's needed here
// (ponytail: add if you really need a command with a space in the path).
function tokenize(command: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Windows cannot execute .cmd/.bat (npm/pnpm/yarn/local jest.cmd) without shell participation
// (empirically confirmed: spawn('npm.cmd', ..., {shell:false}) -> EINVAL). Therefore on win32
// runCommand calls spawn with shell: true - and Node itself warns: "arguments are not escaped,
// only concatenated" (real injection vector via &/|/^, etc.). We close it without escaping
// (this is exactly the kind of subtle code where it’s easy to make a mistake), but by default: each argument token must
// consist only of "safe" characters, otherwise the entire ERROR command even before spawn - on any OS,
// not only Windows (defense-in-depth). Legitimate testrunner commands (paths, flags, `--`,
// test names without spaces) this is enough; spaces within one argument and real
// shell metacharacters are simply not skipped, not "neatly escaped".
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

// The type matches node:child_process.spawn - tests replace it with a mock, production calls the real one.
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; timeout: number; killSignal: NodeJS.Signals; detached?: boolean },
) => ChildProcess;

// Kills the process tree, not just the direct descendant. On win32 shell:true wraps
// executable .cmd in cmd.exe - proc.pid then PID of cmd.exe, not the testrunner under it; native
// spawn({timeout}) kills only it, the real process continues to live (empirically tested:
// without taskkill /T the test "long process" experiences its timeout). taskkill /T kills everything
// tree. On POSIX process.kill(-pid) kills a group of processes (detached:true below does proc
// leader of his group).
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
    // shell:true only on win32 - the only way to execute .cmd/.bat (npm, etc.), see
    // comment from SAFE_ARG_RE about how this is compensated. On POSIX shell:false as before.
    // detached:true (POSIX) makes proc the leader of its own process group - killTree is needed.
    let proc: ChildProcess;
    try {
      proc = spawnFn(argv[0], argv.slice(1), {
        cwd,
        shell: process.platform === 'win32',
        timeout: 0, // timeout is yours, below: native timeout does not finish the process tree on win32
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

// Verifying test names (task A.5): naive substring comparison - enough to "warn"
// not for accurately parsing the output of 8 different test runners (jest/pytest/go test print names
// differently). Discrepancy - warning, does not block (spec constraint).
export interface TestNameComparison {
  ok: boolean;
  warning?: string;
}

export function compareTestNames(stdout: string, expectedNames: string[]): TestNameComparison {
  const missing = expectedNames.filter((name) => !stdout.includes(name));
  if (missing.length === 0) return { ok: true };
  return { ok: false, warning: `test names are inconsistent with the spec, not found in the output: ${missing.join(', ')}` };
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
  command?: string; // absent -> unverified (task A.4, “the first step of any spec”)
  cwd:string; // project directory (fsRoot)
  timeoutMs: number;
  logsDir: string;
  writtenFiles?: string[]; // files that the agent actually wrote during this step are checked
  // to exist until any TESTS_READY (adaptation of "WRITE declared, no file" under
  // the architecture of this repository: the CLI itself writes files via FS_CALL, the agent cannot “claim”
  // write without the CLI doing it - but the file could theoretically disappear between writes
  // and verification; the check catches exactly this, and not the agent’s hypothetical lie)
  expectedTestNames?: string[]; // Tests section from the task spec - name matching (task A.5).
  // Nothing in the current plan (PlanStep) carries a link to the spec/expected names - the source of these
  // there is no data in the transaction yet (PlanStep = {step_id,agent_id,description,files,depends_on}, without
  // fields for spec). compareTestNames is implemented and tested independently; here is the parameter
  // remains unconnected until such a source appears - this is NOT a silent pass, the problem is obvious.
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
