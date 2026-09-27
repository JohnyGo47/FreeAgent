// Tier 1 - offscreen extension writer (spec_message_bus_write). The only writer on
// instance (ARCHITECTURE §4): FSA does not and cannot have a file lock, it keeps order
// in-memory promise is a queue, not a disk.
import type { BusMessage } from '../../../shared/bus-types/index.ts';

export type OutgoingMessage = Omit<BusMessage, 'id'>;

export class InstanceBusWriter {
  private readonly handle: FileSystemFileHandle;
  private queue: Promise<void> = Promise.resolve();

  constructor(handle: FileSystemFileHandle) {
    this.handle = handle;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const withId: BusMessage = { id: crypto.randomUUID(), ...msg };
    const next = this.queue.then(() => this.writeOne(withId));
    this.queue = next.catch(() => {}); // one bad write doesn't block the queue forever
    return next;
  }

  private async writeOne(msg: BusMessage): Promise<void> {
    // position is taken from the file size AT THE MOMENT OF EXECUTION (after waiting for the queue),
    // not at the time of calling send() - otherwise concurrent send()s will overwrite each other.
    const file = await this.handle.getFile();
    const writable = await this.handle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: file.size, data: JSON.stringify(msg) + '\n' });
    await writable.close();
  }
}
