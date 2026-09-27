// Monitor agent tabs (spec_agent_recovery, ARCHITECTURE §6): reactive to events
// chrome.tabs, no timers and no polling - only that one “stable” heartbeat
// (extension → CLI, chrome.alarms) which already holds background/index.ts.
export interface TabsApi {
  onRemoved: { addListener(cb: (tabId: number) => void): void };
}

export interface WatchedAgent {
  agent_id: string;
  tab_id: number;
}

export function registerTabObserver(
  tabsApi: TabsApi,
  watchedAgents: () => WatchedAgent[],
  onTabState: (agentId: string, state: 'closed') => void,
): void {
  tabsApi.onRemoved.addListener((tabId) => {
    const agent = watchedAgents().find((a) => a.tab_id === tabId);
    if (!agent) return;
    onTabState(agent.agent_id, 'closed');
  });
}
