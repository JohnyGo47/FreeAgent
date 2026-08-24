// Tier 1 — offscreen-писатель расширения (spec_message_bus_write). Единственный писатель на
// инстанс (ARCHITECTURE §4): файлового lock нет и не может быть у FSA, порядок держит
// in-memory promise-очередь, а не диск.
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
    this.queue = next.catch(() => {}); // одна неудачная запись не блокирует очередь навсегда
    return next;
  }

  private async writeOne(msg: BusMessage): Promise<void> {
    // position берётся из размера файла В МОМЕНТ ВЫПОЛНЕНИЯ (после ожидания очереди),
    // не в момент вызова send() — иначе конкурентные send() запишут поверх друг друга.
    const file = await this.handle.getFile();
    const writable = await this.handle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: file.size, data: JSON.stringify(msg) + '\n' });
    await writable.close();
  }
}
