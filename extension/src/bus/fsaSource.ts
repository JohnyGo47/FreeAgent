// FsaSource — реализация BusFileSource поверх File System Access API (spec_message_bus_read).
// FileSystemObserver где доступен (Chrome/Edge), иначе polling fallback 2с (STACK.md).
// BusReader выше по стеку не меняется — он уже написан против интерфейса BusFileSource.
import { makeBatchFromContent, type Batch, type BusFileSource } from '../../../shared/bus-source.ts';

const DEFAULT_POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FsaSource implements BusFileSource {
  private readonly handle: FileSystemFileHandle;
  private readonly pollIntervalMs: number;

  constructor(handle: FileSystemFileHandle, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.handle = handle;
    this.pollIntervalMs = pollIntervalMs;
  }

  private async readBatch(): Promise<Batch> {
    const file = await this.handle.getFile();
    const content = await file.text();
    return makeBatchFromContent(content);
  }

  async *watch(): AsyncGenerator<Batch> {
    yield await this.readBatch(); // содержимое, уже лежащее на диске к моменту старта

    const ObserverCtor = (globalThis as { FileSystemObserver?: FileSystemObserverConstructor }).FileSystemObserver;
    if (ObserverCtor) {
      yield* this.watchWithObserver(ObserverCtor);
    } else {
      yield* this.watchWithPolling();
    }
  }

  private async *watchWithObserver(ObserverCtor: FileSystemObserverConstructor): AsyncGenerator<Batch> {
    let wake: (() => void) | null = null;
    let pending = false;
    const observer = new ObserverCtor(() => {
      pending = true;
      wake?.();
    });
    await observer.observe(this.handle);

    try {
      while (true) {
        if (!pending) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        pending = false;
        yield await this.readBatch();
      }
    } finally {
      observer.disconnect();
    }
  }

  private async *watchWithPolling(): AsyncGenerator<Batch> {
    while (true) {
      await sleep(this.pollIntervalMs);
      yield await this.readBatch();
    }
  }
}
