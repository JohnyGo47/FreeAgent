import { detectAdapter, type AdapterRegistry, type LLMAdapter } from '../../../shared/adapter-types/index.ts';
import type { BusMessage, HealthPayload, TabStatePayload } from '../../../shared/bus-types/index.ts';
import type { OutgoingMessage } from '../bus/instanceBusWriter.ts';
import { hasCompleteProtocolBlock, InjectQueue, resolveSelector } from './messageFormat.ts';
import { commandText, parseAgentResponse } from '../runtime/protocol.ts';
import { responseAfterPrompt } from './responseAfterPrompt.ts';

const queue = new InjectQueue();
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const RESPONSE_STABLE_MS = 2000;
const COMPOSER_IDLE_STABLE_MS = 1000;

function matchingAdapter(registry: AdapterRegistry): LLMAdapter | null {
  const hostname = location.hostname;
  const known = Object.keys(registry.adapters).some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  return known ? detectAdapter(hostname, registry) : null;
}

function firstElement<T extends Element>(selectors: string[]): T | null {
  return resolveSelector(selectors, (selector) => document.querySelector<T>(selector));
}

function visible(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function replaceInput(element: HTMLElement, text: string): void {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, text);
  } else if (location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    if (element.textContent?.trim() !== text.trim()) {
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, text);
    }
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand('insertText', false, text)) element.textContent = text;
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function findEnabledSubmit(selectors: string[]): Promise<HTMLElement | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const button = document.querySelector<HTMLElement>(selector);
      if (button && visible(button) && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true') {
        return button;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function inputText(element: HTMLElement): string {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value.trim();
  return (element.innerText || element.textContent || '').trim();
}

async function inputWasCleared(element: HTMLElement): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 750));
  return inputText(element).length === 0;
}

async function submitPrompt(input: HTMLElement, selectors: string[]): Promise<boolean> {
  const configured = await findEnabledSubmit(selectors);
  const form = input.closest('form');
  const formSubmit = form?.querySelector<HTMLElement>('button[type="submit"]:not([disabled])') ?? null;
  const button = configured ?? formSubmit;
  if (button) {
    const rect = button.getBoundingClientRect();
    const pointer = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    button.dispatchEvent(new PointerEvent('pointerdown', pointer));
    button.dispatchEvent(new MouseEvent('mousedown', pointer));
    button.dispatchEvent(new PointerEvent('pointerup', pointer));
    button.dispatchEvent(new MouseEvent('mouseup', pointer));
    button.click();
    if (await inputWasCleared(input)) return true;
  }

  if (form) {
    form.requestSubmit();
    if (await inputWasCleared(input)) return true;
  }

  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
  }
  return inputWasCleared(input);
}

function composerDiagnostic(input: HTMLElement): string {
  const scope = input.closest('form') ?? document;
  const buttons = Array.from(scope.querySelectorAll('button')).slice(-12).map((button) => ({
    id: button.id,
    testid: button.getAttribute('data-testid'),
    aria: button.getAttribute('aria-label'),
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    visible: visible(button),
  }));
  return JSON.stringify({ inputTag: input.tagName, inputId: input.id, inputClass: input.className, buttons }).slice(0, 2000);
}

function responseElements(adapter: LLMAdapter): Element[] {
  for (const selector of adapter.selectors.response_container) {
    const elements = Array.from(document.querySelectorAll(selector));
    if (elements.length > 0) return elements;
  }
  return [];
}

interface ResponseSnapshot {
  count: number;
  text: string;
  protocolText: string;
  turnCount: number;
  articleCount: number;
  readyCount: number;
  initCount: number;
  planCount: number;
  messageCount: number;
  fsCount: number;
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

const ALLOWED_MESSAGE_RE = /\[MSG\s*\|[^\]]*type:\s*(?:RESULT|STATUS|TESTS_READY)\b[^\]]*\]/g;

function allowedMessageStarts(text: string): number[] {
  return Array.from(text.matchAll(ALLOWED_MESSAGE_RE), (match) => match.index);
}

