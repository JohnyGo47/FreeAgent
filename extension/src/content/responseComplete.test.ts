// spec_response_complete_detection Tests — таймеры и наблюдение через fake clock (DI, как
// ensureOffscreen.test.ts), без jsdom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseWatcher, type ResponseWatcherDeps, type ObserveHandle, type MinimalElement } from './responseComplete.ts';

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending: { id: number; at: number; cb: () => void }[] = [];
  return {
    setTimeout(cb: () => void, ms: number): number {
      const id = nextId++;
      pending.push({ id, at: now + ms, cb });
      return id;
    },
    clearTimeout(id: number): void {
      const idx = pending.findIndex((p) => p.id === id);
      if (idx !== -1) pending.splice(idx, 1);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        now = next.at;
        pending.shift();
        next.cb();
      }
      now = target;
    },
  };
}

const fakeContainer: MinimalElement = { querySelector: () => null, textContent: '' };

function makeDeps(clock: ReturnType<typeof fakeClock>, opts: { typingVisible?: boolean; stopVisible?: boolean | null } = {}) {
  const state = { typingVisible: opts.typingVisible ?? false, stopVisible: opts.stopVisible ?? null };
  let observeCb: (() => void) | null = null;
  const deps: ResponseWatcherDeps = {
    observe(_target, onMutation): ObserveHandle {
      observeCb = onMutation;
      return { disconnect: () => {} };
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    pollTypingIndicator: () => state.typingVisible,
    pollStopButton: () => state.stopVisible,
  };
  return { deps, state, mutate: () => observeCb?.() };
}

test('typing indicator: appears then disappears -> debounce 500ms -> responseComplete', async () => {
  const clock = fakeClock();
  const { deps, state } = makeDeps(clock, { typingVisible: true, stopVisible: null });
  const watcher = new ResponseWatcher(deps, true);
  const promise = watcher.waitForComplete(fakeContainer);

  clock.advance(50); // poll tick sees it visible
  state.typingVisible = false;
  clock.advance(600); // poll notices gone (within 50ms) + 500ms debounce

  const reason = await promise;
  assert.equal(reason, 'typing_indicator');
});

test('flickering indicator (3 quick on/off) -> single responseComplete after final disappearance', async () => {
  const clock = fakeClock();
  const { deps, state } = makeDeps(clock, { typingVisible: true });
  const watcher = new ResponseWatcher(deps, true);
  const promise = watcher.waitForComplete(fakeContainer);

  for (let i = 0; i < 3; i++) {
    clock.advance(50);
    state.typingVisible = false;
    clock.advance(100); // less than 500ms debounce — flicker back before it fires
    state.typingVisible = true;
    clock.advance(50);
  }
  state.typingVisible = false;
  clock.advance(600);

  const reason = await promise;
  assert.equal(reason, 'typing_indicator');
});

test('mutation debounce: text appended in chunks -> responseComplete 2s after last mutation', async () => {
  const clock = fakeClock();
  const { deps, mutate } = makeDeps(clock);
  const watcher = new ResponseWatcher(deps, false);
  const promise = watcher.waitForComplete(fakeContainer);

  mutate();
  clock.advance(500);
  mutate();
  clock.advance(500);
  mutate();
  clock.advance(2000);

  const reason = await promise;
  assert.equal(reason, 'mutation_debounce');
});

test('new inject while waiting forces the previous response complete', async () => {
  const clock = fakeClock();
  const { deps, mutate } = makeDeps(clock);
  const watcher = new ResponseWatcher(deps, false);
  const promise = watcher.waitForComplete(fakeContainer);

  mutate();
  clock.advance(100);
  watcher.forceComplete();

  const reason = await promise;
  assert.equal(reason, 'forced');
});

test('5 minute timeout forces responseComplete', async () => {
  const clock = fakeClock();
  const { deps } = makeDeps(clock);
  const watcher = new ResponseWatcher(deps, false);
  const promise = watcher.waitForComplete(fakeContainer);

  clock.advance(5 * 60 * 1000);

  const reason = await promise;
  assert.equal(reason, 'timeout');
});
