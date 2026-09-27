import { appendFile, readFile } from 'node:fs/promises';
import { parseBusLine, type BusMessage } from '../../../shared/bus-types/index.ts';
import { log } from '../../../shared/log.ts';
import { withLock } from './lock.ts';

// ponytail: dedup by last N id, and not by the entire file - bus rotation (spec_bus_rotation) will reconsider storage as the file grows
const DEDUP_TAIL_SIZE = 1000;

async function readBusTail(busPath: string): Promise<{ nextSeq: number; recentIds: Set<string> }> {
  const content = await readFile(busPath, 'utf8').catch(() => '');
  const lines = content.split('\n').filter((l) => l.length > 0);

  let maxSeq = 0;
  const ids: string[] = [];
  for (const l of lines) {
    const parsed = parseBusLine(l);
    if (!parsed.ok) continue;
    if (typeof parsed.msg.seq === 'number' && parsed.msg.seq > maxSeq) maxSeq = parsed.msg.seq;
    ids.push(parsed.msg.id);
  }

  return { nextSeq: maxSeq + 1, recentIds: new Set(ids.slice(-DEDUP_TAIL_SIZE)) };
}

export class BusWriter {
  private readonly busPath: string;
  private seq: number;
  private readonly recentIds: Set<string>;
  private readonly lockPath: string;

  private constructor(busPath: string, nextSeq: number, recentIds: Set<string>) {
    this.busPath = busPath;
    this.seq = nextSeq;
    this.recentIds = recentIds;
    this.lockPath = `${busPath}.lock`;
  }

  // Restores seq and a set of recent ids from the tail of the bus (ARCHITECTURE §4, revision v1.1 #50).
  static async create(busPath: string): Promise<BusWriter> {
    const { nextSeq, recentIds } = await readBusTail(busPath);
    return new BusWriter(busPath, nextSeq, recentIds);
  }

  // Transfers valid, non-duplicate incoming lines to the main bus under the lock.
  // Broken lines are logged and skipped (the cursor of the real incoming reader is the caller's concern).
  async mergeOnce(lines: string[]): Promise<{ appended: number }> {
    let appended = 0;
    await withLock(this.lockPath, async () => {
      // Another process could have added to the bus after this writer was created (for example, `fa do`).
      // Re-read the tail already under a common lock, otherwise two live writers will issue the same seq.
      const current = await readBusTail(this.busPath);
      this.seq = Math.max(this.seq, current.nextSeq);
      for (const id of current.recentIds) this.recentIds.add(id);
      const toAppend: string[] = [];
      for (const rawLine of lines) {
        const parsed = parseBusLine(rawLine);
        if (!parsed.ok) {
          log.warn(`merge: skipping broken line: ${parsed.error}`);
          continue;
        }
        if (this.recentIds.has(parsed.msg.id)) continue; // dedup - at-least-once is idempotent

        const withSeq: BusMessage = { ...parsed.msg, seq: this.seq };
        this.seq += 1;
        this.recentIds.add(withSeq.id);
        toAppend.push(JSON.stringify(withSeq));
      }
      if (toAppend.length > 0) {
        await appendFile(this.busPath, toAppend.join('\n') + '\n', 'utf8');
        appended = toAppend.length;
      }
    });
    return { appended };
  }
}
