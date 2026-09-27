# FreeAgent Stack

## CLI

- Runtime: Node.js 20+
- Language: TypeScript 5
- Terminal UI: Ink and React
- Filesystem: Node.js standard library
- Process execution: `child_process`
- Git integration: the Git CLI, without a libgit2 dependency

The CLI is a normal long-running Node.js process, so it may use regular timers.

## Browser extension

- Platform: Chrome/Chromium Manifest V3
- Language: TypeScript 5
- Bundler: esbuild
- Bundles: background, content, popup, and offscreen
- Directory access: File System Access API
- Handle persistence: IndexedDB
- File observation: polling, with optional `FileSystemObserver` support
- Background scheduling: `chrome.alarms`

Outside the content script, extension code must not depend on `setInterval`; the MV3 service worker may be suspended at any time.

## Shared workspace

- Package manager: npm workspaces
- Test runner: Node.js built-in test runner
- Packages: `shared`, `cli`, and `extension`

```text
cli/        trusted coordinator and filesystem boundary
extension/  browser transport and UI automation
shared/     protocol, adapter, and bus definitions
```

## Supported target

The primary target is current Chrome on Windows, macOS, or Linux with Node.js 20+. Chromium-based browsers may work when they expose the required Manifest V3 and File System Access APIs. Firefox and Safari are not current beta targets.

## Deliberately avoided

- API-key-based agent frameworks: FreeAgent is designed around browser chat sessions.
- Native browser sidebars: content scripts require a normal web document and URL.
- Additional persistence services: project-local files are sufficient for the beta.
- Shell command passthrough: verification uses a small command allowlist.
