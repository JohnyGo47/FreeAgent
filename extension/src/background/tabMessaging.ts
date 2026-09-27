export interface TabsMessenger {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface ScriptInjector {
  executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
}

export async function sendToContent(
  tabs: TabsMessenger,
  scripting: ScriptInjector,
  tabId: number,
  message: unknown,
): Promise<unknown> {
  try {
    return await tabs.sendMessage(tabId, message);
  } catch {
    await scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return tabs.sendMessage(tabId, message);
  }
}
