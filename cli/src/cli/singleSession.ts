// One CLI session per project - the only writer of the main bus and registry (spec_cli constraint).
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class SessionAlreadyRunning extends Error {
  constructor(pid: number) {
    super(`another freeagent CLI session is already running for this project (pid ${pid})`);
    this.name = 'SessionAlreadyRunning';
  }
}

export interface SessionLock {
  release(): Promise<void>;
}

function lockPath(freeagentDir: string): string {
  return join(freeagentDir, '.cli.lock');
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireSessionLock(freeagentDir: string): Promise<SessionLock> {
  const path = lockPath(freeagentDir);
  try {
    const fd = await open(path, 'wx');
    await fd.write(String(process.pid));
    await fd.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    const existingPid = Number((await readFile(path, 'utf8').catch(() => '')).trim());
    if (Number.isInteger(existingPid) && isRunning(existingPid)) {
      throw new SessionAlreadyRunning(existingPid);
    }
    // Lock from a process that no longer exists - let's reuse it.
    await writeFile(path, String(process.pid), 'utf8');
  }

  return {
    async release() {
      await unlink(path).catch(() => {});
    },
  };
}
