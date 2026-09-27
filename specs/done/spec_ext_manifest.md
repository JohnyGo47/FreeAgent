# Spec: ext manifest
# Version: 2.0
# Read with ARCHITECTURE.md (§5 rule MV3 - critical)

#Goal
Expansion framework: manifest, permissions, entry points, esbuild assembly. All the expansion stacks are built on it.

#Output
```json
{
  "manifest_version": 3,
  "name": "FreeAgent",
  "permissions": ["tabs", "scripting", "alarms", "storage", "offscreen", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle" }]
}
```Plus collected bundles: background, content, popup, offscreen.

##Constraints
`<all_urls>` is justified: the list of LLM services is open (community registry), we do not list in advance. Explain in README at publication
**MV3 rule (ARCHITECTURE §5) – mandatory for all extension code.** CI check: grep on `setInterval` outside `src/content/`
- Separation of contexts:
Content script is the only one that touches the DOM LLM page.
Service worker - the only one who owns `chrome.tabs` / `chrome.alarms`
Offscreen document – the only one who owns the FSA handle and writes files
Popup – user gesture of the operation (folder selection, pinning tab)
Communication between contexts: `chrome.runtime.sendMessage`
`chrome.offscreen.createDocument({ reasons:['WORKERS'], url:'offscreen.html' })` – Pre-Creation Existence Test
- esbuild: 4 bundles, shared code from `/shared`
Chrome ≥ 121; `FileSystemObserver` used to be behind the flag - for MVP let's say polling

## Dependencies
No, it's frame-spec.

## Tests
################################################################################################################################################################################################################################################################
1. Manifest validated on test boot
2. esbuild collects 4 bundles, `/shared` imported
3. `chrome.alarms.onAlarm` handler works after forced SW stop (chrome://serviceworker-internals → stop)
4. Offscreen is created once, no duplicate call
5. CI-grep: No `setInterval` outside `src/content/`

###Integration check
Load unpacked → popup opens, alarm ticks, content script injected, offscreen alive

###Definition of done
Tests are green, manually downloaded in Chrome
- Run integration checks of previous PR
