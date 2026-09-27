// Main loop, step 1 (spec_cli): merge incoming/*.jsonl → message_bus.jsonl.
import { readdir, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import type { BusWriter } from '../bus/write.ts';

export async function scanIncoming(incomingDir: string, writer: BusWriter): Promise<{ appended: number }> {
  const files = await readdir(incomingDir).catch(() => [] as string[]);
  let appended = 0;
  for (const file of files.sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = join(incomingDir, file);
    const content = await readFile(filePath, 'utf8').catch(() => '');
    const lines = content.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const result = await writer.mergeOnce(lines);
    appended += result.appended;
    // incoming is not rotated (spec_bus_rotation): CLI has already read and merged the contents into the main one
    // bus, truncate is safe - resets the "cursor" (line number) of the next read to 0.
    await truncate(filePath, 0).catch(() => {});
  }
  return { appended };
}
