import defaultRegistryJson from '../../../shared/llm-adapter-registry.default.json';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';
import { parseBusLine, type BusMessage, type RegisterPayload, type TabStatePayload } from '../../../shared/bus-types/index.ts';
import { FsaSource } from '../bus/fsaSource.ts';
import { InstanceBusWriter, type OutgoingMessage } from '../bus/instanceBusWriter.ts';
import { resolvePath } from '../fs/folderAccessService.ts';
import { folderAccessService } from '../fs/service.ts';

interface PendingRegistration {
  role: string;
  tabId: number;
  url: string;
}

interface DispatchResult {
  state?: TabStatePayload['state'];
  context_pct?: number;
  error?: string;
}

const defaultRegistry = defaultRegistryJson as AdapterRegistry;
let startPromise: Promise<void> | null = null;
let writer: InstanceBusWriter | null = null;
let instanceId = '';
let watcherGeneration = 0;

function storageGet<T>(key: string, fallback: T): T {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

function storageSet(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

async function getInstanceId(): Promise<string> {
  const existing = storageGet<string | null>('instanceId', null);
  if (existing) return existing;
  const created = crypto.randomUUID();
  storageSet('instanceId', created);
  return created;
}

async function loadRegistry(root: FileSystemDirectoryHandle): Promise<AdapterRegistry> {
  try {
    const handle = await resolvePath(root, 'llm_adapter_registry.json');
    const text = await (await handle.getFile()).text();
    return text.trim() ? JSON.parse(text) as AdapterRegistry : defaultRegistry;
  } catch {
    return defaultRegistry;
  }
}

function roleFromAgentId(agentId: string): string {
  return agentId.replace(/\d+$/, '');
}

async function bindPendingTab(agentId: string): Promise<number | null> {
  const agentTabs = storageGet<Record<string, number>>('agentTabs', {});
  const pending = storageGet<PendingRegistration[]>('pendingRegistrations', []);
  const role = roleFromAgentId(agentId);
  const index = pending.findIndex((entry) => entry.role === role);
  if (index === -1) return agentTabs[agentId] ?? null;

  const [registration] = pending.splice(index, 1);
  agentTabs[agentId] = registration.tabId;
  storageSet('agentTabs', agentTabs);
  storageSet('pendingRegistrations', pending);
  return registration.tabId;
}

async function tabClosed(tabId: number): Promise<void> {
  await start();
  const agentTabs = storageGet<Record<string, number>>('agentTabs', {});
  for (const [agentId, mappedTabId] of Object.entries(agentTabs)) {
    if (mappedTabId !== tabId) continue;
    delete agentTabs[agentId];
    await emitTabState(agentId, 'closed');
  }
  storageSet('agentTabs', agentTabs);
  const pending = storageGet<PendingRegistration[]>('pendingRegistrations', []);
  storageSet('pendingRegistrations', pending.filter((entry) => entry.tabId !== tabId));
}

async function emitTabState(agentId: string, state: TabStatePayload['state'], contextPct?: number): Promise<void> {
  if (!writer) return;
  const payload: TabStatePayload = { agent_id: agentId, state };
  if (contextPct !== undefined) payload.context_pct = contextPct;
  await writer.send({ from: instanceId, to: 'cli', type: 'TAB_STATE', ts: new Date().toISOString(), payload });
}

async function dispatchCommand(message: BusMessage, registry: AdapterRegistry): Promise<void> {
  const tabId = await bindPendingTab(message.to);
  if (tabId === null) {
    await emitTabState(message.to, 'closed');
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'DISPATCH_COMMAND',
      tabId,
      agentId: message.to,
      message,
      registry,
    }) as DispatchResult | undefined;
    if (result?.state) await emitTabState(message.to, result.state, result.context_pct);
    if (result?.error && writer) {
      await writer.send({
        from: message.to,
        to: 'cli',
        type: 'ERROR',
        ts: new Date().toISOString(),
        payload: { message: 'tab dispatch failed', context: result.error },
      });
    }
  } catch {
    if (writer) {
      await writer.send({
        from: message.to,
        to: 'cli',
        type: 'ERROR',
        ts: new Date().toISOString(),
        payload: { message: 'background dispatch failed', context: 'runtime messaging error' },
      });
    }
  }
}

