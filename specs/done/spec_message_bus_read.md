# Spec: message_bus_read
# Version: 2.1 — sloppy id
# Reading with ARCHITECTURE.md (§4 tire)

## Goal
Reading with cursors: The reader receives only new messages., cursor undergoes restart.

## Input
Way/handle bus-file, `reader_id`, optional `to`

## Output
- A stream of valid `BusMessage` cursorially
- The cursor in `cursors/<reader_id>.json`: `{seq}` main-tyre, `{line}` for incoming/commands
- Broken lines: missed, pledged, cursor

## Constraints
- The main tyre cursor, `seq` (rotate), incoming/commands — line-number
- Cursor is retained **after** consumerization (at-least-once; processors are idempotent or deduploitate by `id`/`seq` — `id` There are in every message, `seq` tyre-only)
- Node: `fs.watch` + catch-up. browser: `FileSystemObserver` (Chrome/Edge) s polling fallback 2s
- Reading from byte offset, half-file
- Tailless `\n` Don't parry - the recording is still going on
- Parsing only through `parseBusLine`, No parser of yours.

## Dependencies
`spec_message_bus_types`, `spec_message_bus_write`

## Implementation notes
```typescript
export class BusReader {
  constructor(
    private source: BusFileSource,   // NodeFsSource | FsaSource, interface
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
1. Reading from scratch – all messages in order
2. Reader restart – Continuation from the stoppage, doubleless
3. The broken line in the middle - skipped, following
4. Filter `to` — The agent only gets his hands on his own. + broadcast
5. Tailless `\n` Not given before the translation of the line
6. Reading while reading – new messages fly

### Integration check
Complete cycle c `message_bus_write`: incoming → merge → main-tyre → both

### Definition of done
- Tests are green for both implementations `BusFileSource`
- Run. integration check'previous PR
