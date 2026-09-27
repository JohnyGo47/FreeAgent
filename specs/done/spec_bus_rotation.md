# Spec: bus_rotation
# Version: 1.0
# Read along with ARCHITECTURE.md (§4 bus, cursors by seq)

## Goal
The main bus `message_bus.jsonl` grows infinitely during long sessions. Rotation: archive old ones without breaking cursors or losing messages.

## Input
- `message_bus.jsonl` with N messages
- rotation threshold (by size or number of lines)

## Output
- `message_bus.jsonl` contains only messages after the rotation point
- `message_bus_archive/bus_<timestamp>.jsonl.gz` — archived part
- all readers' cursors continue to work without reprocessing and without gaps

## Contract

### Why cursors survive
Main bus cursors store **`seq`**, not line number or byte offset (decision fixed in ARCHITECTURE §4). `seq` - global, monotonically growing, unique. After rotation, the new `message_bus.jsonl` starts with `seq` = N+1, and the cursor with `seq` = N-50 simply does not find the old messages - this is correct behavior, not an error: the messages have already been processed.

### Rotation procedure
```
1. CLI takes lock (same message_bus.lock)
2. Reads the current file entirely
3. Defines the cutting point: all messages before seq X → archive, after → remain
4. Writes the archive to message_bus_archive/bus_<ts>.jsonl.gz
5. Rewrites message_bus.jsonl with the remaining lines
6. Releases the lock
```

Atomicity: steps 4–5 under lock, and the archive is written **before** the main file is rewritten. If it falls between 4 and 5, the archive is there, the main file is not touched, the rotation is repeated.

### Cut point
- Default: rotation when `message_bus.jsonl` > 5 MB (configurable)
- Cutting point: leave the last 1000 messages (or messages for the last hour - whichever is more)
- Do not cut in the middle of the transaction: if the last TASK before the cut point does not have a RESULT, move the point back so that the TASK-RESULT pair remains together

### Incoming files
`incoming/<instance_id>.jsonl` **not rotated** - CLI read and wrote to the main bus, the contents of the incoming file can be reset to zero (truncate). Incoming cursors - by line number, truncate resets them to 0.

## Constraints
- Rotation is performed **CLI only** (the only writer on the main bus)
- Rotation does not interrupt active work - cursors are valid after rotation
- Archives are read-only, intended for diagnostic purposes, not for reading by agents
- gzip - standard, without additional dependencies (`zlib` is built into Node.js)
- On first launch after rotation: reader with cursor on `seq` from the archive → continues from the first `seq` in the current file, warning “N messages missed (in archive)”

## Dependencies
`spec_message_bus_read`, `spec_message_bus_write`, `spec_cli`

## Tests
### Unit
1. Bus > 5 MB → rotation, archive created, main file contains the last 1000 messages
2. Cursor on `seq` 500, rotation removed to `seq` 400 → reader continues with 501, nothing missing
3. Cursor on `seq` 200, rotation removed to `seq` 400 → reader starts with `seq` 401, warning displayed
4. TASK without RESULT before the cut point → the point is shifted, the pair remains together
5. Fall between recording the archive and overwriting the main one → re-rotation is safe (the archive is already there, the main one is untouched)
6. Incoming truncate → cursor is reset to 0, next reading starts over
7. Configurable threshold from `freeagent.config.json`

### Integration check
Record 10,000 messages → rotation → continue recording → the reader has not missed a single post-rotation message

### Definition of done
- Tests are green
- Rotation under lock, data is not lost if it falls
- Running integration checks of previous PRs
