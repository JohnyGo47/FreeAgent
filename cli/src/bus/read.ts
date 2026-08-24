import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch as watchFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseBusLine, type BusMessage } from '../../../shared/bus-types/index.ts';
import { log } from '../../../shared/log.ts';
import { makeBatchFromContent, type Batch, type BusFileSource } from '../../../shared/bus-source.ts';

export type { BusLine, Batch, BusFileSource } from '../../../shared/bus-source.ts';

// NodeFsSource — реализация BusFileSource для CLI (PR-1). FsaSource (extension) — shared/bus-source.ts + extension/src/bus (PR-2).
export class NodeFsSource implements BusFileSource {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async readBatch(): Promise<Batch> {
    const content = await readFile(this.filePath, 'utf8').catch(() => '');
    return makeBatchFromContent(content);
  }

  async *watch(): AsyncGenerator<Batch> {
    yield await this.readBatch(); // содержимое, уже лежащее на диске к моменту старта
    for await (const _event of watchFile(this.filePath)) {
      yield await this.readBatch();
    }
  }
}

export class BusReader {
  private readonly source: BusFileSource;
  private readonly readerId: string;
  private readonly cursorPath: string;
  private readonly filter?: (m: BusMessage) => boolean;

  constructor(source: BusFileSource, readerId: string, cursorDir: string, filter?: (m: BusMessage) => boolean) {
    this.source = source;
    this.readerId = readerId;
    this.cursorPath = join(cursorDir, 'cursors', `${readerId}.json`);
    this.filter = filter;
  }

  private async loadCursor(): Promise<number> {
    try {
      const raw = await readFile(this.cursorPath, 'utf8');
      const data = JSON.parse(raw) as { position?: number };
      return typeof data.position === 'number' ? data.position : 0;
    } catch {
      return 0;
    }
  }

  private async saveCursor(position: number): Promise<void> {
    await mkdir(dirname(this.cursorPath), { recursive: true });
    await writeFile(this.cursorPath, JSON.stringify({ position }), 'utf8');
  }

  async *messages(): AsyncGenerator<BusMessage> {
    let cursor = await this.loadCursor();
    for await (const batch of this.source.watch()) {
      for (const line of batch.linesAfter(cursor)) {
        const parsed = parseBusLine(line.text);
        if (!parsed.ok) {
          log.warn(`BusReader(${this.readerId}): ${parsed.error}`);
          cursor = line.position;
          await this.saveCursor(cursor);
          continue;
        }
        if (this.filter && !this.filter(parsed.msg)) {
          cursor = line.position;
          await this.saveCursor(cursor);
          continue;
        }
        // Курсор сохраняется ПОСЛЕ yield: at-least-once. Возврат управления в генератор
        // (следующий next()) означает, что потребитель обработал текущее сообщение — это
        // и есть точка подтверждения. Если потребитель упадёт после yield, но до следующего
        // next(), курсор не продвинется, и на рестарте сообщение переиграется — дубли гасит
        // дедуп по id в write.ts. Потеря TASK/RESULT опаснее дубля.
        yield parsed.msg;
        cursor = line.position;
        await this.saveCursor(cursor);
      }
    }
  }
}
