# Spec: llm_message_format
# Version: 1.0
# Reading with ARCHITECTURE.md (§3 route, §4 format)

## Goal
Tag-block injection in DOM tab LLM and extracting tag blocks from the response. Bridge between JSON-tire (world CLI) text-chat (world LLM).

## Input
- **Injection:** `BusMessage` from `commands/`, tag-text-converted `toTagFormat`
- **Extraction:** text DOM `response_container`, scatter `fromTagFormat`

## Output
- **Injection:** text inserted `selectors.input`, button `selectors.submit` pressed
- **Extraction:** stratum `BusMessage`, recorded `incoming/<instance_id>.jsonl`

## Contract

### Injection
```
1. Get an adapter by tab domain
2. Resolve the selector input (chain-wise fallback from spec_selector_resilience)
3. Insert text:
     contenteditable → insertion InputEvent('insertText')
     textarea → installation .value + dispatch('input')
4. Resolve the selector submit
5. Click. submit
6. Wait for confirmation of shipment:
     typing_indicator appeared → sent
     typing_indicator === null → wait 500ms (best effort)
```

**Why not? `element.textContent =`:** many frameworks (React, Vue) They don't hear a direct recording of DOM. `InputEvent` and dispatch guarantee, framework will pick up.

### Extraction
```
1. Wait for the answer to be completed (spec_response_complete_detection)
2. Read innerText last response response_container
3. Pass through fromTagFormat → stratum BusMessage
4. For everyone.:
     parseBusLine-validation → ok → write down incoming
     faulty → handleSuspiciousResponse (spec_response_health)
5. If fromTagFormat empty-handed → classification no_tags
```

### Processing markdown-wrapper
LLM often wraps the answer in markdown: ` ```\n[MSG|...]\n``` `. converter `fromTagFormat` I already know how to do it. (`spec_message_bus_types`), but content script additionally:
- tagging rendered HTML (DOM), so raw text (some interfaces render markdown, some of them)
- if DOM contain `<code>` The tagged block inside - extracts from `textContent` component, not innerHTML

### Multiple blocks in one answer
Orchestras can give you a few `[MSG]` block-in-the-box (task). Each is extracted separately.. Text between blocks (orchestrator) Ignored - it's noise for parser, But it can be useful to the user. → logged.

## Constraints
- Injection and extraction — **only content script** (the only context with access to DOM page)
- Content script → offscreen — through `chrome.runtime.sendMessage`
- Between the injection and the extraction content script **not blocked** — He keeps monitoring other tabs.. Completion of response - event, not waiting
- Don't inject, until the previous answer is completed (tab-line)
- `toTagFormat` and `fromTagFormat` imported `/shared/bus-types` — content script does not duplicate the conversion

### Wiring [FS]/[FS_RESULT] tyre-wire (microscopic-PR beforehand PR-5)
Body. `[FS|...]`-browser **parsite**: content script squash heredoc-block `payload` `BusMessage` type `FS_CALL` how, line. It's just a matter of taking it apart. `parseFsCall` escaping CLI (`spec_file_access`) — here, as in the whole tyre., one-way rule: tag-layer payload cock-carrier, not read. `FS_RESULT` returns **summoner** through `commands/<instance_id>` and injected DOM same-machine, that any team agent (§ Injection higher) — not broadcast or directly from CLI.

## Dependencies
`spec_message_bus_types` (converter), `spec_llm_adapter_registry` (selectors), `spec_selector_resilience` (fallback-chain — **PR-6**; escaping PR-4 brute-force, centimeter. note), `spec_response_complete_detection` (when the answer is ready), `spec_ext_manifest` (content script context)

> **Resolve selector without `selector_resilience` (PR-6).** V. PR-4 resolvit `input`/`submit` **brute-force** selector `llm_adapter_registry` — first found wins. `selector_resilience` (PR-6) later wraps up this resolution self-healing'om and community-registry, interfaceless `resolveSelector(chain)`. V. PR-4 `selector_resilience` not import - lay the seam.

## Tests
### Unit
1. Injection in contenteditable: text, InputEvent dispatched
2. Injection in textarea: value fixed, input event dispatched
3. Submit: button, typing_indicator appeared
4. Extracting one `[MSG]` block → one-valid `BusMessage`
5. Extracting two blocks from one answer → two-way `BusMessage`, text between them is secured
6. Markdown-wrapper ``` → block removed, wrapper
7. The answer is inside. `<code>` escaping DOM → extracted textContent
8. Empty. `fromTagFormat` → classification `no_tags` caused
9. queue: The second injection is waiting for the first response to be completed.

### Integration check
Open the tab LLM → test-inject `[MSG]` → wait → extract → check out round-trip JSON ⇄ tagging ⇄ DOM ⇄ tagging ⇄ JSON

### Definition of done
- Tests are green at minimum. 2 different LLM (contenteditable + textarea)
- Round-trip Does not lose or distort the message fields
- Run. integration check'previous PR
