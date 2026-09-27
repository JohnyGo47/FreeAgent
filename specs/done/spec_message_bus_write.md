# Spec: message_bus_write
# Version: 3.1 — recovery seq start, merjah-dup id
# Reading with ARCHITECTURE.md (§4 tire, §5 rule MV3)

## Goal
Write in the tire without race conditions both levels: expansion → `incoming/<instance_id>.jsonl`, CLI → `message_bus.jsonl`.

## Input
- **Tier 1 (expansion):** `BusMessage`, `FileSystemFileHandle` his own incoming-file
- **Tier 2 (CLI):** list `incoming/*.jsonl` + cursor, main-tyre

## Output
- Tier 1: note `incoming/<instance_id>.jsonl`
- Tier 2: post-post `message_bus.jsonl` assigned `seq`, cursor shifted

## Constraints
- Tier 1: **file-based lock no** — one-man (offscreen). Order keeps it. in-memory promise-turn: `position` Taken from the current file size at the time of execution, not a challenge
- Tier 1: recording `createWritable({ keepExistingData: true })` + `write({ type:'write', position, data })`
- Tier 2: lock `message_bus.lock` through `fs.open('wx')`, retry 50ms × 10 (defense-in-depth two-way CLI-processes)
- Tier 2: only `appendFile`, never overwrite the file
- `seq` — counter CLI, increment on each transfer. **At launch CLI tail-restore `message_bus.jsonl` (max `seq` + 1); file-in-the-box → 1** — otherwise `seq` will face the ones already recorded
- **Dad-by `id` mercilessly:** before moving the line to the main bus CLI check `id` late-story N processed id (The set is restored from the tail of the tire at start). Double missed - merj idempoten: reprocessing incoming after-crush (tyre recording passed, cursor didn't move) he doesn't make a double
- Format strictly JSON Lines, Tag text does not appear inside files

## Dependencies
`spec_message_bus_types` — type, serialization

## Implementation notes
```typescript
// Tier 1 — offscreen document expansion
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
1. Tier 1: single entry - valid JSON file-wise
2. Tier 1: 10 successive `send()` — order maintained, loss (check-in promise-turn, file-based lock There's no)
3. Tier 2: merge several incoming — all messages in the main tyre, `seq` monotonous
4. Tier 2: 10 competitive merge through `Promise.all` — no take, no broken lines
5. Tier 2: busy lock — The second call waits and receives after release
6. Tier 2: lock Does not remain on disk when recording error (`finally`)
7. Recovery `seq`: restart CLI flat-tyre → next `seq` = max + 1, No collisions
8. DEADUP: two-line incoming uniformly `id` → main-tyre (idempotence of merzha)

### Integration check
Node-script 5 JSON-lineage `incoming/mock_instance.jsonl` (expansion, not yet PR-1) → CLI merlin → The main tyre reader sees everything. 5 monotonous `seq`

### Definition of done
- Tests green.
- Not a test. Tier 1 file-free lock — It's not there in design.
- `seq` Recover from the tail of the tire at restart; merz jempotent `id`
- Run. integration check'all the previous PR
