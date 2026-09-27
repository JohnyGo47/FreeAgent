import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTabObserver, type TabsApi } from './tabObserver.ts';

function fakeTabsApi(): { api: TabsApi; fire(tabId: number): void } {
  let handler: ((tabId: number) => void) | null = null;
  return {
    api: { onRemoved: { addListener: (cb) => { handler = cb; } } },
    fire: (tabId) => handler?.(tabId),
  };
}

test('closing a monitored tab -> TAB_STATE closed for its agent_id', () => {
  const { api, fire } = fakeTabsApi();
  const reports: Array<{ agentId: string; state: string }> = [];
  registerTabObserver(api, () => [{ agent_id: 'coder1', tab_id: 42 }], (agentId, state) => reports.push({ agentId, state }));

  fire(42);
  assert.deepEqual(reports, [{ agentId: 'coder1', state: 'closed' }]);
});

test('closing a tab that does not belong to any agent -> nothing reported', () => {
  const { api, fire } = fakeTabsApi();
  const reports: unknown[] = [];
  registerTabObserver(api, () => [{ agent_id: 'coder1', tab_id: 42 }], (agentId, state) => reports.push({ agentId, state }));

  fire(999);
  assert.deepEqual(reports, []);
});
