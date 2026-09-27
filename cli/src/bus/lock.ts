import { open, unlink } from 'node:fs/promises';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// fs.open(path, 'wx') - atomic exclusive creation at the OS level (ARCHITECTURE §4, spec_message_bus_write)
export async function withLock(lockPath: string, fn: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    let fd;
    try {
      fd = await open(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await sleep(50);
      continue;
    }
    await fd.close();
    try {
      await fn();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
    return;
  }
  throw new Error('bus lock timeout 1500ms');
}
