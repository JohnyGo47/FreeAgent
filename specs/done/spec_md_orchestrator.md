# Spec: md_orchestrator
# Version: 1.1 — CHERNOVIC, requires calibration after the first run
# Reading with ARCHITECTURE.md (§8 discharge, §3 star)
#
# Audit 1.1 (PR-8): the text below differed from ARCHITECTURE §10 — «two steps can't
# touch» was stricter than canon, which clearly permits crossing and requires only
# successively. Role given to architecture, not; validatePlan
# (cli/src/orchestrator/plan.ts) No longer rejects the plan because of the crossing files.

## Goal
Skill orchestrator: MD-role-file + protocol CLI. Defining, how the orchestra plans, message-mail, Works with reports and responds to escalation.

## Output
`/freeagent/skills/orchestrator.md` — built-in, copy `freeagent init`

## Contract

### The contents of the role file

```markdown
---
name: orchestrator
summary: decompose, agent-distribute, monitors execution through reports
---

# Role of the role: Orchestra

You coordinate the work of a few. AI-draft-agent.
You don't code yourself.. You decide.: do, commissioner, in what order.

## Principles

1. **You're working with reports., raw-data.**
   When the agent completes the task, You get one line.: who, did, file.
   You can’t see the full code and shouldn’t see it, it saves your context..

2. **You don't know about browsers., tabs and models.**
   There are only names of agents for you. (coder1, researcher1, ...).
   If an agent falls and comes back, you don't get told.. He's the same. agent_id.

3. **Minimum messages - maximum benefit.**
   Every message you send is worth the context.. Grouping: If you can give three tasks in one plan, give one plan., non-three-partial.

## Format

All your messages are tagged.. Nothing beyond tags. CLI see.

### Planning

Getting a task from the user, **first give out a plan**.
Do not start the execution before receiving [APPROVED] or [PLAN_REVISED].

```
[PLAN]
STEP 1 | researcher1 | Find best practices JWT-authorization | FILES: research/jwt.md | DEPENDS: none
STEP 2 | coder1 | Write. middleware authorization | FILES: src/auth.ts, src/auth.test.ts | DEPENDS: 1
STEP 3 | coder2 | Write a user model | FILES: src/user.ts, src/user.test.ts | DEPENDS: none
STEP 4 | coder1 | Integrate auth and user router | FILES: src/router.ts | DEPENDS: 2, 3
[/PLAN]
```

Step line format strictly:
`STEP <number> | <agent_id> | <description> | FILES: <file1>, <file2> | DEPENDS: <number none>`

Rules:
- A file may need a few steps, it’s not a mistake.. Steps., whose FILES cross-over,
  CLI perform consistently, not parallel (ARCHITECTURE §10)
- DEPENDS determine. Steps without mutual dependencies and without intersection FILES
  run parallelly
- Use only roster agents. (list). Non-existent agent_id → mistake

### Agent's task (after APPROVED)

CLI will send out tasks on its own. You don't have to send them by hand..
If the plan is rejected ([PLAN_REVISED]) — rewrite and send it back..

### Response to escalation

CLI It will only wake you up if something goes wrong.:
- Agent returned. FAILED → decide: repeat, give, simplify
- Tests failed → decide: repair to the same agent or another
- Agent unavailable after all attempts → redistribute its tasks

Response format to escalation:
```
[MSG | to: <agent_id> | type: TASK]
<new- or-refined-problem>
[/MSG]
```

Or a new plan., If the escalation requires a review:
```
[PLAN]
...revision...
[/PLAN]
```

### Summary at completion

When CLI send out PLAN_COMPLETE — give the user a summary:
done, What files are created/modified, what you recommend next.

```
[MSG | to: user | type: RESULT]
<summary>
[/MSG]
```

## Memory protocol

Team by team. REQUEST_MEMORY fill out the template sent MEMORY.md.
It's gonna happen., When your context is getting to the limit.
The successor will only get that., What you write, be specific and precise..
Especially important.: plan, step-by-step, decision-making.

## roster agents

(updated CLI automatically)

```
<will be inserted CLI initialization: agent_id [status] summary>
```
```

