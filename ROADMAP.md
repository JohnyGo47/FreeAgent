# FreeAgent Roadmap

FreeAgent is in beta. The initial architecture and the complete browser-to-CLI workflow are implemented; current work is focused on reliability, usability, and broader live validation.

## Implemented

- Project initialization and project-local runtime state
- Manifest V3 extension with popup, background, offscreen, and content contexts
- Browser tab registration and role-specific INIT prompts
- Durable message bus with cursors, locking, deduplication, and rotation
- Agent lifecycle, reconciliation, recovery, and backup-agent support
- Structured plans with dependencies, approval, file ownership, and escalation
- Controlled read, list, search, write, and edit operations
- Secret exclusion and masking
- Allowlisted test execution with real exit-code verification
- Git checkpoints and task-level undo
- Selector fallback and response-health detection
- Live multi-agent ChatGPT workflow validation

## Near-term priorities

1. Exercise write, checkpoint, and undo behavior repeatedly in disposable live projects.
2. Add live adapter validation for additional supported LLM sites.
3. Improve setup diagnostics when the CLI, selected directory, and browser registration do not match.
4. Add release packaging so users do not need to run the CLI directly from TypeScript source.
5. Add CI for tests, type checking, and extension builds.

## Later

- Signed extension distribution
- Better observability for message queues and agent state
- Adapter compatibility reporting
- Guided recovery for changed browser selectors
- Cross-platform installation and update commands

Architecture changes should be recorded in `ARCHITECTURE.md`; implementation details belong in focused specs and tests.
