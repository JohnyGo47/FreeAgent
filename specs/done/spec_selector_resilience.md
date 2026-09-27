# Spec: selector_resilience
# Version: 2.0 — Adapter scheme is not duplicated
# Reading with ARCHITECTURE.md, adapter scheme spec_llm_adapter_registry

## Goal
DOM-selectors rot: Services change layout without warning. Turning a major weakness into an open source advantage: fallback-chain, self-healing confirmatory, community-registry through GitHub.

## Input
- Local. `llm_adapter_registry.json` + `selector_overrides.json`
- Remote. registry posteriorly `registry_url` configurable
- DOM current page

## Output
- Work selector (chain → fresh registry → proof-of-use)
- Updated. `selector_overrides.json`
- Optionally.: pre-filled reference GitHub issue new-selector

## Contract

### Permission procedure
```
local override → chain registry orderly → self-healing heuristic → BLOCKED
```

### Self-healing
Candidate heuristics:
- **input** — largest visible `[contenteditable=true]` or `textarea` vent viewport
- **submit** — near- input button aria-label/shipment icon or `type=submit`
- **response_container** — container with maximum text growth in the following **real** reply. Test messages are not automatically sent

**Never used silently.** Candidate highlighted outline, user/reject («This is the input field.? ✓ / ✗»), non-modal. Prior to confirmation, agent status `SELECTOR_BROKEN`, task-suspend.

Status on the register writes CLI (scattering) — register writer'?.

### Community-registry
- Verification of updates once in a while 24? (`chrome.alarms`) posteriorly `registry_version` s GitHub raw
- Network error → quietly
- The confirmed selector is written in override **locally**; dispatch community — Only by explicit user action (no automatic telemetry)
- In the repo: CI-check-up PR, CONTRIBUTING-section «How to fix a selector» how first-issue

## Constraints
- **The adapter is defined in `spec_llm_adapter_registry` and it's not overridden here..** Selectors are already arrays., `registry_version` already
- `registry_url` Configuration - Forks indicate their

## Dependencies
`spec_llm_adapter_registry`, `spec_ext_manifest`, `spec_fs_folder_access`

## Tests
### Unit
1. Chain.: first selector null, second-in-command → second-hand, breakdown secured
2. Override priority registry
3. Heuristics input fixture Gemini-finds such a layout contenteditable
4. Candidate without confirmation is not used, agent `SELECTOR_BROKEN`
5. `registry_version` higher → locally updated; down or the net fell → intact
6. Status `SELECTOR_BROKEN` enters the register through CLI, not directly from the expansion

### Integration check
Break the selector input for one service in a local registry → extension highlights the candidate → confirmation → agent, override preserved

### Definition of done
- Tests green., integration check passed
- Adapter circuit is not duplicated
- Run. integration check'previous PR
