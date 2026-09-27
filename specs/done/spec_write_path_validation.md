# Spec: write_path_validation
# Version: 1.0
# Reading with ARCHITECTURE.md (§11 Agents don't write on disk.)

## Goal
Every way out `WRITE` The agent is checked before recording to the disk. Going beyond the root of the project, service-file-recording, recording outside the declared step files - reject from `ERROR`.

## Input
- `WritePayload.path` post-agent
- project-root (from `freeagent.config.json`)
- list of permitted files of the current step (`PlanStep.files`)

## Output
- normalized, guaranteed within the root of the project
- or `ERROR` violation-descriptive

## Contract

### Validation - three levels

**1. Path traversal.** `path.resolve(root, agentPath)` → The result must begin with `root`. Anybody. `..`, symbolism, Absolute paths - deviate. It's a defense against `../../.ssh/authorized_keys`.

**2. Protected paths.** Recording is prohibited in:
- `/freeagent/` and all subfolders (service-structure)
- `.git/` (User history is inviolable)
- file privacy-exclude list (`spec_context_privacy_filter`)
- `node_modules/`, `.env`, `.env.*` (default; extendable)

**3. File ownership as planned.** If the plan is executed (`spec_plan_execution`), path must `PlanStep.files` current-step agent. Otherwise. — `ERROR` explainably, What files are allowed. The agent may request an extension of the list through `REQUEST_FILE_ACCESS` (future-spec, while deflecting).

If the plan is not implemented (yolo-regime) — level 3 slip.

## Constraints
- Validation is being carried out **escaping CLI** beforehand `fs.writeFile` — single-point
- Normalization through `path.resolve`, Not regular, the OS knows its file system better.
- Nana Windows: `path.resolve` handle `/` and `\`, But the prefix check should be case-insensitive (NTFS)
- Simlinka: `fs.realpath` before prefix check - Simlink, rootless, erode
- `ERROR` contain **path, which agent requested**, but **not** The absolute root path of the project (slipping into context LLM)

## Dependencies
`spec_message_bus_types`, `spec_plan_execution` (possession-check — **PR-8**, level-3 switches on)

> **Order. PR (level-3).** Levels. 1–2 (path traversal, guarded-way) Self-sufficient - implemented in PR-7. Level.-3 (possession `PlanStep.files`) demand `spec_plan_execution` from PR-8, included. V. PR-7 without a plan, level-3 just slipped (like yolo-mode) — behavior.

## Tests
### Unit
1. `src/auth.ts` → accepted, root-way
2. `../../etc/passwd` → rejected, path traversal
3. `/freeagent/agents_registry.json` → rejected, guarded
4. `.git/hooks/pre-commit` → rejected
5. `.env` → default
6. The way `PlanStep.files` → accepted; off-list → `ERROR` listing
7. Yolo-regime: level 3 untested
8. simlink `src/link → /etc/` → `fs.realpath` → rejected
9. Windows: `SRC\Auth.ts` root `C:\project` → accepted (case-insensitive)

### Integration check
Agent sends. `WRITE` three-way: valid, traversal, plan → first-hand, The other two were rejected with correctness. `ERROR`

### Definition of done
- Tests green on Linux and Windows (or WSL)
- No record on the disc passes the validation.
- Run. integration check'previous PR
