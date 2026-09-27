# Spec: init agent
# Version: 2.0
# Read with ARCHITECTURE.md (§15 initialization, §14 role)

#Goal
A single `initializeAgent(agent, extraContext?)` procedure used in four scenarios: initial creation, recovery, backup activation, reconnect after service failure.

#Input
Flow A: tab selected by the user in the extension UI + role from `/skills/`
Flow B: `llm_url` + Role from the Registry (software discovery)
`llm_adapter_registry` - selectors
Optional `extraContext` (RECOVERY CONTEXT / MEMORY) md)

#Output
`REGISTER_REQUEST` → CLI assigns `agent_id` → `agents_registry.json`
Injected INIT prompt → agent responds `[READY]` → status `IDLE`
`NOTIFY: AGENT_READY`, orchestra roster updated

##Contract ##

###Two floats, one code
**Flow A – pinning (person).** User opened chat and logged in → click extension → “make an agent” → role selection from the list (list = MD files `/skills/` with valid frontmatter) → expansion send `REGISTER_REQUEST` with `tab_id`.

Solves authorization by construction: chat is open → login is executed → the desired account is selected.

**Flow B is a software discovery (system).** `chrome.tabs.create({ url, active: false })` + injection. Used recovery and backup activation. It only works where the input is already made; otherwise, `BLOCKED: auth_required`.

##### Assignment of agent id
CLI is the only writer `agents_registry.json`
`agent_id` = `<role><N>`, where N is the minimum free number for this role.
- Extension ** does not write registry** - only `REGISTER_REQUEST` in its incoming

### INIT-prompt (tag-text, translation layer)
```
[INIT: {agent_id}]
You — {role}. You work the system. FreeAgent.
{full-length MD role}
{extraContext, if transferred}
Answer me. [READY] when ready to take on tasks.
[/INIT]
```##Constraints
- Timeout waiting `READY`: 60c → `INIT_FAILED` + `NOTIFY`. It's a ***** recovery-failed, recovery attempts are not wasted
- `needs_auth: true` + detected login form (no `input` selector) → `BLOCKED`, no injection
- The role without the obligatory `summary` in the frontmatter does not appear on the list (`spec_skills_system`)
The orchestra is created by the same flow with the role of `orchestrator` - there is no separate path.

## Dependencies
`spec_message_bus_types`, `spec_message_bus_write`, `spec_llm_adapter_registry`, `spec_fs_folder_access`, `spec_skills_system`

## Tests
################################################################################################################################################################################################################################################################
1. `agent_id` is unique: second coder → `coder2`; after deleting coder1, the next coder is free.
2. `READY` in time → `IDLE`; silence 60c → `INIT_FAILED`, recovery attempts untouched
3. `needs_auth` + login-form → `BLOCKED`, no injection
4. The registry is not written from the extension code (grep in CI: no `agents_registry` entry in the expansion bundle)
5. `extraContext` is inserted into the designated template location.
6. The orchestra is created with the same code as a normal agent.

###Integration check
Live tab: add agent via popup → `READY` → `freeagent agents` shows `IDLE` → send a test task

###Definition of done
- Green tests, manual check on 2 different LLMs
Recovery, backup and reconnect reuse `initializeAgent` – no duplication
- Run integration checks of previous PR
