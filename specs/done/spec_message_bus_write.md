# Spec: message_bus_write
# Version: 3.1 — восстановление seq при старте, дедуп мержа по id
# Читать вместе с ARCHITECTURE.md (§4 шина, §5 правило MV3)

## Goal
Запись в шину без race conditions на обоих уровнях: расширение → `incoming/<instance_id>.jsonl`, CLI → `message_bus.jsonl`.

## Input
- **Tier 1 (расширение):** `BusMessage`, `FileSystemFileHandle` своего incoming-файла
- **Tier 2 (CLI):** список `incoming/*.jsonl` + курсоры, путь к главной шине

## Output
- Tier 1: сообщение дописано в `incoming/<instance_id>.jsonl`
- Tier 2: сообщение перенесено в `message_bus.jsonl` с присвоенным `seq`, курсор сдвинут

## Constraints
- Tier 1: **файлового lock нет** — писатель один на инстанс (offscreen). Порядок держит in-memory promise-очередь: `position` берётся из актуального размера файла в момент выполнения, а не вызова
- Tier 1: запись через `createWritable({ keepExistingData: true })` + `write({ type:'write', position, data })`
- Tier 2: lock `message_bus.lock` через `fs.open('wx')`, retry 50ms × 10 (defense-in-depth против двух CLI-процессов)
- Tier 2: только `appendFile`, никогда не перезаписывать файл
- `seq` — глобальный счётчик CLI, инкремент при каждом переносе. **При старте CLI восстанавливает счётчик из хвоста `message_bus.jsonl` (max `seq` + 1); пустой файл → 1** — иначе `seq` столкнётся с уже записанными
- **Дедуп по `id` при мерже:** перед переносом строки в главную шину CLI сверяет `id` с набором последних N обработанных id (набор восстанавливается из хвоста шины при старте). Дубль пропускается — мерж идемпотентен: повторная обработка той же строки incoming после креша (запись в шину прошла, курсор не сдвинулся) не создаёт дубля
- Формат строго JSON Lines, тег-текст внутри файлов не встречается

## Dependencies
`spec_message_bus_types` — типы, сериализация

## Implementation notes
```typescript
// Tier 1 — offscreen document расширения
class InstanceBusWriter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private handle: FileSystemFileHandle) {}
  async send(msg: BusMessage): Promise<void> {
    this.queue = this.queue.then(() => this.writeOne(msg));
    return this.queue;
  }
  private async writeOne(msg: BusMessage) {
    const file = await this.handle.getFile();
    const w = await this.handle.createWritable({ keepExistingData: true });
    await w.write({ type: 'write', position: file.size, data: JSON.stringify(msg) + '\n' });
    await w.close();
  }
}

// Tier 2 — CLI
async function withLock(fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      const fd = await open('message_bus.lock', 'wx');
      await fd.close();
      try { await fn(); } finally { await unlink('message_bus.lock').catch(() => {}); }
      return;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      await sleep(50);
    }
  }
  throw new Error('bus lock timeout 500ms');
}
```

## Tests
### Unit
1. Tier 1: одиночная запись — валидный JSON в файле
2. Tier 1: 10 последовательных `send()` — порядок сохранён, потерь нет (проверяет promise-очередь, файлового lock здесь нет)
3. Tier 2: merge из нескольких incoming — все сообщения в главной шине, `seq` монотонный
4. Tier 2: 10 конкурентных merge через `Promise.all` — нет дублей, нет битых строк
5. Tier 2: занятый lock — второй вызов ждёт и получает после release
6. Tier 2: lock не остаётся на диске при ошибке записи (`finally`)
7. Восстановление `seq`: рестарт CLI при непустой шине → следующий `seq` = max + 1, коллизий нет
8. Дедуп: две строки incoming с одинаковым `id` → в главной шине одна (идемпотентность мержа)

### Integration check
Node-скрипт записывает 5 JSON-строк в `incoming/mock_instance.jsonl` (эмуляция расширения, которого ещё нет в PR-1) → CLI мержит → читатель главной шины видит все 5 с монотонным `seq`

### Definition of done
- Тесты зелёные
- Ни один тест Tier 1 не полагается на файловый lock — его там нет по конструкции
- `seq` восстанавливается из хвоста шины при рестарте; мерж идемпотентен по `id`
- Прогон integration check'ов всех предыдущих PR
