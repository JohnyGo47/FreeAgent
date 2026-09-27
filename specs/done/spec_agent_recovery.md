# Spec: agent_recovery
# Version: 3.0 - reactive, no timeouts
# Read along with ARCHITECTURE.md (§6 observation, §16 cross-browser limitation)

## Changelog
v2.x was built on a heartbeat timeout (150s of silence = agent fell). Heartbeat from LLM has been removed - the model does not send messages on its own initiative, a healthy waiting agent would be considered dead. Now the tab state is observed directly through `chrome.tabs`, the reaction is reactive.

## Goal
The extension sees that the agent tab is dead → reports `TAB_STATE` → CLI decides → command to restore → agent is reinitialized under the same `agent_id`.

## Input
- `TAB_STATE` from extension: `closed` | `wrong_domain` | `selectors_broken`
- `agents_registry.json`: `agent_id`, `role`, `llm_url`, `md_path`, `instance_id`, `tab_id`, `status`, `attempts`
- `MEMORY.md` agent, if available

## Output
- CLI → `COMMAND: RECOVER_AGENT` in `commands/<instance_id>.jsonl`
- Extension: new tab + role injection and `RECOVERY CONTEXT`
- After `READY`: status `IDLE`, `NOTIFY: AGENT_RECOVERED`, tasks from the queue have been delivered

## Constraints
- **No detection timers** - the extension reports changes in the tab state
- Maximum 3 attempts in a row → `FAILED`, `NOTIFY`, agent tasks stopped
- Do not restore in `SWITCHING`, `SERVICE_DOWN`, `STANDBY`, `FAILED` statuses
- **Cross-browser recovery is not possible** (ARCHITECTURE §16.1): the command goes to the instance where the agent was registered. If that browser is closed, the command waits in the file, `NOTIFY` to the user
- Tasks addressed to an agent outside of `IDLE`/`WORKING` (in transitional status) are **buffered by the CLI** and delivered after `READY`
- `llm_url` is unavailable (no network) → immediately `FAILED`, no attempts are wasted
- Reuses `initializeAgent` from `spec_init_agent` - the procedure is not duplicated

## Dependencies
`spec_message_bus_types`, `spec_message_bus_read`, `spec_init_agent`, `spec_md_memory_template`

## Implementation notes
```typescript
// CLI - reaction to TAB_STATE, without polling
onBusMessage('TAB_STATE', async (msg) => {
  const { agent_id, state } = msg.payload as TabStatePayload;
  if (state === 'alive') return;
  const agent = registry.get(agent_id);
  if (SKIP_RECOVERY.has(agent.status)) return;
  if (++agent.attempts > 3) return markFailed(agent);
  agent.status = 'INITIALIZING';
  writeCommand(agent.instance_id, { command: 'RECOVER_AGENT', agent_id });
});
```

The recovery prompt is a text tag (translation layer), containing the full MD of the role + the `[RECOVERY CONTEXT]` block with MEMORY.md or a note about its absence.

## Tests
### Unit
1. `TAB_STATE: closed` → restore command sent immediately, without waiting for a timeout
2. Recovery is not triggered in the `SWITCHING`, `SERVICE_DOWN`, `STANDBY`, `FAILED` statuses
3. After 3 attempts - `FAILED` + `NOTIFY`
4. The agent with MEMORY.md receives RECOVERY CONTEXT; without it - basic prompt
5. The task sent to the agent in `INITIALIZING` is buffered and delivered after `READY`
6. The command for the closed browser remains in the file, the user is notified
7. The extension code does not have `setInterval` in recovery modules (grep in CI)

### Integration check
Close the agent tab manually → the command left on the nearest tick `chrome.alarms` → the agent responded `READY` → the buffered task was delivered

### Definition of done
- Tests are green, manual check on 2 different LLMs
- All decision logic in the CLI; the extension only reports state and executes commands
- Running integration checks of previous PRs
