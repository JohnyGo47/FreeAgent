// Общий контракт чтения шины — один интерфейс, две реализации: NodeFsSource (cli, PR-1),
// FsaSource (extension, PR-2). BusReader строится поверх BusFileSource и не знает, откуда
// приходит содержимое файла (ARCHITECTURE §4, spec_message_bus_read).

export interface BusLine {
  text: string;
  position: number; // ponytail: индекс в строке файла, не байтовый offset — весь файл перечитывается на каждом тике, ротация (spec_bus_rotation) сделает это неверным допущением
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
        if (newlineIdx === -1) break; // хвост без \n — запись ещё идёт, не парсить
        const text = content.slice(pos, newlineIdx);
        pos = newlineIdx + 1;
        if (text.length > 0) result.push({ text, position: pos });
      }
      return result;
    },
  };
}