function responseSnapshot(adapter: LLMAdapter): ResponseSnapshot {
  const elements = responseElements(adapter);
  const protocolText = document.body.innerText;
  return {
    count: elements.length,
    text: elements.at(-1)?.textContent?.trim() ?? '',
    protocolText,
    turnCount: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
    articleCount: document.querySelectorAll('main article').length,
    readyCount: occurrences(protocolText, '[READY]'),
    initCount: occurrences(protocolText, '[/INIT]'),
    planCount: occurrences(protocolText, '[PLAN]'),
    messageCount: allowedMessageStarts(protocolText).length,
    fsCount: occurrences(protocolText, '[FS |'),
  };
}

function generationActive(adapter: LLMAdapter): boolean {
  const selectors = [...(adapter.selectors.typing_indicator ?? []), ...(adapter.selectors.stop_button ?? [])];
  return selectors.some((selector) => {
    const element = document.querySelector(selector);
    return visible(element)
      && !element?.hasAttribute('disabled')
      && element?.getAttribute('aria-disabled') !== 'true';
  });
}

async function waitForComposerIdle(adapter: LLMAdapter): Promise<void> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let idleSince: number | null = null;
  while (Date.now() < deadline) {
    if (generationActive(adapter)) idleSince = null;
    else idleSince ??= Date.now();
    if (idleSince !== null && Date.now() - idleSince >= COMPOSER_IDLE_STABLE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('LLM remained busy for ten minutes');
}

function responseAfterBaseline(adapter: LLMAdapter, baseline: ResponseSnapshot, expectsReady: boolean, prompt: string): string {
  const current = responseSnapshot(adapter);
  const anchored = responseAfterPrompt(current.protocolText, baseline.protocolText, prompt);
  if (anchored !== null) return anchored;
  if (current.count > baseline.count && current.text) return current.text;

  const protocolText = current.protocolText;
  const readyIncrease = current.initCount > baseline.initCount ? 2 : 1;
  if (expectsReady && current.readyCount >= baseline.readyCount + readyIncrease) return '[READY]';
  if (!expectsReady && current.planCount > baseline.planCount) {
    const start = protocolText.lastIndexOf('[PLAN]');
    const end = protocolText.indexOf('[/PLAN]', start);
    if (start >= 0 && end >= start) return protocolText.slice(start, end + '[/PLAN]'.length);
  }
  if (!expectsReady && current.messageCount > baseline.messageCount) {
    const start = allowedMessageStarts(protocolText).at(-1) ?? -1;
    const end = protocolText.indexOf('[/MSG]', start);
    if (start >= 0 && end >= start) return protocolText.slice(start, end + '[/MSG]'.length);
  }
  if (!expectsReady && current.fsCount > baseline.fsCount) {
    const start = protocolText.lastIndexOf('[FS |');
    if (start >= 0) return protocolText.slice(start);
  }

  const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
  if (turns.length >= baseline.turnCount + 2) return turns.at(-1)?.textContent?.trim() ?? '';

  const articles = Array.from(document.querySelectorAll('main article'));
  if (articles.length >= baseline.articleCount + 2) return articles.at(-1)?.textContent?.trim() ?? '';
  return '';
}

async function waitForResponse(adapter: LLMAdapter, baseline: ResponseSnapshot, expectsReady: boolean, prompt: string): Promise<string> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let latest = '';
  let lastChange = Date.now();
  let started = false;

  while (Date.now() < deadline) {
    const currentText = responseAfterBaseline(adapter, baseline, expectsReady, prompt);
    if (currentText) started = true;
    if (started && currentText !== latest) {
      latest = currentText;
      lastChange = Date.now();
    }
    const completeProtocol = hasCompleteProtocolBlock(latest);
    if (started && latest && (completeProtocol || !generationActive(adapter)) && Date.now() - lastChange >= RESPONSE_STABLE_MS) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const current = responseSnapshot(adapter);
  throw new Error(`LLM response timeout: ${JSON.stringify({
    responseCounts: [baseline.count, current.count],
    fsCounts: [baseline.fsCount, current.fsCount],
    turnCounts: [baseline.turnCount, current.turnCount],
    promptFound: responseAfterPrompt(current.protocolText, baseline.protocolText, prompt) !== null,
    generationActive: generationActive(adapter),
    responseTail: current.text.slice(-500),
  })}`);
}

function healthMessage(agentId: string, adapter: LLMAdapter, text: string): OutgoingMessage {
  const lower = text.toLowerCase();
  const has = (patterns: string[]): boolean => patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  let klass: HealthPayload['klass'] = 'no_tags';
  if (has(adapter.failure_patterns.unavailable)) klass = 'unavailable';
  else if (has(adapter.failure_patterns.rate_limited)) klass = 'rate_limited';
  else if (has(adapter.failure_patterns.context_full)) klass = 'context_full';
  const payload: HealthPayload = { agent_id: agentId, klass, raw_excerpt: text.slice(0, 500) };
  return { from: agentId, to: 'cli', type: 'RESPONSE_HEALTH', ts: new Date().toISOString(), payload };
}

async function sendOutput(messages: OutgoingMessage[]): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'AGENT_OUTPUT', messages });
}

