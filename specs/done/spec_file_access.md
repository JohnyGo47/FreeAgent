# Spec: file access
# Version: 1. 1 1 1 1
# Read with ARCHITECTURE.md (§11 agents do not write directly to the disc), spec llm message format, spec message bus types
#
# CHANGELOG v1.1 (adjustment before PR-4):
# Body write/edit: fenced blocks → heredoc with end marker (bectics in the body no longer break the parser)
# - Parsing [FS]: separate parseFsCall in CLI, NOT reused from TagFormat (which will be online in browser bundle; [FS] - pure CLI)
# - write gets the kind (code/test/doc/data) field - the seam for ownership of files in PR-7/PR-8
# - Enum error codes are supplemented with: FORBIDDEN PATH (path valid but protected) and FILE TOO LARGE (byte-cap on read)

#Goal
File access agent: five operations (`list`, `search`, `read`, `write`, `edit`) by which the agent navigates the project, reads and changes files. Plus bootstrap tree, injected into context at the beginning of the session. The bridge between the LLM text chat and the project’s real file system is through CLI, the only execution point.

The key principle is that the agent never invents a way. ** The path is either detected (`list`/`search`) or returned by CLI. All paths are relative to the root of the project; the root is the security frontier.

#Input
**Call:** `[FS | op: ... | ...]` tag block from the model response extracted by the content script (`spec_llm_message_format`) and transmitted by CLI
- For `write`/`edit`, the heredoc body immediately after the tag, prior to the marker string announced in `end:`
- The root of the project from `freeagent.config.json`

#Output
**Result:** JSON object in `[FS_RESULT]` tag, injected back into the context of the model (`spec_llm_message_format`)
The form of the result is success (`ok: true`) or error (`ok: false`) with the error code.

##Contract ##

### Call format

Calls use the same `[TAG | pipe]` header syntax as the entire bus. Operation metadata (`op`, `path`, `query`, `type`, `kind`) is in the pipe tag. The file body (`write`/`edit` only) is placed **after** tag as heredoc: the tag declares the limiter string in the `end:` field, the body is read literally down to the line exactly equal to this limiter.

