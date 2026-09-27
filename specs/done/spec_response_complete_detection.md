# Spec: response_complete_detection
# Version: 1.0
# Reading with ARCHITECTURE.md (§6 observation)

## Goal
Determine the moment, when LLM finished streaming. Without it, the parser will read half the answer..

## Input
- DOM tab LLM
- `selectors.typing_indicator` adapter (maybe `null`)
- `selectors.response_container`

## Output
- event `responseComplete` full-text

## Contract

### Three strategies, priority

**1. Typing indicator (if).** Selector `typing_indicator` The adapter indicates the element, generational (spinner, cartoon, «printer...»). Strategy:
```
indicator appeared → response
indicator disappeared → debounce 500ms → responseComplete
```
Debounce needle: Some interfaces flash an indicator between chunk'mi.

**2. Mutation debounce (universal fallback).** `MutationObserver` on `response_container`. No mutations. N seconds → reply completed.
```
mutation → time-off
timer's out (2 default) → responseComplete
```
Meaning. 2 second-to-second compromise: The model on the slow server can pause until ~1.5 squat chunk'mi, longer 2 seconds, probably ready.. Configurable per-adapter.

**3. Stop button as a signal.** Some interfaces show a button. «stop generation» during the streaming and cleaned up after. If the adapter knows her selector (`selectors.stop_button`, field-off) — Her disappearance confirms typing indicator.

### Choosing a strategy
```
typing_indicator not null → strategy 1 (+ strategy 3 proof, if stop_button eat)
typing_indicator null    → strategy 2
```

Strategy 2 It always works as insurance.: even typing_indicator numb (for example, CSS-The class changed and the selector broke down.), through 2 sack mutation debounce finish.

### Text of the reply
`responseComplete` giveaway `innerText` last-child `response_container` (last-minute, not-all-tread). Definition «last»: maximum DOM-naturally, text, post-injection.

## Constraints
- It works. **only content script**
- `MutationObserver` tuned `{ childList: true, characterData: true, subtree: true }` on response_container — not-all-page (productivity)
- Debounce-The timer is canceled with a new injection (The next message came, previous response «finished» — Take what you've got.)
- False early activation (model paused > 2 sack, then continued) — permissible: `fromTagFormat` You won't find a full block of tags., And the next time you actually finish, the parser will collect the full text.. Worst case — single `no_tags` before the real answer
- Maximum waiting time: 5 minute. If the answer is not completed, the compulsory `responseComplete` + `RESPONSE_HEALTH: no_tags` (It's probably a dead model.)

## Dependencies
`spec_llm_adapter_registry` (selectors), `spec_ext_manifest` (content script)

## Tests
### Unit
1. Typing indicator: appeared → disappeared → debounce 500ms → `responseComplete` full-text
2. Flushing indicator (3 fast-on/out) → single `responseComplete` after the final disappearance
3. Mutation debounce: text added in portions → `responseComplete` through 2 after the last mutation
4. Both at the same time: indicator + mutations → indicator priority, debounce insurance
5. A new injection while waiting → Previous response completed forcibly
6. timemouth 5 mine → forced `responseComplete`
7. The text is extracted from the last answer., not from the whole thread

### Integration check
Live tab. LLM: injector → wait `responseComplete` → The text contains the complete answer of the model, uncircumcised

### Definition of done
- Tests are green at minimum. 2 LLM (one-on typing_indicator, single-handed)
- No case of cropped response during normal operation
- Run. integration check'previous PR