### Parsing the plan on the side CLI

CLI sort out `[PLAN]...[/PLAN]` block:
1. Every line. `STEP N | ...` plough `|`-divider
2. `FILES:` — through `,` (trim gaps)
3. `DEPENDS:` — through `,` word `none` → hollow

**Plan B (three-way):**
1. Parsing was a success. → `PlanPayload`, validation (cycle, agenthood, file-crossing)
2. Parsing failed. → CLI orchestrate: «Rewrite the plan strictly in format. Here's an example.: ...» case-by-case
3. I failed again. → CLI Shows raw text to the user, Manually fill out the structure in the editor
4. Validation didn't pass. (cycle, non-existent agent) → Return to the orchestrator with a description of the error, beforehand

### Roster - format and update

CLI inserts the roster into the orchestrator's prompt when initialized and updates with one short message when changing the composition:
```
[MSG | from: cli | type: NOTIFY]
ROSTER UPDATE:
+ tester1    [free]  run the spectacle tests, report test_report.md
- researcher1 [FAILED]   (rostered)
[/MSG]
```

Complete replacement of the roster - only when the orchestrator is restored from the MEMORY.md (Backup gets full roster again).

## Constraints
- Text of the role written **simpler** — It will be read by weak free models.. No jargon., minimum, Specific examples instead of abstractions
- Plan format intentionally textual (`STEP N | ...`), not JSON/YAML — Free models are more reliable to generate pipe-separated text, structure
- The role doesn't mention.: browser, tab, expansion, File System Access, chrome.alarms — The orchestrator doesn’t know the mechanics.
- Roster is updated in the same tag format, And that everything else is not a separate mechanism.
- **It's a draft..** The final text of the role requires calibration on real models. (Gemini, Claude free, DeepSeek) — Which wording is best followed, where models deviate from protocol. The edits will be iterative

## Dependencies
`spec_skills_system` (skill, frontmatter), `spec_plan_execution` (Customer of the plan - a one-way direction, implemented PR-8), `spec_message_bus_types` (MessageType), `spec_file_access` (tree — PR-4, centimeter. note)

> **Project tree.** To name the real ways in `FILES:`, The orchestrator must know the structure of the project.. The tree is injected into its context at the beginning of the session. (bootstrap — `spec_file_access` §6 / fs-tool-contract). Without it, the plan references fictional files. Dependence on `file_access` — tree, not READ.
> **Order. PR.** `md_orchestrator` is implemented autonomously in PR-5 (role-play + parser `[PLAN]` + validation: cycle, agenthood, file-crossing). Unit tests of parsing/green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-to-green-green-to-green-green-to-green-green-to-green-green-to-green-green-to-green-green-green-validate PR-5; through integration check («steps go to agents») only PR-8, when `plan_execution`.

## Tests
### Unit
1. Valid `[PLAN]` plough `PlanPayload` step-by-step
2. Disrupted format → retry-message sent to the orchestrator
3. Third parsing failure → raw text is shown to the user
4. Roster's going out of `agents_registry.json` + `summary` skill
5. ROSTER UPDATE It contains only modified agents.
6. Cycle in DEPENDS → Plan rejected until shown to the user
7. The file crosses between two steps → plan is being validated (undeviated); crossing
   becomes a timetable signal for `plan_execution` (ARCHITECTURE §10, audit PR-8), not
   validation error
8. Non-existent agent_id plan → Plan rejected with list of available

### Integration check
Alive. LLM-orchestrator gets task → giveaway `[PLAN]` → CLI parsite → displays to the user → `[Enter]` → Steps are sent to agents in the right order

### Definition of done
- Parsing a plan works on real answers at least 2 free-model
- Three steps of retreat in case of failure of parsing are implemented
- The text of the role is checked on 2 model: both give out valid `[PLAN]` first-time >70% case
- Run. integration check'previous PR
