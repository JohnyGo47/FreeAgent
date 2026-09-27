// FsaSource is an implementation of BusFileSource on top of the File System Access API (spec_message_bus_read).
// FileSystemObserver where available (Chrome/Edge), otherwise polling fallback 2With (STACK.md).
// The BusReader higher up the stack does not change - it is already written against the BusFileSource interface.
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
    yield await this.readBatch(); // contents already on disk at the time of start
    yield* this.watchWithPolling();
  }

  private async *watchWithPolling(): AsyncGenerator<Batch> {
    while (true) {
      await sleep(this.pollIntervalMs);
      yield await this.readBatch();
    }
  }
}