async function sendTabState(agentId: string, state: TabStatePayload['state']): Promise<void> {
  const payload: TabStatePayload = { agent_id: agentId, state };
  await sendOutput([{ from: agentId, to: 'cli', type: 'TAB_STATE', ts: new Date().toISOString(), payload }]);
}

async function execute(agentId: string, message: BusMessage, registry: AdapterRegistry): Promise<void> {
  const adapter = matchingAdapter(registry);
  if (!adapter) {
    await sendTabState(agentId, 'wrong_domain');
    return;
  }
  const text = commandText(message);
  if (text === null) return;
  const command = message.type === 'COMMAND' ? (message.payload as { command?: string }).command : undefined;
  const expectsReady = command === 'INIT' || command === 'RECOVER_AGENT';
  await waitForComposerIdle(adapter);
  const input = firstElement<HTMLElement>(adapter.selectors.input);
  if (!input) {
    await sendTabState(agentId, 'selectors_broken');
    return;
  }

  const baseline = responseSnapshot(adapter);
  replaceInput(input, text);
  if (!await submitPrompt(input, adapter.selectors.submit)) {
    await sendOutput([{
      from: agentId,
      to: 'cli',
      type: 'ERROR',
      ts: new Date().toISOString(),
      payload: { message: 'composer did not submit', context: composerDiagnostic(input) },
    }]);
    await sendTabState(agentId, 'selectors_broken');
    return;
  }

  const responseText = await waitForResponse(adapter, baseline, expectsReady, text);
  const parsed = parseAgentResponse(agentId, responseText);
  await sendOutput(parsed.length > 0 ? parsed : [healthMessage(agentId, adapter, responseText)]);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as Record<string, unknown>;
  if (msg.type === 'CHECK_TAB') {
    const registry = msg.registry as AdapterRegistry;
    const adapter = matchingAdapter(registry);
    const state: TabStatePayload['state'] = !adapter
      ? 'wrong_domain'
      : firstElement(adapter.selectors.input) ? 'alive' : 'selectors_broken';
    sendResponse({ state });
    return false;
  }
  if (msg.type === 'EXECUTE_COMMAND') {
    const agentId = String(msg.agentId);
    void queue.run(() => execute(agentId, msg.message as BusMessage, msg.registry as AdapterRegistry)).catch(async (error: unknown) => {
      await sendOutput([{
        from: agentId,
        to: 'cli',
        type: 'ERROR',
        ts: new Date().toISOString(),
        payload: { message: error instanceof Error ? error.message : String(error), context: 'content-script' },
      }]);
    });
    sendResponse({ accepted: true });
    return false;
  }
  return false;
});
