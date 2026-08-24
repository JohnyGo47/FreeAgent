# Spec: message_bus_read
# Version: 2.1 — дедуп по id
# Читать вместе с ARCHITECTURE.md (§4 шина)

## Goal
Чтение с курсорами: читатель получает только новые сообщения, курсор переживает перезапуск.

## Input
Путь/handle файла шины, `reader_id`, опциональный фильтр по `to`

## Output
- Поток валидных `BusMessage` с позиции курсора
- Курсор в `cursors/<reader_id>.json`: `{seq}` для главной шины, `{line}` для incoming/commands
- Битые строки: пропущены, залогированы, курсор продвинут

## Constraints
- Курсор главной шины — по `seq` (переживёт ротацию), incoming/commands — по номеру строки
- Курсор сохраняется **после** обработки потребителем (at-least-once; обработчики идемпотентны или дедуплицируют по `id`/`seq` — `id` есть в каждом сообщении, `seq` только в главной шине)
- Node: `fs.watch` + догоняющее чтение. Браузер: `FileSystemObserver` (Chrome/Edge) с polling fallback 2с
- Чтение от байтового offset, не полного файла
- Хвост без `\n` не парсить — запись ещё идёт
- Парсинг только через `parseBusLine`, своего парсера нет

## Dependencies
`spec_message_bus_types`, `spec_message_bus_write`

## Implementation notes
```typescript
export class BusReader {
  constructor(
    private source: BusFileSource,   // NodeFsSource | FsaSource, один интерфейс
    private readerId: string,
    private filter?: (m: BusMessage) => boolean,
  ) {}
  async *messages(): AsyncGenerator<BusMessage> {
    let cursor = await this.loadCursor();
    for await (const batch of this.source.watch()) {
      for (const line of batch.linesAfter(cursor)) {
        const parsed = parseBusLine(line.text);
        cursor = line.position;
        if (!parsed.ok) { log.warn(parsed.error); await this.saveCursor(cursor); continue; }
        if (this.filter && !this.filter(parsed.msg)) { await this.saveCursor(cursor); continue; }
        yield parsed.msg;
        await this.saveCursor(cursor);
      }
    }
  }
}
```

## Tests
### Unit
1. Чтение с нуля — все сообщения по порядку
2. Перезапуск читателя — продолжение с места остановки, без дублей
3. Битая строка в середине — пропущена, следующие получены
4. Фильтр `to` — агент получает только свои + broadcast
5. Хвост без `\n` не отдан до появления перевода строки
6. Дозапись во время чтения — новые сообщения долетают

### Integration check
Полный цикл с `message_bus_write`: incoming → merge → главная шина → оба типа читателей

### Definition of done
- Тесты зелёные для обеих реализаций `BusFileSource`
- Прогон integration check'ов предыдущих PR
