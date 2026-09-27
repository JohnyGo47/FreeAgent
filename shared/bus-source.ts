// General bus reading contract - one interface, two implementations: NodeFsSource (cli, PR-1),
// FsaSource (extension, PR-2). BusReader is built on top of BusFileSource and doesn't know where from
// file contents arrive (ARCHITECTURE §4, spec_message_bus_read).

export interface BusLine {
  text: string;
  position: number; // index in the file line - good for incoming/commands (spec_bus_rotation:
  // they are not rotated, incoming truncate is used instead of rotation). The MAIN bus cursor is not rotated
  // experiences by position - mainLoop.ts reads it by seq directly, bypassing this interface.
}

export interface Batch {
  linesAfter(cursor: number): BusLine[];
}

export interface BusFileSource {
  watch(): AsyncGenerator<Batch>;
}

export function makeBatchFromContent(content: string): Batch {
  return {
    linesAfter(cursor: number): BusLine[] {
      const result: BusLine[] = [];
      let pos = cursor;
      while (true) {
        const newlineIdx = content.indexOf('\n', pos);
        if (newlineIdx === -1) break; // tail without \n - recording is still in progress, do not parse
        const text = content.slice(pos, newlineIdx);
        pos = newlineIdx + 1;
        if (text.length > 0) result.push({ text, position: pos });
      }
      return result;
    },
  };
}
