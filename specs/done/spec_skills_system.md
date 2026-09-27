# Spec: skills_system
# Version: 1.0 — NEW
# Reading with ARCHITECTURE.md (§14 role, §8 roster)

## Goal
Role like MD-file-in `/skills/`. Users put their files - the role is available. There is no hard-to-cut list.. Isa frontmatter assembling a compact roster for the orchestrator.

## Input
Directory `/freeagent/skills/*.md`

## Output
- List of available roles for UI expansion
- roster for orchestrator: `agent_id [status] summary`
- Validation errors on invalid files

## Contract

### Skill format
```markdown
---
name: seo_auditor
summary: Website audits for technical SEO, report audit.md
---

# Role of the role
... full description, protocol, format ...

## Memory protocol
Mention, command REQUEST_MEMORY I need to fill out the template..
```

- `name` — mandatory, uniquely, slug (`[a-z0-9_]+`), prefixed `agent_id`
- `summary` — **mandatory**, line ≤ 120 symbolism. It's a roaster that's built out of.
- File without validation frontmatter → not appearing on the list, slip-up `NOTIFY`

### roster for orchestrator
```
coder1       [free]  Writes and edits code on specks, TypeScript/Node
researcher1  [work]  web-search, file
seo_auditor1 [free]  Website audits for technical SEO, report audit.md
```
Updated when the composition of agents or their status changes. Complete. MD The orchestrator is not assigned roles; he routs, not.

### Built-in skills
Supplied as a set, copy `freeagent init`, user can rule: `orchestrator`, `coder`, `tester`, `researcher`, `reviewer`.

skill `orchestrator` supplement: planning (hand out `[PLAN]` before), addressing (`to: agent_id`), summary.

## Constraints
- Skills read extension through FSA (role-list) and CLI (pyre)
- Changing the skill file does not affect the agents already initialized, the role in their context is fixed when the agent is not identified. INIT
- `summary` should not contain translations of lines - breaks the assembly of the roster

## Dependencies
`spec_fs_folder_access`

## Tests
### Unit
1. Valid skill parses, listing
2. No `summary` → rejected
3. Duplicate `name` → rejected, mistake
4. `summary` longer 120 symbolism → cut off warning
5. Roster is made up of active agents with correct statuses.
6. Five built-in skills are validated

### Integration check
Put the custom skill in `/skills/` → He appeared on the list of roles in UI → squirt out → his summary seen in the roster of the orchestrator

### Definition of done
- Tests green., custom skill works end-to-end
- Not a single hard-to-digest list of roles in the code
- Run. integration check'previous PR
