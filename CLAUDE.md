# Repository Working Rules

These rules apply to coding work in the FreeAgent repository.

## Before changing code

1. Read `ARCHITECTURE.md` for component boundaries and invariants.
2. Read `STACK.md` for platform constraints.
3. Inspect the relevant implementation and tests before editing.

## Scope

- Implement only the requested change.
- Preserve the separation between `shared`, `cli`, and `extension`.
- Do not bypass the CLI filesystem or verification boundaries.
- Do not edit architecture decisions as a side effect of an unrelated task.
- Treat files in `specs/done/` as implemented behavior references.

## Tests

- Add or update a focused test when behavior changes.
- Prefer a failing test before the implementation when practical.
- Run the focused test, then the complete suite.
- Before handoff, run `npm test`, `npm run typecheck`, and `npm run build -w extension`.

## Extension constraints

- Keep the extension compatible with Manifest V3 suspension.
- Use `chrome.alarms` for background scheduling.
- `setInterval` is allowed only in `extension/src/content/`.
- Keep DOM-specific behavior behind adapter and selector resolution logic.

## Completion

- Do not claim that tests passed unless their real command completed successfully.
- Preserve unrelated user changes.
- Keep runtime state, generated bundles, dependencies, credentials, and editor files out of Git.