**Why heredoc, not fenced block.** The body of `write`/`edit` is a payload that can itself contain triple backics (code with markdown in strings, template literals). Fenced wrapper (```) in this case is ambiguous: The parser will not distinguish the closing fence from the bectics inside the code. Heredoc with the declared marker removes it - parser looking for no bectics, a specific line `end:`, The body between the tag and the marker is not interpreted at all. (no bactic, tagged, neither `|`). Marker is a fixed constant of a skill-prompt (`---FS_END---`), The weak model is copying it., not computational; rare-collision (file-format FreeAgent) The model declares another marker in `end:`.

**Parser is a separate, escaping CLI.** `[FS]`-call-up `parseFsCall` escaping CLI, **not** `fromTagFormat` from `/shared/bus-types`. The reason is layered.: `fromTagFormat` Inline into the browser extension bundle, ? `[FS]` (validation, `FORBIDDEN_PATH`, tail-truncate, disk-access) — purely CLI-logic, which should not be extended. Plus, body disciplines are opposites: `[MSG]`-body — JSON (`fromTagFormat` Globally removes bectomy and does `JSON.parse`), `[FS]`-body - literal text with saved bectics (heredoc). To merge them into one function would be to give two incompatible branches and drag them through. disk-browser-logic. «One parser.» From the general philosophy here - about a single syntax *headline* tag, non-uniform body function.

**One call to go exactly..** Everything after the first closed call. (marker `end:`) cut off (centimeter. Constraints, tail truncation).

### Five operations.

**`list` — directory-wood.**
```
[FS | op: list | path: src | depth: 2]
```
- `path` — root-directory; `.` root-to-root
- `depth` — optionally, default 1; How many levels to reveal

Ignoring garbage by default: `.git`, `node_modules`, `dist`, `build`, plus the notes `.gitignore` and `.freeagentignore` (`spec_context_privacy_filter`). It's **non-option** — The tree fills the context with thousands of irrelevant ways..

Success `data`:
```json
{
  "path": "src",
  "tree": {
    "bus": ["router.ts", "message.ts", "types.ts"],
    "supervisor": ["index.ts", "state.ts"],
    "orchestrator": ["index.ts"]
  }
}
```
Directory → facility (her children); file on the requested depth sheet → massif. Directory deeper `depth` → blank-piece (signal «inside, uncovered»).

**`search` — search by content or name.**
```
[FS | op: search | query: class MessageBus | type: content | path: src]
```
- `query` — search-line
- `type` — `content` (ripgrep file-body) or `name` (glob name-named/pathways)
- `path` — optionally, search-field; default-root

Success `data` for `content`:
```json
{
  "results": [
    {
      "path": "src/bus/router.ts",
      "matches": [ { "line": 12, "text": "export class MessageBus {" } ],
      "reason": "content match: 'class MessageBus' (1 occurrence)"
    }
  ]
}
```
Success `data` for `name`:
```json
{
  "results": [ { "path": "src/bus/router.ts", "reason": "name match: 'router'" } ]
}
```
`reason` modelling, Why the file has surfaced – it helps to select the right candidate, when names are similar. The empty result is success, not error: `{ "results": [] }`.

**`read` — file-reading.**
```
[FS | op: read | path: src/bus/router.ts]
```
Success `data`:
```json
{ "path": "src/bus/router.ts", "content": "export class MessageBus {\n  ...\n}\n" }
```
File bigger. byte-cap context → `FILE_TOO_LARGE` (non-silently circumcised content — Otherwise, the model will take the truncated for the full). Exact value cap calibrates on real runs (centimeter. Open items), but the error code and the fact of the check is part of the contract already in PR-4.

**`write` — create or overwrite a file.** Body. — heredoc tagged, marker-line `end:`.
```
[FS | op: write | path: src/bus/message.ts | kind: code | end: ---FS_END---]
export interface Message {
  from: string;
  to: string;
}
---FS_END---
```
`kind` — content: `code` | `test` | `doc` | `data`. V. PR-4 field **recorded, not enforced** (like yolo — anyone writes anything). It's stitching.: `spec_write_path_validation` (PR-7) and `spec_plan_execution` (PR-8) use `kind` file-holder (tester `kind: test`, coder — `kind: code`; stranger `kind` c.file is captured by level-3 validation). Defoult in the absence — `code`. Lay the field now., if PR-7/8 No retrofitting of the tag format backdated.

Success `data`:
```json
{ "path": "src/bus/message.ts", "bytes_written": 61, "created": true, "kind": "code" }
```
`created` — `true` new-file, `false` re-record, the model knew, Has the existing content been replaced?. `kind` Echoing back - confirmation, what CLI scatter.

**`edit` — replace the exact line in the file.** The body is one. heredoc, inside-separated `---OLD---` and `---NEW---`: first-time, then. `old` must meet in file **once** — It forces the model to include enough context for a unique coincidence. (analogue str_replace). Internal markers `---OLD---`/`---NEW---` — fixed-constant; parser cuts the body in two.. No nested fences., No bactic bills, just like the `write`, corpuscle.
```
[FS | op: edit | path: src/bus/router.ts | end: ---FS_END---]
---OLD---
  private handlers = [];
---NEW---
  private handlers: Handler[] = [];
---FS_END---
```
Success `data`:
```json
{ "path": "src/bus/router.ts", "replaced": true }
```
If `old` It is the same as zero or more times, and **mistake** (`NOT_FOUND` either `AMBIGUOUS_MATCH`), **never quiet no-op**. The silent edit is in the wrong place for PR-bounded work is a disaster.

### Format of the result

Each call is completed and returns `[FS_RESULT]` c JSON one-of-a-kind.

Success:
```
[FS_RESULT]
{ "ok": true, "data": { ... } }
[/FS_RESULT]
```
Error:
```
[FS_RESULT]
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "...", "hint": "..." } }
[/FS_RESULT]
```
Boulev `ok` gives models, and the code to branch without ambiguity. `error.code` — stable machine-readable enum; `message` model; `hint` — tip-off, guideline. The structural object of the error leaves room to add fields in the future., parsers-free.

### Error codes

| code            | significance                                             | typical hint                                   |
|-----------------|------------------------------------------------------|-------------------------------------------------|
| UNKNOWN_OP      | `op` not-one                         | list five valid operations              |
| PATH_ESCAPE     | absolute `../` — off-the-root         | root-track            |
| FORBIDDEN_PATH  | path valid and inside the root, but protected from recording (`.git/`, `.env`, ot PR-7 — non-plan file) | leave out; file-only |
| NOT_FOUND       | path (or `old`-line `edit`) non-existence          | use `list`/`search`, target  |
| AMBIGUOUS_MATCH | `old`-line `edit` coincides more than once      | Add context to the environment for uniqueness   |
| BAD_ARGS        | absent/erroneously         | repeat                |
| MULTIPLE_CALLS  | more than one call in one turn                     | one-time, wait                  |
| FILE_TOO_LARGE  | `read`: file-over byte-cap context             | read in parts or narrow down `search`        |
| IO_ERROR        | filesystem failure (rights.p..)                  | (squirting out as is)                        |

> Codes. — enum purposefully: CLI branch, new codes are added, non-impairing existing processing. `UNKNOWN_OP` substitute `UNKNOWN_TOOL` source-contract, because `[FS]`-The format of the operation is given by the field `op`, not by the name of the tula.

### Enforcement sideways CLI

Enforcement live CLI, Not in the goodwill of the model.. Every call is validated. **before** performance. This is a real layer of control – the system prompt asks the model to behave correctly., This code guarantees. Each test conforms to the rule of the role of the prompt.

Before the performance, orderly:
1. **One challenge..** If there is more than one `[FS]`-challenge - perform the first, return `MULTIPLE_CALLS` foregoing. Cut prose., written by the model after the first closed call.
2. **Famous operation.** `op` not-one → `UNKNOWN_OP`.
3. **Arguments in place.** No. `query`, `path` ot.p.. → `BAD_ARGS`.
4. **The way does not run from the root.** Resolve about the root (`path.resolve` + `fs.realpath` simlinka). Absolute., contain `../`, or settles out → `PATH_ESCAPE`. The raw path from a model never goes untested..
5. **The way is not secure.** (for `write`/`edit`). The path will resolve within the root, but it falls into a protected area. (`.git/`, `.env`, `.freeagent/` service files) → `FORBIDDEN_PATH`. Difference from `PATH_ESCAPE`: way *outside* root, here, valid., But you can't write there.. V. PR-4 It's a fixed list of protected pathways.; PR-7 (`write_path_validation`) level-3 (possession `PlanStep.files`), return `FORBIDDEN_PATH`.
6. **The purpose is there.** (for `read`/`edit`/`list` path-by-path). No. → `NOT_FOUND` promptly.

Only after all the checks do the call reach the file system..

Two behaviors are enforcement, nonvalidation, just as important:
- **Tail truncation.** Browser models without native tool-use They often continue to write after the call is closed. (praetre «finish»). CLI/extension Cuts everything off after the first shutdown `[FS]`-call, performer, return, So lets the model continue on this point.. Don't rely on that., That the model will stop by itself; rely, That the system will stop her..
- **Result injection.** The model should never see the result., self-written. Only authoritative `[FS_RESULT]`-block, produced CLI.

> **Connection with `write_path_validation` (PR-7).** Check the way here. (level 1–2: traversal, guarded-way) and `spec_write_path_validation` — The same logic at the same point. `file_access` insert `write`/`edit`; `write_path_validation` (PR-7) level-3 (file-holding `PlanStep.files`). V. PR-4 level-3 absent (like yolo). Do not duplicate the resolution - lay a common `validateWritePath(root, path)`, which PR-7 level-turn-3.

### Bootstrap tree-line

At the beginning of the session, **before the first move of the model**, CLI Automatically Injects the Project Tree (`list` root, depth 2–3, filtered-up) contextually. The model is starting to work., already known the structure. In practice, it's a plus. `search` covers most needs; hand-held `list` It is rare, mainly to reveal the directory., deep-folded bootstrap.

> **Consumers bootstrap.** This tree is already referenced. `spec_md_orchestrator` (to name the real paths in `FILES:` plan) and `spec_cli_plan_mode` (plan, fictional). Bootstrap — part PR; Both consumers are closing in on it..

## Constraints
- Five operations. — **single-handed** agent's way of touching files. There are none.
- Enforcement — **only CLI** (single-point disk access), how `WRITE`-validation. Content script only extract `[FS]`-tagged and passed them on; result injects back (`spec_llm_message_format`)
- syntax *headline* call-up `[TAG | pipe]`, what. Nothing. XML. Body. `write`/`edit` — heredoc before-declared `end:` marker, not fenced-block (BCTs legitimately occur in the body of the code and would break the fence)
- `[FS]`/`[FS_RESULT]` parsite **separate `parseFsCall` escaping CLI**, not `fromTagFormat` from `/shared/bus-types`. `fromTagFormat` plug-in — disk-logic `[FS]` there's no place (leakage); plus body disciplines are incompatible ([MSG]=JSON lip-removed, [FS]=word-for-word heredoc). `parseFsCall` live near enforcement and dispatcher in CLI
- Normalization of the Path Through `path.resolve` + `fs.realpath`, Not regulars, the OS knows its PC better. Nana Windows prefix case-insensitive (NTFS)
- `list` It is necessary to filter the garbage and privacy-exclude Default: otherwise the context of the model is flooded
- All paths in results are relative to the root. The Absolute Root Path Outwards into Context LLM leaky

## Dependencies
`spec_message_bus_types` (shape `[FS_RESULT]`-block `[TAG | pipe]`-headline style - but **not** parsing `[FS]`-call: he makes his own `parseFsCall` escaping CLI, `fromTagFormat` not reused, centimeter. Constraints), `spec_llm_message_format` (injector/extraction `[FS]`/`[FS_RESULT]` escaping DOM — **PR-4, same PR**), `spec_context_privacy_filter` (exclude-filter-list `list`), `spec_fs_folder_access` (project-fabricator), `spec_config` (project-root). Soft., forward: `spec_write_path_validation` (**PR-7**, wrap `validateWritePath` level-3, return `FORBIDDEN_PATH` — escaping PR-4 import off, suture).

> **Order. PR.** `file_access` implemented PR-4 together `llm_message_format` — They're paired.: `llm_message_format` tag-carrying, `file_access` determine `[FS]`-surgery. Bootstrap-tree (§ higher) closes here, unlock `md_orchestrator` (PR-5) and `cli_plan_mode`.

## Implementation notes

### Systemic prompt role (rules of conduct)
File access is useless without rules, «pulling» tool-use browser-based. These seven rules go into the agent’s skill files (th, What's working with files?) — non-orchestra. Each one covers a particular class of bugs.; enforcement duplicates them in code (squire, CLI guarantee).

1. **One call to a move, then stop.** Do not write anything after the call is closed.. Do not issue multiple calls in one turn
2. **Wait. `[FS_RESULT]` before.** Never write the result yourself, the real result comes from the system., modelless
3. **To use the operation - to issue a call, squirrel.** «I'll read the file.» do nothing; only acts `[FS | op: ...]`
4. **Never make up the way.** Find out through `list` or `search`. Not sure., What the file is, look for it.
5. **Each path is relative to the root of the project..** No absolute paths and `../`
6. **If the operation returned the error, correct the approach before continuing. ?.** `NOT_FOUND` smack-drive → look out
7. **Use only five operations:** `list`, `search`, `read`, `write`, `edit`. There are no others.

> The full text of the Skilla with these rules and one few-shot example of a call - in the Annex A. The format and rules are textually simple. (They're read by weak models.), demand `spec_md_orchestrator`.

### Implementation arrangements (vertically, testable)
Build from the core outwards, model. Each step ends with a green run until the next step.:
1. Five functions `fs.*` one-on-one, path guard first (`read` + traversal-test + guarded → `FORBIDDEN_PATH`), later `list`/`search`/`write`/`edit`. `edit` — last, s `AMBIGUOUS_MATCH`. Test - manual script on a real FS
2. Dispatcher: `{op, args}` → result `[FS_RESULT]` (success/error). Test - all error codes enum
3. `parseFsCall` (escaping CLI, separately `fromTagFormat`): text → `{op, args}` + extraction heredoc-body `end:`-marker. Test — case-table (clean-up; body `|`, baectics and string, tagged, inside; tail-tool; two-challenge; `edit` s `---OLD---`/`---NEW---`)
4. Vertical assembly: text → parser → enforcement → dispatcher → `[FS_RESULT]`. Test - play the model with your hands, end-to-end without LLM
5. Live browser model + skill-prompt. This is where model bugs pop up./Prompt – the code is already checked in step 4

## Tests
### Unit
1. `read` validation → content returned
2. `read` `../../etc/passwd` → `PATH_ESCAPE`
3. `list` s depth 2 → tree, `node_modules`/`.git` filtered
4. `list` directory depth → plug-in
5. `search` content → path + matches (line, text) + reason
6. `search` name → path + reason; idleness → `{results: []}` how success
7. `write` newfile → `created: true`, bytes_written faithful, `kind` euph; body-extracted heredoc literal (s `|`, triple-backtices and string, tagged `[FS | ...]`, inside the code, nothing cut., parser found the end of `end:`-marker)
8. `write` existing → `created: false`
9. `write` without `kind` → default `code`; `write` s `kind: test` → echo `test` (field, not enforced escaping PR-4)
10. `write`/`edit` securely (`.git/config`, `.env`) → `FORBIDDEN_PATH`, file intact
11. `edit`, `old` uniquely → `replaced: true`; corpuscle old/new posteriorly `---OLD---`/`---NEW---`
12. `edit`, `old` match 0 once → `NOT_FOUND`; 2+ once → `AMBIGUOUS_MATCH` (not no-op)
13. `read` bigger byte-cap → `FILE_TOO_LARGE` (uncut content)
14. Unknown `op` → `UNKNOWN_OP`; No mandatory arg → `BAD_ARGS`
15. Two. `[FS]`-call-in → first-performed, `MULTIPLE_CALLS` second
16. Prose after closing `end:`-first-call marker → cropped (tail truncation)
17. The result is shaped `{ok, data}` or `{ok, error:{code,message,hint?}}`

### Integration check
Alive. LLM receiver bootstrap-tree → task «Find where it is. X» → emitter `[FS | op: search]` → CLI parsite, performer, return `[FS_RESULT]` → emitter `[FS | op: read]` return-way → round-trip text ⇄ `[FS]` ⇄ CLI ⇄ `[FS_RESULT]` ⇄ lossless. Check the minimum. 2 different LLM.

### Definition of done
- Unit-green-test
- `edit` non-unique `old` — never-before, no quiet edits
- Not a single record./reading path-validation
- Round-trip through `[FS]`/`[FS_RESULT]` does not lose or distort the content (including code `|` bactic)
- Bootstrap-Tree is injected before the first move; `md_orchestrator` and `cli_plan_mode` They can lean on him.
- Run. integration check'previous PR

## Open items (decide, fixate)
- `read` file: error `FILE_TOO_LARGE` fact of inspection — **part-time PR-4** (non-silent). Only the specific is open. *significance* cap and whether pagination is needed on top of failure is calibrated on real runs
- Cap coincidence `search` file, To limit the context, yes, probably., quiz
- Detection of binary devices for `read` (dismiss vs base64) — needlessly code-focused MVP
- Defolent `end:`-marker (`---FS_END---`) and the way of overdetermination in collision - the marker is fixed in the skill-prompt; The mechanism of redefine is, The frequency of actual collisions is unknown.

---

## Annex A — Skill-prompt file access

Inserted into agent's skill files, file-working. Textually simple. (squirm), single few-shot case.

```markdown
You're working with project files through operations. There's no other access to the files.

