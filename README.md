# FreeAgent

FreeAgent connects browser-based LLM chats to a local coding workflow. A Chrome extension injects tasks into agent tabs and reads their protocol responses, while a Node.js CLI routes messages, controls file access, runs tests, creates Git checkpoints, and executes approved plans.

The project is currently a beta. The ChatGPT workflow has been validated end to end with an orchestrator, researcher, two coders, tester, and reviewer.

## What works

- Register browser tabs as `orchestrator`, `coder`, `researcher`, `reviewer`, or `tester` agents.
- Generate and approve dependency-aware plans.
- Read, list, search, write, and edit project files through a controlled FS protocol.
- Restrict writes to the project root and, during plan execution, to files owned by the active step.
- Exclude or redact common secret files before content reaches an LLM.
- Run allowlisted test commands in the CLI and verify their real exit codes.
- Create Git checkpoints around agent writes and restore completed work with `/undo`.
- Recover tab registrations and folder access after restarts.

## Requirements

- Node.js 20 or newer
- npm
- Git for checkpoints and undo
- Chrome or another Chromium browser with Manifest V3, offscreen documents, and the File System Access API
- Signed-in LLM web chats; ChatGPT is the currently validated live adapter

## Development setup

```powershell
git clone https://github.com/JohnyGo47/FreeAgent.git
cd FreeAgent
npm install
npm run build -w extension
npm test
npm run typecheck
```

Load the unpacked extension from the `extension` directory in `chrome://extensions`.

## Initialize a project

Run the CLI from the project you want agents to modify:

```powershell
cd C:\path\to\your-project
node C:\path\to\FreeAgent\cli\src\bin.ts init
node C:\path\to\FreeAgent\cli\src\bin.ts start
```

Then:

1. Open the FreeAgent extension and select the project root. Do not select the generated `freeagent` subdirectory.
2. Open one LLM chat per agent.
3. In each chat, choose a role in the extension and click **Add tab**.
4. Wait for the injected INIT prompt and the agent's `[READY]` response.
5. Submit work to the orchestrator and approve the proposed plan in the CLI.

The extension may ask you to restore folder access after an extension reload or browser restart. Reload every registered agent tab after updating the extension code.

## CLI commands

```text
freeagent init
freeagent start
freeagent do <task>
freeagent agents
freeagent log [count]
```

The interactive CLI also supports plan approval, `/stop`, `/suspend`, mode switching, and `/undo <task_id>`.

## Safety model

- The CLI is the only component that writes project files.
- Absolute paths, traversal outside the project, `.git`, FreeAgent runtime state, and configured secret patterns are blocked.
- In plan mode, an agent may write only files declared by its active step.
- Test commands must match a small allowlist and reject shell metacharacters.
- Git checkpoints are enabled by default; disabling them also disables reliable undo.

## Project layout

```text
cli/        Node.js CLI, routing, plans, verification, checkpoints, and TUI
extension/  Manifest V3 browser extension
shared/     Message types, adapter schema, and shared templates
specs/      Implemented behavior specifications
tools/      Manual development helpers
```

Each initialized target project receives a `freeagent/` runtime directory containing the message bus, agent registry, command queues, skills, logs, memory, and checkpoints. This directory is local state and should not be committed.

## Verification

```powershell
npm test
npm run typecheck
npm run build -w extension
```

See [TESTING.md](TESTING.md) for the live browser checklist and [ARCHITECTURE.md](ARCHITECTURE.md) for the protocol and component boundaries.

## Beta limitations

- Browser UIs and DOM selectors can change without notice.
- Browser tabs and the CLI process must remain open during active work.
- Extension updates require reloading registered tabs.
- Folder permission may need to be restored manually.
- Non-ChatGPT adapters have automated coverage but have not all received the same live end-to-end validation.
