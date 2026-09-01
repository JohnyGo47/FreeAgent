// spec_git_checkpoints задача B.13: постоянный warning в TUI, когда чекпоинты отключены.
// Полный ink-рендер здесь не тестируется (нет harness в репозитории) — checkpointsWarning
// вынесена как чистая функция специально, чтобы эту логику можно было проверить без него.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointsWarning } from './App.ts';
import { DEFAULT_CONFIG } from '../config/config.ts';

test('checkpointsWarning: git_checkpoints:false -> постоянный warning-текст', () => {
  const warning = checkpointsWarning({ ...DEFAULT_CONFIG, git_checkpoints: false });
  assert.ok(warning);
  assert.match(warning, /чекпоинты отключены/);
});

test('checkpointsWarning: git_checkpoints:true (по умолчанию) -> ничего не показывать', () => {
  assert.equal(checkpointsWarning({ ...DEFAULT_CONFIG, git_checkpoints: true }), null);
});
