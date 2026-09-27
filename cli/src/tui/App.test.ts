// spec_git_checkpoints task B.13: permanent warning in TUI when checkpoints are disabled.
// Full ink render is not tested here (no harness in the repository) - checkpointsWarning
// rendered as a pure function specifically so that this logic can be tested without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointsWarning } from './App.ts';
import { DEFAULT_CONFIG } from '../config/config.ts';

test('checkpointsWarning: git_checkpoints:false -> constant warning text', () => {
  const warning = checkpointsWarning({ ...DEFAULT_CONFIG, git_checkpoints: false });
  assert.ok(warning);
  assert.match(warning, /checkpoints are disabled/);
});

test('checkpointsWarning: git_checkpoints:true (default) -> show nothing', () => {
  assert.equal(checkpointsWarning({ ...DEFAULT_CONFIG, git_checkpoints: true }), null);
});
