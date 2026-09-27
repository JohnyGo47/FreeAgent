import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_NAME = 'cli-main.json';

export async function loadMainCursor(freeagentDir: string): Promise<number> {
  const raw = await readFile(join(freeagentDir, 'cursors', FILE_NAME), 'utf8').catch(() => '');
  if (!raw) return 0;
  try {
    const value = JSON.parse(raw) as { seq?: unknown };
    return typeof value.seq === 'number' && value.seq >= 0 ? value.seq : 0;
  } catch {
    return 0;
  }
}

export async function saveMainCursor(freeagentDir: string, seq: number): Promise<void> {
  const dir = join(freeagentDir, 'cursors');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE_NAME), JSON.stringify({ seq }) + '\n', 'utf8');
}
