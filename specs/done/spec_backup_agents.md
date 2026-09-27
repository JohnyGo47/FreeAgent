# Spec: backup_agents
# Version: 1.0 - NEW
# Read along with ARCHITECTURE.md (§7 memory and backups)

## Goal
Hot backup: the user opens and marks a spare tab in advance. When the context or limit is exhausted, the agent moves to it along with the memory, saving `agent_id`.

## Input
- User: open tab with a logged-in model + “make a backup for `coder1`” in the extension UI
- Toggle signal: `context_full` / `rate_limited` from `spec_response_health`

## Output
- Recording a backup in `agents_registry.json`: `{ backup_for: 'coder1', instance_id, tab_id, llm_url, status: 'STANDBY' }`
- After switching: `coder1` points to the former backup tab, `NOTIFY: AGENT_SWITCHED`

## Contract

### Registering a backup
The same flow as a regular agent (`spec_init_agent`, flow A), but with the `is_backup_for` flag. The role is injected immediately - the tab is initialized, the status is `STANDBY`.

### Switching procedure
```
1. CLI: agent status → SWITCHING, incoming tasks to queue
2. CLI → agent: COMMAND: REQUEST_MEMORY with FULL template MEMORY.md inline
3. The agent gives MEMORY.md → CLI saves to /freeagent/memory/<agent_id>.md
4. CLI → backup instance: COMMAND: ACTIVATE_BACKUP + MEMORY.md
5. Extension injects MEMORY into the backup tab
6. Backup responds READY
7. Registry: agent_id → new instance_id/tab_id; the old tab is marked as gone
8. Status `IDLE`, task queue delivered
```

**The MEMORY template is sent inline, and not “write as in the skill”** - at this point the role lies at the beginning of a long thread, the model’s attention to the distant context degrades (ARCHITECTURE §7).

### Checking backup vitality
The extension periodically (`chrome.alarms`) checks that the backup tab is alive and on the correct domain. This is a tab state check, **not a model message** - the backup context is not wasted. Rotten → `NOTIFY` user to re-login.

## Constraints
- The backup can be in any instance, including another browser/profile - the command goes to its `commands/<instance_id>.jsonl`
- **If the browser with the backup is closed** - the command is waiting in the file, there will be no instant switching (ARCHITECTURE §16.7)
- One backup per agent in MVP; backup chains are not supported
- Backup without MEMORY.md (the agent did not have time to give it) - activated with reconstruction from the bus: last `TASK` + list of recorded files
- The orchestrator is not notified about the switch - `agent_id` is saved
- If there is no backup, but `context_full` worked - `NOTIFY` to the user with a proposal to assign a backup; tasks in queue

## Dependencies
`spec_init_agent`, `spec_md_memory_template`, `spec_message_bus_types`

> The backup is activated by the decision of the CLI when it receives `RESPONSE_HEALTH` with the class `context_full`/`rate_limited`. But `backup_agents` does not depend on `response_health` - it accepts the switch command without knowing who initiated it.

## Tests
### Unit
1. Registering a backup → status `STANDBY`, role is injected, tasks do not arrive
2. `context_full` → full switching procedure, `agent_id` unchanged
3. Tasks during `SWITCHING` are buffered and delivered after `READY`
4. Backup without MEMORY.md is activated with the reconstructed context
5. Closed backup browser → command in file, `NOTIFY`, without crashing
6. No backup with `context_full` → `NOTIFY`, the queue is not lost
7. Orchestrator does not receive switch messages

### Integration check
Assign a backup to another profile → artificially lower the context threshold → wait for the switch → the agent continues the task with the saved memory

### Definition of done
- Tests are green, integration check passed on two browser profiles
- Backup liveness check does not send messages to the model
- Running integration checks of previous PRs