## How to Induce an Operation

Issues exactly this format:

[FS | op: OPERATION | arg: meaning]

Then stop. The result will come in the block [FS RESULT]. Just keep going after him.

Example:
Question: Where is the MessageBus class defined?
Response: [FS | op: search | query: class MessageBus | type: content]

For write and edit, the body goes immediately after the tag and ends with a marker string ---FS END-- on a separate line. Inside, you can write anything, including triple bectics, they won’t break the challenge.

[FS | op: write | path: src/message.ts | kind: code | end: ---FS END--]
export interface Message {from: string; to: string; }
- FS END--

For editing, the body contains the old and new fragments, separated by the ---OLD--- and ---NEW---:

[FS | op: edit | path: src/router.ts | end: ---FS END--]
--OLD--
private handlers = [];
--NEW--
private handlers: Handler[] = []
- FS END--

## Operations (only these five)

- [FS | op: list | path: PATH | depth: N] - directory tree (default depth 1)
- [FS | op: search | query: TEXT | type: content|name | path: PATH]
- [FS | op: read | path: PATH]
- [FS | op: write | path: PATH | kind: code|test|doc|data | end: MARKER] + body, then MARKER on his line
- [FS | op: edit | path: PATH | end: MARKER] + ---OLD-- old / ---NEW-- new / MARKER

#### Rules

1. One call per move, then stop. For write/edit, the call ends with the line ---FS END--; after that, write nothing. Don't make multiple calls at once.
2. Wait for [FS RESULT] before you go ahead. Never write the result yourself.
3. To use an operation, emulate a call, don't describe it in words.
4. Never invent a way. Find him through list or search. I'm not sure if there's a file, look.
5. Each path is relative to the root of the project. No absolute paths and no "..."
6. The mistake in answering is to correct the approach. “Not found” means the wrong way, seek the right way.
7. Only five operations are higher. There are no others.
8. For write/edit, always close the body with the line ---FS END-- on a separate line. Do not touch the official paths (.git, .env).
``
