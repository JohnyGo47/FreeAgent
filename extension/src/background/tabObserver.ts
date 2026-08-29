// Наблюдение за вкладками агентов (spec_agent_recovery, ARCHITECTURE §6): реактивно на события
// chrome.tabs, без таймеров и без опроса — только тот единственный "устойчивый" heartbeat
// (расширение → CLI, chrome.alarms), что уже держит background/index.ts.
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
