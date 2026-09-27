# Testing FreeAgent

FreeAgent has automated coverage for the CLI, shared protocol, and browser extension, plus a manual end-to-end workflow for validating real browser interaction.

## Automated checks

From the repository root, run:

```powershell
npm install
npm test
npm run typecheck
npm run build -w extension
```

The test suite covers message-bus locking and rotation, routing, agent initialization and recovery, plan execution, file access and privacy rules, Git checkpoints, test verification, extension folder access, offscreen compatibility, content-script injection, and response detection.

On Windows, the symlink path-escape test may be skipped when the current account cannot create symbolic links. All other tests must pass.

## Live browser test

Use a disposable project or a clean Git working tree for any test that permits writes.

1. Build the extension with `npm run build -w extension`.
2. Open `chrome://extensions`, enable Developer mode, and load the unpacked `extension` directory. If it is already loaded, click **Reload**.
3. Start the CLI from the target project:

   ```powershell
   node C:\path\to\FreeAgent\cli\src\bin.ts init
   node C:\path\to\FreeAgent\cli\src\bin.ts start
   ```

4. Open the extension and select the target project's root directory. Do not select its generated `freeagent` directory.
5. Open a separate ChatGPT conversation for the orchestrator and each worker.
6. In every conversation, select the correct role and click **Add tab**. Wait for the INIT message and `[READY]` before continuing.
7. Send a read-only task to the orchestrator that requires multiple roles, approve the plan in the CLI, and confirm that:
   - independent steps are dispatched to the intended agents;
   - each `[FS]` request receives an `[FS_RESULT]`;
   - dependent steps start only after their dependencies finish;
   - `TESTS_READY` causes the CLI to run the allowlisted command;
   - the reviewer returns a verdict; and
   - the orchestrator receives `PLAN_COMPLETE`.

The project has been exercised with an orchestrator, researcher, two coders, tester, and reviewer in separate ChatGPT tabs.

## Write and undo test

Run this only in a disposable Git repository:

1. Ask the orchestrator to create a uniquely named text file and declare that file in the plan step.
2. Confirm that the assigned agent uses the FS protocol rather than claiming a write without an FS call.
3. Verify the file contents on disk and check that the task completed successfully.
4. Run `/undo <task_id>` in the CLI.
5. Confirm that the task checkpoint was restored and the disposable file was removed.

Also verify that writes outside the project root, writes to `.git`, and writes to undeclared files during plan execution are rejected.

## Troubleshooting browser tests

- After rebuilding or reloading the extension, reload every registered agent tab before restoring access.
- If Chrome revokes the directory handle, click **Restore access** in the extension popup.
- If INIT does not appear, confirm that the CLI is running in the same project root selected by the extension.
- If a tab was accidentally registered twice, stop the duplicate agent and register the intended tab again.
- If Chrome reports an extension error, copy the complete error message and stack trace before reloading; the highlighted source line alone may only show where an exception surfaced.
