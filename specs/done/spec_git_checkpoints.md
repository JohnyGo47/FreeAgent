# Spec: git checkpoints
# Version: 2.0
# Read with ARCHITECTURE.md (§10 concurrency, §11 agents do not write to disc)

#Goal
Every significant step of the agents is recorded by an automatic commit. `/undo` rolls back with one team. The fear of “agents will destroy the project” is removed.

#Input
Bus Events: First `WRITE` in `task_id`, `RESULT: DONE` after successful verification

#Output
- Commitments `freeagent: pre-task {task_id}` and `freeagent: {task_id} — {summary}`
`/undo` → `git revert` (not reset – user history is inviolable)
`freeagent log` – Checkpoints with task id and dates

##Constraints
*Committ captures only files claimed in `files` of its plan step** – thanks to ownership control (ARCHITECTURE §10), parallel steps are written into non-intersecting files, so simultaneous `DONE` do not mix the story
- Explicit `git add <path WRITE>` - never `git add .`, never touch staged user changes
- Do not commit: `/freeagent/`, files from privacy exceptions. `/freeagent/` added to `.gitignore` at `init`
- Non-git project: `init` offers `git init`; if you refuse - checkpoints are disabled, **permanent warning in TUI** (don't be silent)
`/undo` in a revert conflict - stop, show the conflict, do not resolve automatically
`checkpoint_branch: true` - commits to a separate branch; by default `false` (in the current, simpler and visible)
- Implementation through `child_process git` - git the target audience has, libgit2-binding is not necessary

## Dependencies
`spec_message_bus_read`, `spec_cli`, `spec_plan_execution` (`files` list source), git in PATH

## Tests
################################################################################################################################################################################################################################################################
1. `WRITE` → `DONE` → Two commits with correct prefixes, only affected files
2. `/undo` rolls back the last checkpoint, files return to pre-task state
3. `/undo <task_id>` rolls back only the specified number for three tasks.
4. Staged changes to the user do not fall into checkpoint
5. **Two parallel steps are completed simultaneously → two commits, files are not mixed**
6. Non-git project: warning shown, `WRITE` works, nothing falls
7. `/freeagent/` is not available in all checkpoints

###Integration check
Agent writes bug file → `DONE` → `/undo` → file is back, user history is intact

###Definition of done
- The tests are green.
Parallel `DONE` does not create mixed commits.
- Run integration checks of previous PR
