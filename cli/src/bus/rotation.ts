// bus_rotation (spec_bus_rotation v1.0) — архивирует старую часть message_bus.jsonl без потери
// сообщений и без порчи курсоров: курсоры главной шины по seq (ARCHITECTURE §4), после ротации
// новый файл начинается с seq N+1, старый seq просто не находится — это ожидаемо, не ошибка.
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

// По умолчанию: ротация при > 5MB, оставить последние 1000 сообщений или за последний час —
// что больше (Contract "Точка разреза").
export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  thresholdBytes: 5 * 1024 * 1024,
  keepMinMessages: 1000,
  keepMinMs: 60 * 60 * 1000,
};

export interface RotationPlan {
  archive: BusMessage[];
  keep: BusMessage[];
}

// Чистая функция решения — где резать. I/O (файлы, gzip, lock) — в rotateIfNeeded.
export function planRotation(messages: BusMessage[], config: RotationConfig, nowMs: number): RotationPlan {
  if (messages.length <= config.keepMinMessages) return { archive: [], keep: messages };

  const byCountIdx = messages.length - config.keepMinMessages;
  const cutoffTs = nowMs - config.keepMinMs;
  const firstRecentIdx = messages.findIndex((m) => Date.parse(m.ts) >= cutoffTs);
  const byTimeIdx = firstRecentIdx === -1 ? messages.length : firstRecentIdx;

  // "что больше" — большее окно keep = меньший индекс среза.
  let cutIdx = Math.max(0, Math.min(byCountIdx, byTimeIdx));

  // Не резать пару TASK-RESULT: TASK до точки разреза без RESULT (где угодно в наборе) —
  // сдвинуть точку назад до этого TASK.
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

// Порог — единственное конфигурируемое поле спеки (Contract: "по умолчанию 5MB, конфигурируемо").
// keepMinMessages/keepMinMs — фиксированные константы Contract'а, не вынесены в конфиг.
export function rotationConfigFromThreshold(thresholdBytes: number): RotationConfig {
  return { ...DEFAULT_ROTATION_CONFIG, thresholdBytes };
}

export interface RotateResult {
  rotated: boolean;
  archivedCount?: number;
}

// Только CLI — единственный writer главной шины (constraint). Порядок: архив пишется ПОЛНОСТЬЮ
// до перезаписи основного файла (шаги 4-5 под тем же локом, что и мерж) — при падении между ними
// основной файл остаётся нетронутым, повторный вызов безопасно всё пересчитывает заново.
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
    // Пишем во временный файл и переименовываем — атомарность на уровне ФС (тот же приём, что
    // защищает от полу-записанного архива при падении посреди gzipSync/writeFile).
    const tmpPath = `${archivePath}.tmp`;
    await writeFile(tmpPath, gzipSync(Buffer.from(archiveContent, 'utf8')));
    await rename(tmpPath, archivePath);

    const keepContent = plan.keep.length > 0 ? plan.keep.map((m) => JSON.stringify(m)).join('\n') + '\n' : '';
    await writeFile(busPath, keepContent, 'utf8');

    result = { rotated: true, archivedCount: plan.archive.length };
  });
  return result;
}
