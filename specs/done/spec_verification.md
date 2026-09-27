# Spec: verification
# Version: 1.0 — NEW
# Reading with ARCHITECTURE.md (§9 verification)

## Goal
`RESULT: DONE` faithless. CLI establishes the fact of running tests.

## Input
- `WRITE` field-wise `kind: 'test' | 'code' | 'doc' | 'data'`
- `TESTS_READY` launcher
- Section Tests fumble (if the problem is on the line)

## Output
- Verdict: step-by-step / escalation
- Log of a run in `/freeagent/logs/`

## Contract

### Step protocol
```
1. agent → WRITE kind:test    (The test is written first.)
2. agent → WRITE kind:code
3. agent → TESTS_READY { task_id, command: "npm test -- auth.test.ts" }
4. CLI launcher
     exit 0  → step-by-step
     exit ≠0 → escalation to orchestrator stderr
```

CLI guessless, test, What the code is, the agent declares the field `kind`.

**Launching. CLI, agent.** Agent., self-examining, — same-copy, hallucinatory.

### Whitelist of teams
Only allowed.: `npm test`, `npm run test:*`, `pnpm test`, `yarn test`, `pytest`, `go test`, `cargo test`, `jest`, `vitest` (+ reasoning).

Everything else. → `ERROR`, command fails. Without that, we gave a weak model of Shell..

timeout: 120default, configure.

### Signs of failure without participation LLM
- explicit `RESULT: FAILED`
- non-zero exit code
- stated `WRITE` file, which is not on the disk after recording
- no `RESULT` timeout
- `self_assessment.percent` below-threshold (default 70)

### Self-esteem is the second layer
For tasks without mechanical tests (cross-section, documentation, revue) CLI add to the final request: «Rate your work as a percentage and explain why.». The answer goes in `ResultPayload.self_assessment`.

Applicable **Only at the end of the major steps** — Question and answer waste context.

> Limitation: polled, wrong-headed. Correlation weak. On the tested tasks – an auxiliary signal.

### Test name reconciliation
If the task is on the speck with the section Tests — CLI check, that the names of the tests running correspond to those listed in the speck. Disparity → warning conclusion (block out).

## Constraints
- Tests are run in the project directory, time-out, conclusion
- The first step of any speck cannot be verified by tests., which are not yet there, if `TESTS_READY` I didn't come., step-close `RESULT: DONE` marked `unverified` log-in CLI
- **A known limitation:** Agent can write a test, passing (`expect(true).toBe(true)`). Mechanically indistinguishable. Name reconciliation is a partial measure. Tests are not absolute ground truth, a the best available (ARCHITECTURE §9)

## Dependencies
`spec_message_bus_types`, `spec_cli`

## Design note
Verification doesn't know about the plan. She gets the task., test, code and returns verdict: «ok» or «failure + erroneous». Who called her is none of her business.. Top layer (`plan_execution`) trigger verification function, There is no inverse dependence.

## Tests
### Unit
1. `TESTS_READY` whitelisted → launch, verdict exit code
2. Team off-whitelist (`rm -rf /`, `curl ...`) → `ERROR`, failed
3. timeout → step-marked, dead-end
4. `WRITE` stated, No file on the disk → failure
5. `self_assessment` below-threshold → escalation, even in the face of `DONE`
6. Step without `TESTS_READY` → closed `unverified`, logged
7. Test names diverge from the speck → warning, step not blocked

### Integration check
Agent writes test and code on a simple speck → CLI drive away → green → step-by-step. Then, you can put in a code that's obviously broken. → red → escalation

### Definition of done
- Tests green.
- No team outside the whitelist can be executed through an agent.
- `unverified` steps visible to the user, not given out as verified
- Run. integration check'previous PR
