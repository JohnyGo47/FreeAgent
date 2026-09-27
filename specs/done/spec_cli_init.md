# Spec: cli init
# Version: 1.0
# Read with ARCHITECTURE.md (§15 initialization), spec config, spec fs folder access

#Goal
`freeagent init` is the first user command. Creates a service structure, configures git, copies built-in skills, generates a config. After that, the project is ready to connect the expansion.

#Input
Current working directory (root of the project)
Optional flags: `--no-git` (skip the git check), `--force` (rewrite the existing structure)

#Output
- `/freeagent/` with the entire structure of `spec_fs_folder_access`
`freeagent.config.json` with `project_id` and silences
- `/freeagent/skills/` with 5 built-in skills: `orchestrator.md`, `coder.md`, `tester.md`, `researcher.md`, `reviewer.md`
`.gitignore` is supplemented with the `/freeagent/` string (if git is available)
`.freeagentignore` with default rules (from `spec_context_privacy_filter`)

#Contract #

### Procedure
```
1. Check.: Don't you? /freeagent/
     eat, without --force → message «already initialized, use --force»
     eat, on --force → continue (configuration, skill)

2. Check. git:
     git init done → ok
     no git → propose «git init?» interactively
       yes → git init
       no (or --no-git) → warning «checkpoints disabled» at each session

3. Create /freeagent/ whole structure (idempotently)

4. Generate freeagent.config.json:
     project_id: UUID
     default (from spec_config)

5. Copy built-in skills in /freeagent/skills/
     unless there is a file with that name. (Do not overwrite user edits)

6. Create .freeagentignore defaulted (unless there is)

7. Add /freeagent/ into .gitignore (if git, And the line's gone.)

8. Get out.:
     ✓ Project initialized
     project_id: <uuid> (Show it in the extension for binding)
     Next step.: Set the extension and select this folder.
```##Constraints
Idempotence: Repeated `init` without `--force` does not break the existing - only reports
`--force`: Config and structure recreated, but `skills/*.md` and `.freeagentignore` are not overwritten (user edits saved)
Built-in skills lie in `/cli/templates/skills/` in npm-package, copied when init
Do not modify project files other than `.gitignore` (one line) and create `/freeagent/`
- Works without extension - CLI and extension are later linked via `project_id`

## Dependencies
`spec_config` (complete) Soft (code from future PR does not require, `cli_init` is implemented autonomously in PR-3): `spec_git_checkpoints` - only `git` is needed in PATH for `git init` and `/freeagent/` strings in `.gitignore`, not the logic of checkpoints; `spec_skills_system` - built-in skills are copied as ZXPLAZ files from ZXLQPLACEX17.

## Tests
#
1. Clean folder → full structure, config with UUID, 5 Skills, `.freeagentignore`
2. Repeated `init` without `--force` → message, nothing touched
3. `--force` → Config recreated with the new `project_id`, skills intact
4. Without git, without `--no-git` → interactive question; with `--no-git` → warning, sequel
5. `.gitignore` already contains `/freeagent/`
6. Existing `coder.md` in Skills → Unrecorded, New Skills Completed

###Integration check
`freeagent init` in an empty folder → expander selects the same folder → `project_id` matches → `freeagent start` → TUI shows “0 agents, ready to go”

##Definition of done
- The tests are green.
The user can start from scratch in 2 commands: `freeagent init` + install extension
Run integration checks of previous PR
