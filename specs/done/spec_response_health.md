# Spec: response_health
# Version: 1.0 — substitute spec_service_unavailable_handling
# Reading with ARCHITECTURE.md (§6 observation, §7 backup)

## Goal
Classification of response, came, but not a worker, and apply the right medicine.. Four classes: four reactions.

## Input
- Text of the reply DOM + result `fromTagFormat`
- `failure_patterns` and `context_window` adapter
- The trader's symbol counter

## Output
- `RESPONSE_HEALTH` escaping incoming classy
- Reaction CLI classwise

## Contract

| Class class | Sign. | Reaction CLI |
|---|---|---|
| `unavailable` | pattern `failure_patterns.unavailable` | backoff 30/60/120s, forwarding **tab** |
| `rate_limited` | pattern `rate_limited` | backup (`spec_backup_agents`) |
| `context_full` | pattern `context_full` **or** counter ≥ threshold | backup |
| `no_tags` | reply < 200 symbolism **and** `fromTagFormat` empty | ask back with a format reminder, **maximum 3 try**, later `NOTIFY` user |

**Heuristics `no_tags`:** once-not-trigger (The model may not have understood the prompt), two in a row, trigger.

## Constraints
- **Detection in expansion** (see DOM), **timers and decisions in CLI** (rule MV3, ARCHITECTURE §5)
- Counter. `service_unavailable_attempts` counter-independent recovery — Inaccessibility of the service should not cancel attempts, fault-proof
- Backoff-parameters are configured in `freeagent.config.json` (Default values require calibration to real Kimi/Grok)
- While it's going backoff, status `SERVICE_DOWN` — `spec_agent_recovery` That status is ignored
- After exhaustion backoff: `NOTIFY` list-list = **service-wise registry except for the fallen** (No role filtering – adapters are tied to domains, roleless; select)
- The task is not automatically reassigned – only at the explicit choice of the user.
- Reconnect.: same `agent_id`, role, new `llm_url`; orchestrator not notified

## Dependencies
`spec_message_bus_types`, `spec_llm_adapter_registry`, `spec_init_agent`

> `response_health` classify the answer and write `RESPONSE_HEALTH` tire-wire. **What to do next** decider CLI: for `rate_limited`/`context_full` logicizes `spec_backup_agents`, for `unavailable` — backoff. There is no inverse dependence.: `response_health` He doesn't know about backups..

## Tests
### Unit
1. Each of the four classes is detected by its own characteristics.
2. `no_tags`: once-not-trigger, two in a row, trigger
3. Backoff: 3 pause-and-pause, counter recovery change
4. `context_full` counter-meter (patternless) → backup
5. Post-exhaustion candidates backoff — all services except the fallen
6. `no_tags` three-time → `NOTIFY` User with a description of the problem and service, fourth attempt is not made
7. Orchestra receives no messages about changing service

### Integration check
Simulate the text of refusal Kimi → backoff → substitution CLI → reconnector, task

### Definition of done
- Tests green.
- `SERVICE_DOWN` distinguishable `FAILED` conclusionally `freeagent agents`
- Backoff and heartbeat-recovery They never work at the same time with one agent.
- Run. integration check'previous PR
