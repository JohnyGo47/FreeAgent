# Spec: cli_plan_mode
# Version: 2.0
# Read along with ARCHITECTURE.md (§8 plan as a program)

## Goal
Default plan: the orchestrator issues a plan, the user confirms, and only then the agents touch the files.

## Input
- User task (`freeagent do "..."`)
- Orchestrator response with `[PLAN]` in tag format

## Output
- Plan rendered in TUI (steps, agents, files, dependencies)
- `[Enter]` execute / `[e]` edit in `$EDITOR` / `[Esc]` cancel
- After confirmation → `APPROVED` → `spec_plan_execution`

## Constraints
- **Plan mode — default.** `yolo` is enabled explicitly and shows a permanent indicator in the statusbar
- The “plan first” instruction is in the orchestrator skill, but **enforcement is on the CLI side**: any `WRITE` to `APPROVED` for the current task → `COMMAND: PAUSE` + notification “orchestrator started without a plan”. You can't rely on the discipline of a weak model
- Edit: open plan as markdown in `$EDITOR`, send edited as `PLAN_REVISED`
- Plan waiting timeout: 120s → show raw orchestrator response, suggest repeating
- Invalid plan (cycles, non-existent agents) → returned to the orchestrator before being shown to the user
- `/mode` persists in `freeagent.config.json`

## Dependencies
`spec_cli`, `spec_message_bus_types`, `spec_skills_system`, `spec_file_access` (project tree - PR-4, see note)

> **Project tree.** Plan mode is only useful if the orchestrator received the project tree at the beginning of the session (bootstrap - `spec_file_access` §6). Otherwise, he plans along imaginary paths. The tree is not included in this PR; the dependency is taken into account when writing `file_access` (PR-4).

> `cli_plan_mode` produces an approved plan (`APPROVED`). `plan_execution` consumes it. The dependency is unidirectional: `plan_execution` → `cli_plan_mode`, not vice versa.

## Tests
### Unit
1. Plan mode: agents do not receive `TASK` until `APPROVED`
2. `WRITE` to `APPROVED` → `PAUSE`, the user is notified
3. Yolo: `TASK` goes away immediately, the mode indicator is displayed
4. Edit: `PLAN_REVISED` contains text from the editor
5. `/mode` persists between launches
6. Timeout 120s → raw answer shown, repeat suggested

### Integration check
Live orchestrator: task → plan in terminal → Enter → agent received `TASK`

### Definition of done
- Tests are green
- README (when published): the first example shows plan mode as default
- Running integration checks of previous PRs
