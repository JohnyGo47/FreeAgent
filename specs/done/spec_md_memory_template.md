# Spec: md_memory_template
# Version: 2.0
# Reading with ARCHITECTURE.md (§7 memory is written constantly)

## Goal
Format MEMORY.md, It reliably fills any free model and consumes any other model.. Plus the fullness validator..

## Output
- `/shared/templates/MEMORY_TEMPLATE.md`
- `validateMemory(md: string)` escaping `/shared`

## Format
```markdown
# MEMORY: {agent_id}
# Generated: {ISO timestamp}
# Task: {task_id or NONE}

## Current state
One paragraph: What I am doing now and what step I have taken..

## Completed
- Completed sub-tasks (what not to redo)

## In progress
What started but not finished: What files are touched, modified, what's left.

## Key decisions
- Decisions made with reasons (and that their successors should not re-examine them.)

## Files touched
- `path/to/file` — done

## Next steps
1. Step., proceed
2. ...

## Warnings
Grabley., which have already been.
```

## Constraints
- Mandatory sections: `Current state`, `Next steps`. The rest may be `NONE`
- Maximum 4000 symbolism. If the agent is over-sized, cuts on priority: `Warnings` < `Key decisions` < `Completed`. `Current state` and `Next steps` no cut
- Only plain markdown: without HTML, without nested code blocks deeper than one level (break the tag-format injection)
- **It is generated after each completed task.**, Not when the context threshold is reached. (ARCHITECTURE §7). The threshold means «switch-over», not «save-time»
- When switching to backup, the template is sent **fully online**, non-skill
- Save in `/freeagent/memory/<agent_id>.md`, Rewriting the previous version is acceptable (history git-checkpoint)

## Dependencies
`spec_skills_system` (section Memory protocol role-play), `spec_fs_folder_access`

## Tests
### Unit
1. Complete pattern → `validateMemory` ok
2. No `Next steps` → section-name error
3. > 4000 symbolism → warning, fault (long memory better, nothing)
4. `NONE` optionally → ok
5. A code block is deeper than one level → warning

### Integration check
Real-life free model fills out template on toy task → validation is taking place → feeding **other** question-model «next» → response Next steps

### Definition of done
- Tests green., Transferring the context between two different LLM hand-approved
- `spec_agent_recovery` and `spec_backup_agents` refer to this format, do not describe
- Run. integration check'previous PR
