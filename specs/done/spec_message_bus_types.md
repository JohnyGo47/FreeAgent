# Spec: message_bus_types
# Version: 2.2 — FS_CALL/FS_RESULT added (microscopic-PR beforehand PR-5, wiring [FS] tyre-wire)
# Reading with ARCHITECTURE.md (§4 tire, §2 component)

## Goal
Package `/shared/bus-types`: bus-types, agentship, validation, converter JSON ⇄ tag-text. Zero Renttime Dependencies. Compiled and for Node.js (CLI), for esbuild-clout.

## Output
`/shared/bus-types/index.ts`

## Contract

### MessageType — 19 type, closed union
```typescript
export type MessageType =
  // objectives and outcomes
  | 'TASK' | 'RESULT' | 'STATUS'
  // agent-cycle
  | 'READY' | 'REGISTER_REQUEST' | 'TAB_STATE' | 'HEARTBEAT'
  // file
  | 'WRITE' | 'READ' | 'TESTS_READY' | 'FS_CALL' | 'FS_RESULT'
  // planning
  | 'PLAN' | 'PLAN_REVISED' | 'APPROVED'
  // health
  | 'RESPONSE_HEALTH'
  // systemic
  | 'NOTIFY' | 'COMMAND' | 'ERROR';
```

**Rule against swelling union:** concrete action (`PAUSE`, `RECOVER_AGENT`, `RESEND_PROMPT`, `SWITCH_TO_BACKUP`, `REQUEST_MEMORY`) — it **significance** `CommandPayload.command`, not separate types. Type describes the category of the message, non-action.

**`HEARTBEAT` — extending CLI, one-instant.** Not from an agent. (centimeter. ARCHITECTURE §6).

**`STATUS` — lead out CLI** timing TASK/RESULT (ARCHITECTURE §12); The agent does not send it - the model does not send messages on its own initiative (§6).

**`FS_CALL`/`FS_RESULT` — [FS]-call-up of the agent and its result, conventionally `BusMessage`** (microscopic-PR beforehand PR-5, `spec_file_access`). Heredoc-body `[FS]`-call-up **line** escaping `payload` — browser doesn't parsit it (content script Putting a raw block from the model as is), only `parseFsCall` escaping CLI. `FS_RESULT` returns to the agent who called (`to` = his `agent_id`) same-route, whatever `BusMessage` — new channel not started.

### envelope
```typescript
export interface BusMessage {
  id: string;          // uuid, sender when creating; stable until recorded incoming; dead-up merjah
  seq?: number;        // tyre-only, appropriate CLI mercilessly
  from: string;        // agent_id | 'user' | 'cli' | 'extension' | instance_id
  to: string;          // agent_id | 'orchestrator' | 'cli' | 'extension' | 'broadcast'
  type: MessageType;
  ts: string;          // ISO 8601 UTC
  payload: unknown;
}
```

`id` is assigned at the time of the creation of the message and **change** transferable incoming → main-tyre. For communications, parsed-up LLM, `id` Expand immediately after `fromTagFormat`. He's got deduplication in merzha. (`spec_message_bus_write`): reprocessing incoming after-crush CLI he doesn't make a double.

### Payload-type
```typescript
export interface TaskPayload      { task_id: string; description: string; files?: string[]; retry?: boolean; }
export interface ResultPayload    { task_id: string; status: 'DONE' | 'FAILED'; summary: string; self_assessment?: { percent: number; reasoning: string }; }
export interface StatusPayload    { state: 'WORKING' | 'IDLE'; task_id?: string; }
export interface WritePayload     { path: string; content: string; kind: 'code' | 'test' | 'doc' | 'data'; }
export interface ReadPayload      { path: string; }
export interface TestsReadyPayload{ task_id: string; command: string; }
export interface TabStatePayload  { agent_id: string; state: 'alive' | 'closed' | 'wrong_domain' | 'selectors_broken'; context_pct?: number; }
export interface RegisterPayload  { role: string; llm_url: string; tab_id: number; name?: string; is_backup_for?: string; }
export interface HealthPayload    { agent_id: string; klass: 'unavailable' | 'rate_limited' | 'context_full' | 'no_tags'; raw_excerpt: string; }
export interface PlanPayload      { steps: PlanStep[]; }
export interface PlanStep         { step_id: number; agent_id: string; description: string; files: string[]; depends_on: number[]; }
export interface CommandPayload   { command: string; agent_id?: string; args?: Record<string, unknown>; }
export interface NotifyPayload    { event: string; agent_id?: string; details?: string; }
export interface ErrorPayload     { message: string; context?: string; valid_agents?: string[]; }
```

