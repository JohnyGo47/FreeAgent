# Spec: plan_execution
# Version: 1.0 — NEW
# Reading with ARCHITECTURE.md (§8 discharge, §10 parallelism)

## Goal
Approved plan is being implemented CLI mechanically. The orchestra only wakes up on exceptions.. This is the main mechanism for saving its context..

## Input
`PLAN` from the orchestrator after user confirmation (`spec_cli_plan_mode`)

## Output
- Agents' tasks in the order of dependencies
- Escalation to the orchestrator when deviating from the plan
- `NOTIFY: PLAN_COMPLETE` finish

## Contract

### Format of the plan
```typescript
interface PlanStep {
  step_id: number;
  agent_id: string;
  description: string;
  files: string[];        // What files are touched by the step - the basis of ownership control
  depends_on: number[];   // step_id, afterward
}
```

### Enforcement
```
1. CLI count depends_on
2. Steps without unclosed dependencies → ready to launch
3. Checking the intersection files ready-made:
     cross-over → perform consistently
     cross-over → parallelly
4. Sending. TASK, waiting RESULT
5. RESULT: DONE → verification (spec_verification)
     green-test → step-by-step, unlocking dependent
     red-test → escalation
6. Steps closed. → NOTIFY: PLAN_COMPLETE orchestrator
```

### When we wake up the orchestrator
Only in: `RESULT: FAILED`, red-test, `WRITE` outside `files`, agent `FAILED` after all, self-esteem below the threshold, plan is exhausted.

**On the happy journey, the orchestra does not receive a single message.** before `PLAN_COMPLETE`.

### Deduplication of statuses
`STATUS` with unchanged state, the orchestrator is not sent. Change of state - one line.

## Constraints
- **`WRITE` file-off `files` his step is deflected** s `ERROR` (ARCHITECTURE §10)
- Validation of the plan before launch: everything `agent_id` exist, no cycles in `depends_on`, No reference to non-existent `step_id`. A failed plan → Return to the orchestrator with a description of the problem, fail to
- The task of the agent in transition status (`SWITCHING`, `INITIALIZING`, …) — line up, post-delivery `READY`; The remaining lines of the plan continue
- The user may interrupt the execution (`/stop`) — Current tasks are being finalized, new ones don't go
- The plan builds a weak model and it will be wrong in places. — **The path of escalation is imperative and must be reliable.**

## Dependencies
`spec_cli_plan_mode`, `spec_verification`, `spec_message_bus_types`, `spec_cli`

## Tests
### Unit
1. Linear plan from 3 The steps are performed in order without the participation of the orchestrator.
2. Two independent steps with non-intersectional files → parallelly
3. Two steps with overlapping files → consistently, despite the absence depends_on
4. Cycle in depends_on → plan rejected before launch, nothing done
5. Non-existent agent_id plan → rejected with the indication of valid
6. `WRITE` outside files → `ERROR`, file-less
7. Red tests. → escalation to orchestrator with error text, Dependent steps don't start
8. Deduplication: 20 identical STATUS → orchestrator 0 message
9. Agent's task in `SWITCHING` → turn, post-delivery `READY`, the other branches are coming

### Integration check
The real plan for 4 step → full-time → The orchestrator received only `PLAN_COMPLETE`

### Definition of done
- Tests green.
- On the happy path, the number of messages to the orchestrator = 1
- Run. integration check'previous PR
