// bus_rotation (spec_bus_rotation v1.0) - archives the old part of message_bus.jsonl without loss
// messages and without damaging cursors: main bus cursors by seq (ARCHITECTURE §4), after rotation
// the new file starts with seq N+1, the old seq is simply not found - this is expected, not an error.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseBusLine, type BusMessage, type TaskPayload, type ResultPayload } from '../../../shared/bus-types/index.ts';
import { withLock } from './lock.ts';

export interface RotationConfig {
  thresholdBytes: number;
  keepMinMessages: number;
  keepMinMs: number;
}

// Default: rotation at > 5MB, leave last 1000 messages or last hour -
// which is greater (Contract "Cut point").
export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  thresholdBytes: 5 * 1024 * 1024,
  keepMinMessages: 1000,
  keepMinMs: 60 * 60 * 1000,
};

export interface RotationPlan {
  archive: BusMessage[];
  keep: BusMessage[];
}

// Pure decision function - where to cut. I/O (files, gzip, lock) - in rotateIfNeeded.
export function planRotation(messages: BusMessage[], config: RotationConfig, nowMs: number): RotationPlan {
  if (messages.length <= config.keepMinMessages) return { archive: [], keep: messages };

  const byCountIdx = messages.length - config.keepMinMessages;
  const cutoffTs = nowMs - config.keepMinMs;
  const firstRecentIdx = messages.findIndex((m) => Date.parse(m.ts) >= cutoffTs);
  const byTimeIdx = firstRecentIdx === -1 ? messages.length : firstRecentIdx;

  // "what is larger" is a larger window keep = smaller slice index.
  let cutIdx = Math.max(0, Math.min(byCountIdx, byTimeIdx));

  // Don't cut the TASK-RESULT: TASK pair until the cut point without RESULT (anywhere in the set) -
  // move the point back to this TASK.
  const resultedTaskIds = new Set<string>();
  for (const m of messages) {
    if (m.type === 'RESULT') {
      const p = m.payload as ResultPayload;
      if (p?.task_id) resultedTaskIds.add(p.task_id);
    }
  }
  for (let i = 0; i < cutIdx; i++) {
    const m = messages[i];
    if (m.type !== 'TASK') continue;
    const p = m.payload as TaskPayload;
    if (p?.task_id && !resultedTaskIds.has(p.task_id)) cutIdx = Math.min(cutIdx, i);
  }

  return { archive: messages.slice(0, cutIdx), keep: messages.slice(cutIdx) };
}

// Threshold is the only configurable spec field (Contract: "default 5MB, configurable").
// keepMinMessages/keepMinMs - fixed Contract constants, not included in the config.
export function rotationConfigFromThreshold(thresholdBytes: number): RotationConfig {
  return { ...DEFAULT_ROTATION_CONFIG, thresholdBytes };
}

export interface RotateResult {
  rotated: boolean;
  archivedCount?: number;
}

// CLI only - the only writer of the main bus (constraint). Order: the archive is written COMPLETELY
// before overwriting the main file (steps 4-5 under the same lock as the merge) - if there is a fall between them
// the main file remains untouched, calling again safely recalculates everything again.
export async function rotateIfNeeded(busPath: string, archiveDir: string, config: RotationConfig, nowMs: number): Promise<RotateResult> {
  const size = await stat(busPath).then((s) => s.size).catch(() => 0);
  if (size < config.thresholdBytes) return { rotated: false };

  let result: RotateResult = { rotated: false };
  await withLock(`${busPath}.lock`, async () => {
    const content = await readFile(busPath, 'utf8').catch(() => '');
    const messages: BusMessage[] = [];
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      const parsed = parseBusLine(line);
      if (parsed.ok) messages.push(parsed.msg);
    }

    const plan = planRotation(messages, config, nowMs);
    if (plan.archive.length === 0) return;

    await mkdir(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `bus_${nowMs}.jsonl.gz`);
    const archiveContent = plan.archive.map((m) => JSON.stringify(m)).join('\n') + '\n';
    // We write to a temporary file and rename it - atomicity at the file system level (the same technique as
    // protects against a half-written archive if it crashes in the middle of gzipSync/writeFile).
    const tmpPath = `${archivePath}.tmp`;
    await writeFile(tmpPath, gzipSync(Buffer.from(archiveContent, 'utf8')));
    await rename(tmpPath, archivePath);

    const keepContent = plan.keep.length > 0 ? plan.keep.map((m) => JSON.stringify(m)).join('\n') + '\n' : '';
    await writeFile(busPath, keepContent, 'utf8');

    result = { rotated: true, archivedCount: plan.archive.length };
  });
  return result;
}
