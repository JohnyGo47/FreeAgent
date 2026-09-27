# Spec: cli
# Version: 1.0 - NEW
# Read along with ARCHITECTURE.md (§2 CLI, §12 mechanical truth, §13 dialogue)

## Goal
CLI framework: commands, ink interface, bus merge cycle, agent registry, user responses from mechanical truth.

## Output
`freeagent` binary with commands and live TUI.

## Contract

### Teams
```
freeagent init create /freeagent/, config, check git
freeagent start start coordination (main process)
freeagent do "<task>" send task to orchestrator
freeagent agents list of agents: status, service, context %
freeagent log [N] latest bus events
```

### Intra-session commands (in TUI)
```
/status what's happening now
/agents same as freeagent agents
/log events
/files what files were recorded in this session
/btw <text> message to orchestrator (rare operation)
/mode plan|yolo switch mode
/stop interrupt plan execution
/undo [task_id] checkpoint rollback
```

**`/status`, `/agents`, `/log`, `/files` respond from the bus mechanically** - the orchestrator is not alarmed, the context is not wasted (ARCHITECTURE §13).

### Main loop
```
1. merge incoming/*.jsonl → message_bus.jsonl (seq assignment)
2. processing new messages: routing, file recording, verification
3. writing commands to commands/<instance_id>.jsonl
4. TUI update
```

### Output to the user - two layers
Mechanical truth (files, statuses, context, exit codes) **plus** orchestrator summary. Not instead, but next to it. **If there is a discrepancy in law, it is mechanical** (ARCHITECTURE §12).

###Priority of messages from the user
`from: user` goes to the beginning of the injection queue for the orchestrator.

## Constraints
- **One CLI session per project** - the only writer of the main bus and registry
- CLI completion: agents remain in tabs. At the next `start` - the registry is checked against reality: for each agent there is a `TAB_STATE` request, the living ones return to work, the dead ones are marked. Do not consider the registry trustworthy after restart
- Addressee validation: `to: <non-existent>` → `ERROR` with a list of valid `agent_id`
- Task buffer for agents in transitional status (not `IDLE`/`WORKING`)
- Ink components do not block the main loop - rendering is asynchronous

## Dependencies
`spec_message_bus_read`, `spec_message_bus_write`, `spec_config`, `spec_message_bus_types`

## Tests
### Unit
1. `merge` collects from several incomings in the correct order with a monotonic `seq`
2. `/status` responds without a single message to the orchestrator
3. Validation of the recipient: non-existent `agent_id` → `ERROR` with a list
4. Buffer: the task is delivered to the agent in `SWITCHING` after `READY`
5. CLI restart: registry is checked against `TAB_STATE`, dead agents are marked
6. Two simultaneous CLI sessions → the second one refuses to start with a clear error

### Integration check
Full cycle: extension writes to incoming → CLI merges → routes → TUI shows current statuses

### Definition of done
- Tests are green
- No response to `/status`, `/agents`, `/log`, `/files` requires LLM participation
- Running integration checks of previous PRs
