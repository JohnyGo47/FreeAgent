# FreeAgent Runbook

This runbook covers local development, browser validation, and release preparation.

## Install and verify

```powershell
npm install
npm test
npm run typecheck
npm run build -w extension
```

The extension build produces `background.js`, `content.js`, `popup.js`, and `offscreen.js` in `extension/`. These generated files are not committed.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the repository's `extension` directory.
4. After every rebuild, click **Reload** for the extension and reload each registered LLM tab.

## Initialize a target project

Run the CLI from the project that agents should access:

```powershell
cd C:\path\to\target-project
node C:\path\to\FreeAgent\cli\src\bin.ts init
node C:\path\to\FreeAgent\cli\src\bin.ts start
```

Initialization creates `freeagent/` and ensures `/freeagent/` is present in the target project's `.gitignore`.

In the extension popup, select the target project root. Do not select its generated `freeagent` directory. If the browser retained the directory handle but revoked permission, click **Restore access**.

## Register agents

1. Open a separate LLM conversation for each agent.
2. In the popup, choose the role and click **Add tab**.
3. Wait for the INIT prompt and the agent's `[READY]` response.
4. Register the orchestrator and the workers referenced by the intended plan.

If the extension or a tab is reloaded, restore folder access first and then reload every registered agent tab. Re-register only tabs that the CLI reports as unavailable.

## Run a task

Submit a task through the CLI or send it to the orchestrator. In plan mode:

1. the orchestrator returns a `[PLAN]` block;
2. the CLI validates and displays it;
3. the user approves or rejects it;
4. the CLI dispatches ready steps;
5. agents use FS calls for project data;
6. the CLI runs requested verification commands; and
7. the orchestrator receives `PLAN_COMPLETE` after every step succeeds.

Useful interactive commands include `/status`, `/agents`, `/log`, `/files`, `/mode plan`, `/mode yolo`, `/stop`, `/suspend`, and `/undo <task_id>`.

## Failure diagnosis

### INIT does not appear

- Confirm that the CLI process is running.
- Confirm that the extension and CLI use the same project root and `project_id`.
- Confirm that folder access is granted.
- Reload the extension, then reload the LLM tab.
- Check the CLI registry for `INIT_FAILED`, `SERVICE_DOWN`, or `SELECTOR_BROKEN`.

### A prompt is filled but not submitted

- Check whether the LLM page is already busy.
- Reload the page if its submit button is stuck.
- Confirm that the adapter's input and submit selectors still match the current DOM.
- Preserve the complete extension error and stack trace before reloading.

### The extension reports no receiver

The background worker attempts to inject `content.js` and retry. If it still fails, reload the target tab and then restore its registration.

### Folder permission was lost

Open the popup and click **Restore access**. Browsers may require a new user gesture after an extension reload or browser restart.

### An agent returns malformed output

The CLI requests the expected protocol format a limited number of times. If retries are exhausted, the step is escalated to the orchestrator. Do not manually mark it complete.

### Tests fail

Inspect the log recorded under `freeagent/logs/`. A failed exit code prevents the step from closing successfully and blocks dependent steps.

### Undo conflicts

`/undo` uses `git revert`. FreeAgent stops on a conflict and reports it; resolve or abort the revert manually after reviewing the repository state.

## Release checklist

1. Confirm that `git status` contains no runtime files, generated bundles, dependencies, or secrets.
2. Search tracked content for unintended non-English UI or prompt text.
3. Run `npm test`.
4. Run `npm run typecheck`.
5. Run `npm run build -w extension`.
6. Run `git diff --check`.
7. Load the new build in Chrome and complete the read-only live workflow in `TESTING.md`.
8. For changes that affect writes, use a disposable Git repository and verify checkpoint plus undo behavior.

## Operational cautions

- Keep Git checkpoints enabled for normal use.
- Review plans before approval, especially declared files and test commands.
- Use a clean or disposable repository for early beta testing.
- Treat browser selector changes as expected compatibility work, not as proof that local project data is corrupt.
