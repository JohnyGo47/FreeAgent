import type { BusMessage, CommandPayload, TabStatePayload } from '../../../shared/bus-types/index.ts';
import { ensureOffscreenDocument, sendWhenReady } from './ensureOffscreen.ts';
import { sendToContent } from './tabMessaging.ts';

const HEARTBEAT_ALARM = 'heartbeat';
let creatingOffscreen: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  if (!creatingOffscreen) {
    creatingOffscreen = ensureOffscreenDocument(chrome.offscreen, {
      getURL: (path) => chrome.runtime.getURL(path),
      getContexts: (filter) => chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: filter.documentUrls,
      }),
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  return creatingOffscreen;
}

async function forwardToOffscreen(message: unknown): Promise<void> {
  await ensureOffscreen();
  const result = await sendWhenReady(
    () => chrome.runtime.sendMessage(message) as Promise<{ ok?: boolean; error?: string } | undefined>,
  );
  if (result?.ok === false) throw new Error(result.error ?? 'offscreen operation failed');
}

async function dispatchToTab(request: Record<string, unknown>): Promise<{ state?: TabStatePayload['state']; context_pct?: number; error?: string }> {
  const tabId = Number(request.tabId);
  const message = request.message as BusMessage;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
    if (!tab.id) return { state: 'closed' };
  } catch {
    return { state: 'closed' };
  }
  try {
    const payload = message.payload as CommandPayload;
    if (message.type === 'COMMAND' && payload.command === 'TAB_STATE') {
      return await sendToContent(chrome.tabs, chrome.scripting, tabId, { type: 'CHECK_TAB', registry: request.registry }) as {
        state?: TabStatePayload['state'];
        context_pct?: number;
      };
    }
    await sendToContent(chrome.tabs, chrome.scripting, tabId, {
      type: 'EXECUTE_COMMAND',
      agentId: request.agentId,
      message,
      registry: request.registry,
    });
    return {};
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void ensureOffscreen();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forwardToOffscreen({ type: 'TAB_CLOSED', tabId });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as Record<string, unknown>;
  let action: Promise<unknown> | null = null;
  if (msg.type === 'FOLDER_READY') {
    action = forwardToOffscreen({ type: 'FOLDER_READY_OFFSCREEN', resetCursor: msg.resetCursor === true }).then(() => ({ ok: true }));
  } else if (msg.type === 'REGISTER_TAB') {
    action = forwardToOffscreen({ ...msg, type: 'REGISTER_TAB_OFFSCREEN' }).then(() => ({ ok: true }));
  } else if (msg.type === 'AGENT_OUTPUT') {
    action = forwardToOffscreen({ ...msg, type: 'AGENT_OUTPUT_OFFSCREEN' }).then(() => ({ ok: true }));
  } else if (msg.type === 'DISPATCH_COMMAND') {
    action = dispatchToTab(msg);
  }
  if (!action) return false;
  void action.then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
void ensureOffscreen();