async function launchCommandWatcher(root: FileSystemDirectoryHandle, generation: number, resetCursor: boolean): Promise<void> {
  const handle = await resolvePath(root, `commands/${instanceId}.jsonl`, { create: true });
  // v2 discards legacy cursors that mixed UTF-8 byte sizes with string indices.
  const cursorKey = `commandCursorChars:v2:${instanceId}`;
  const storedCursor = resetCursor ? null : storageGet<number | null>(cursorKey, null);
  let cursor = storedCursor ?? (await (await handle.getFile()).text()).length;
  if (storedCursor === null || resetCursor) storageSet(cursorKey, cursor);

  const registry = await loadRegistry(root);
  void (async () => {
    for await (const batch of new FsaSource(handle).watch()) {
      if (generation !== watcherGeneration) break;
      for (const line of batch.linesAfter(cursor)) {
        const parsed = parseBusLine(line.text);
        cursor = line.position;
        if (parsed.ok) await dispatchCommand(parsed.msg, registry);
        storageSet(cursorKey, cursor);
      }
    }
  })().catch(() => {
    if (generation !== watcherGeneration) return;
    startPromise = null;
    writer = null;
  });
}

async function start(resetCursor = false): Promise<void> {
  if (startPromise) return startPromise;
  const generation = ++watcherGeneration;
  startPromise = (async () => {
    const state = await folderAccessService.restore();
    if (state !== 'granted') throw new Error('folder access is not granted');
    const root = folderAccessService.root();
    await folderAccessService.ensureStructure();
    instanceId = await getInstanceId();
    const incoming = await resolvePath(root, `incoming/${instanceId}.jsonl`, { create: true });
    writer = new InstanceBusWriter(incoming);
    await launchCommandWatcher(root, generation, resetCursor);
  })().catch((error) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

async function restart(resetCursor: boolean): Promise<void> {
  watcherGeneration += 1;
  startPromise = null;
  writer = null;
  await start(resetCursor);
}

async function registerTab(registration: PendingRegistration): Promise<void> {
  await start();
  const pending = storageGet<PendingRegistration[]>('pendingRegistrations', [])
    .filter((entry) => registration.role !== 'orchestrator' || entry.role !== 'orchestrator');
  if (!pending.some((entry) => entry.tabId === registration.tabId && entry.role === registration.role)) {
    pending.push(registration);
    storageSet('pendingRegistrations', pending);
  }
  const payload: RegisterPayload = {
    role: registration.role,
    llm_url: registration.url,
    tab_id: registration.tabId,
  };
  if (!writer) throw new Error('bus writer did not start');
  await writer.send({ from: instanceId, to: 'cli', type: 'REGISTER_REQUEST', ts: new Date().toISOString(), payload });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as Record<string, unknown>;
  let action: Promise<unknown> | null = null;
  if (msg.type === 'FOLDER_READY_OFFSCREEN') {
    action = restart(msg.resetCursor === true);
  } else if (msg.type === 'REGISTER_TAB_OFFSCREEN') {
    action = registerTab({ role: String(msg.role), tabId: Number(msg.tabId), url: String(msg.url) });
  } else if (msg.type === 'AGENT_OUTPUT_OFFSCREEN' && Array.isArray(msg.messages)) {
    action = start().then(async () => {
      for (const outgoing of msg.messages as OutgoingMessage[]) await writer!.send(outgoing);
    });
  } else if (msg.type === 'TAB_CLOSED' && typeof msg.tabId === 'number') {
    action = tabClosed(msg.tabId);
  }
  if (!action) return false;
  void action.then(() => sendResponse({ ok: true }), (error: unknown) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

void start().catch(() => {});