`FS_CALL`/`FS_RESULT` don't start your own payload-type `payload` it `string` (heredoc-text `[FS|...]` / renderer `[FS_RESULT]...[/FS_RESULT]`), scatter `parseFsCall`/`dispatch` escaping CLI (`spec_file_access`), non-tyre.

### AgentStatus — the only definition of the project
```typescript
export type AgentStatus =
  | 'INITIALIZING'    // injectable INIT, wait READY
  | 'INIT_FAILED'     // READY missed the deadline (spend recovery-try)
  | 'IDLE'            // free, ready to take up
  | 'WORKING'         // perform
  | 'SWITCHING'       // backup, task-line
  | 'BLOCKED'         // auth_required
  | 'SELECTOR_BROKEN' // selector fails, Waiting for the user confirmation
  | 'SERVICE_DOWN'    // service, it's backoff
  | 'STANDBY'         // backup, initialized, non-active
  | 'FAILED';         // exhausted
```
Ten values.. `IDLE`/`WORKING` — single-handed «labour-working» zone: Agent ready and given tasks. Everything else is transitional or terminal., task- CLI buffer. `ACTIVE` absent: He had previously crossed paths with `IDLE`/`WORKING`, a pre-buffer «outside `ACTIVE`» He might have been stuck on a freed agent.. No other speck announces statuses - only imports from here.

### Validation
```typescript
export type ParseResult = { ok: true; msg: BusMessage } | { ok: false; error: string };
export function parseBusLine(line: string): ParseResult;
```
No exceptions – a broken line in a bus should not paint the reader. Line without mandatory fields (`id`, `from`, `to`, `type`, `ts`) → `{ok:false}`.

### Converters (translation-layer LLM)
```typescript
export function toTagFormat(msg: BusMessage): string;
export function fromTagFormat(text: string): BusMessage[];
```
`fromTagFormat` must-feel: squirrel, markdown-wrapper (```), multiple blocks in one answer, tag-less (warning + scrape). **This is the first frontier against the main risk of the project – the unpredictable formatting of free software. LLM.**

> **Editing v2.2.** Markdown-Fences are no longer cut globally throughout the text before tag search `[MSG|...]`/`[/MSG]` They're already ignored. (independent), And the global clipping silently spoiled `payload`, When he legitimately contained triple-bectics himself (wired `FS_CALL`/`FS_RESULT`, whose `payload` — line-bar, not JSON-data). Markdown-wrapper *round* The block still does not interfere with the extraction - it never required a cutout for this..

`id` and `seq` tag-text **don't get in** — It's a tyre ploughing., modelless: `seq` appropriate CLI mercilessly, `id` — sender (answer-block LLM — parsing). Therefore round-trip tag format retains `from`/`to`/`type`/`payload`, not `id`/`seq`.

## Dependencies
No - foundational steak.

## Tests
### Unit
1. Valid message from each 19 parsing
2. Broken lines (not-JSON, without `id`, without `from`, unknown `type`, curve `ts`) → `{ok:false}` without exception
3. Round-trip `fromTagFormat(toTagFormat(msg))` equivalent `from`/`to`/`type`/`payload` (`id`/`seq` They are assigned at the tyre boundaries and do not enter the tag)
4. `fromTagFormat`: tag-shopping, markdown-wrapper, Two blocks in one text – all extracted
5. Unclosed tag - message extracted, warning pledged
6. `AgentStatus` cover 10 value, exported as value (not-so-subtle) runtime

### Definition of done
- Tests green., assembly tsc + esbuild both-targeted
- No other Speaker announces its own message types or statuses.
