# FreeAgent Architecture

FreeAgent connects browser-based LLM conversations to a local coding workflow. The browser extension transports prompts and responses; the CLI owns coordination, filesystem access, verification, and durable state.

The architecture deliberately treats an LLM response as untrusted input. Deterministic code decides what may be read or written, whether tests really passed, and when a plan step may start.

## Design principles

1. **Mechanical checks over model claims.** The CLI verifies files, test exit codes, dependencies, and checkpoints itself.
2. **One writer per resource.** The extension writes only to its instance input queue; the CLI writes the main bus, command queues, registry, and project files.
3. **Small messages, large data through files.** Agents report concise results and access project content through the FS protocol.
4. **Explicit ownership.** A plan step declares its files, and writes outside that set are rejected while the step is active.
5. **Recoverable failure states.** Closed tabs, broken selectors, revoked folder access, rate limits, and malformed responses have explicit handling paths.
6. **The user owns the project.** Paths are confined to the selected root, sensitive files are filtered, and Git checkpoints make completed work reversible.

## Components

### CLI

The Node.js CLI is the trusted coordinator. It:

- initializes project-local runtime state;
- merges extension input queues into the main message bus;
- assigns stable agent IDs and tracks lifecycle state;
- parses and approves execution plans;
- dispatches ready steps when dependencies and file ownership allow them;
- executes FS requests inside the project root;
- runs allowlisted verification commands and checks real exit codes;
- creates Git checkpoints and supports task-level undo; and
- exposes status, log, agent, mode, stop, and undo commands.

Only the CLI writes user project files.

### Browser extension

The Manifest V3 extension has four bundles:

- **background service worker** — extension lifecycle, tab observation, content-script recovery, and offscreen startup;
- **offscreen document** — durable access to the selected project directory and polling of command queues;
- **content script** — DOM adapter selection, prompt injection, submission, response detection, and protocol extraction;
- **popup** — directory selection, permission restoration, role selection, and tab registration.

The extension does not directly modify source files. It transports structured messages between the browser conversation and the project-local runtime directory.

### Shared package

`shared/` contains message types, tag-format conversion, adapter schemas, the default adapter registry, bus abstractions, and memory validation used by both the CLI and extension.

## Runtime directory

Initializing a target project creates `freeagent/` in that project:

```text
freeagent/
  freeagent.config.json
  agents_registry.json
  llm_adapter_registry.json
  selector_overrides.json
  message_bus.jsonl
  checkpoints.json
  incoming/<instance_id>.jsonl
  commands/<instance_id>.jsonl
  cursors/<reader_id>.json
  memory/<agent_id>.md
  skills/*.md
  logs/
```

This directory is operational state and is excluded from Git. Every initialized project has a unique `project_id`; the extension and CLI must point to the same project root.

## Message flow

1. A browser agent emits a protocol block.
2. The content script extracts the block and sends it to the offscreen document.
3. The offscreen writer appends it to `freeagent/incoming/<instance_id>.jsonl`.
4. The CLI merges incoming records into `message_bus.jsonl`, assigning monotonic sequence numbers and deduplicating by message ID.
5. The router handles the message or appends a command to the destination instance queue.
6. The offscreen document observes that queue and asks the registered content script to inject the command.
7. Each consumer advances its cursor only after successful processing, providing at-least-once delivery.

The main bus may rotate when it exceeds the configured threshold. Rotation retains the larger of the recent time window or the last 1,000 messages and preserves unfinished task/result pairs.

## Protocol

Normal messages use tagged blocks:

```text
[MSG | from: coder1 | to: orchestrator | type: RESULT]
{"task_id":"example","status":"DONE","summary":{"result":"Implemented the requested change"}}
[/MSG]
```

Project access uses separate FS calls so the CLI can authorize and execute them:

```text
[FS | op: read | path: package.json]
```

Supported operations are `read`, `list`, `search`, `write`, and `edit`. Multiline writes use an explicit end marker. An agent must wait for `FS_RESULT` before continuing.

## Agent lifecycle

The popup records a registration request with a role and browser tab. The CLI assigns the lowest available stable ID for that role, stores the registration, and sends an INIT prompt containing:

- the agent ID and role;
- the role prompt from `freeagent/skills/`;
- the canonical FreeAgent protocol; and
- additional context such as the current roster for the orchestrator.

The agent becomes `IDLE` after `[READY]`. Relevant states include `INITIALIZING`, `IDLE`, `WORKING`, `SWITCHING`, `STANDBY`, `BLOCKED`, `SERVICE_DOWN`, `SELECTOR_BROKEN`, `INIT_FAILED`, and `FAILED`.

On CLI startup, reconciliation asks every registered tab for its current state. Closed or unreachable tabs move to a recoverable unavailable state instead of being silently treated as healthy.

## Plans and execution

In plan mode, the orchestrator responds to a user task with a structured plan:

```text
[PLAN]
STEP 1 | researcher1 | Inspect the current behavior | FILES: notes.md | DEPENDS: none
STEP 2 | coder1 | Implement the change | FILES: src/feature.ts | DEPENDS: 1
STEP 3 | tester1 | Run the test suite | FILES: none | DEPENDS: 2
[/PLAN]
```

The CLI validates syntax, known agents, and dependency cycles. Nothing executes until the user approves the plan. Ready independent steps may run together, while overlapping file claims are serialized. The CLI dispatches steps; the orchestrator does not manually resend approved work.

The execution engine stops releasing new steps after `/stop`. Failed results, failed verification, ownership violations, and low self-assessment escalate to the orchestrator rather than silently continuing dependent work.

## Verification and checkpoints

An agent requests test execution with `TESTS_READY`. The CLI accepts only allowlisted command forms, rejects shell metacharacters, runs the process with a timeout, records output, and uses the actual exit code.

Before an approved step modifies declared files, the CLI can create a pre-task Git checkpoint. A successful verified step creates a completion checkpoint containing only checkpointable step files. `/undo <task_id>` performs a Git revert for the selected task and reports conflicts without resolving them automatically.

When Git checkpoints are disabled, the TUI displays a persistent warning and reliable undo is unavailable.

## Filesystem and privacy boundaries

All FS paths are resolved relative to the selected project root. Absolute paths, traversal, realpath escapes, `.git`, dependency directories, runtime state, and configured protected patterns are rejected.

Built-in privacy rules exclude common secret files such as `.env`, private keys, and credentials. Readable source files are scanned for secret-shaped values and matching values are masked before content is returned to an agent. `.freeagentignore` extends the exclusion rules for each project.

## Browser resilience

Browser DOMs are unstable, so adapters use selector fallback chains and conservative heuristics. A candidate selector must be confirmed before it replaces a known selector. Complete protocol blocks can finish a response even when a stale busy indicator remains visible.

The service worker recreates the offscreen document when necessary and reinjects the content script if a tab no longer has a receiver. Directory handles are stored in IndexedDB, but the browser may still require the user to restore permission after a reload or restart.

## Current boundary

The live ChatGPT workflow is validated. Other adapters share the same schema and automated tests, but browser UI changes may require selector updates. FreeAgent remains a beta and should be used with Git enabled and a reviewable working tree.
