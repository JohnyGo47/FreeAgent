// spec_llm_message_format Tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  injectText,
  submit,
  resolveSelector,
  extractMessages,
  hasCompleteProtocolBlock,
  InjectQueue,
  type EditableElement,
  type InputEventFactory,
} from './messageFormat.ts';

class FakeEl implements EditableElement {
  tagName: string;
  isContentEditable: boolean;
  value?: string;
  events: unknown[] = [];
  focused = false;

  constructor(tagName: string, isContentEditable: boolean) {
    this.tagName = tagName;
    this.isContentEditable = isContentEditable;
  }
  dispatchEvent(event: unknown): void {
    this.events.push(event);
  }
  focus(): void {
    this.focused = true;
  }
}

const events: InputEventFactory = {
  makeInsertTextEvent: (text) => ({ type: 'insertText', text }),
  makeInputEvent: () => ({ type: 'input' }),
};

test('inject into contenteditable: InputEvent(insertText) dispatched', () => {
  const el = new FakeEl('DIV', true);
  injectText(el, 'hello', events);
  assert.equal(el.focused, true);
  assert.deepEqual(el.events, [{ type: 'insertText', text: 'hello' }]);
  assert.equal(el.value, undefined);
});

test('inject into textarea: value set + input event dispatched', () => {
  const el = new FakeEl('TEXTAREA', false);
  injectText(el, 'hello', events);
  assert.equal(el.value, 'hello');
  assert.deepEqual(el.events, [{ type: 'input' }]);
});

test('submit clicks the button', () => {
  let clicked = false;
  submit({ click: () => (clicked = true) });
  assert.equal(clicked, true);
});

test('resolveSelector: first found in fallback chain wins', () => {
  const found = resolveSelector(['a', 'b', 'c'], (sel) => (sel === 'b' ? 'found-b' : null));
  assert.equal(found, 'found-b');
});

test('extract single [MSG] block -> one valid BusMessage', () => {
  const text = '[MSG | from: orchestrator | to: coder1 | type: TASK]\n{"task_id":"t1","description":"do it"}\n[/MSG]';
  const { messages, noise } = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'coder1');
  assert.deepEqual(noise, []);
});

test('extract two blocks from one response -> two BusMessage, text between them logged', () => {
  const text =
    'Splitting work:\n' +
    '[MSG | from: orchestrator | to: coder1 | type: TASK]\n{"task_id":"t1","description":"a"}\n[/MSG]\n' +
    'and also:\n' +
    '[MSG | from: orchestrator | to: coder2 | type: TASK]\n{"task_id":"t2","description":"b"}\n[/MSG]';
  const { messages, noise } = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });
  assert.equal(messages.length, 2);
  assert.ok(noise.some((n) => n.includes('Splitting work')));
  assert.ok(noise.some((n) => n.includes('and also')));
});

test('markdown-wrapped block: ``` stripped, block extracted', () => {
  const text = '```\n[MSG | from: coder1 | to: orchestrator | type: RESULT]\n{"task_id":"t1","status":"DONE","summary":"ok"}\n[/MSG]\n```';
  const { messages } = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'RESULT');
});

test('response inside <code> in DOM: extracted from textContent (rawText), not domText', () => {
  const raw = '[MSG | from: coder1 | to: orchestrator | type: RESULT]\n{"task_id":"t1","status":"DONE","summary":"ok"}\n[/MSG]';
  const domRendered = '<code>' + raw + '</code>'; // if we read domText literally, the tag would not be parsed as is
  const { messages } = extractMessages({ domText: domRendered, rawText: raw, isInsideCodeBlock: true });
  assert.equal(messages.length, 1);
});

test('empty fromTagFormat result -> no messages, no [FS] call, text logged as noise', () => {
  const text = 'I think I am done, no tags here.';
  const { messages, fsCallText, noise } = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });
  assert.equal(messages.length, 0);
  assert.equal(fsCallText, null);
  assert.deepEqual(noise, [text]);
});

test('[FS] call text extracted verbatim from response', () => {
  const text = 'ok, reading the file now.\n[FS | op: read | path: src/a.ts]';
  const { fsCallText } = extractMessages({ domText: text, rawText: text, isInsideCodeBlock: false });
  assert.equal(fsCallText, '[FS | op: read | path: src/a.ts]');
});

test('complete protocol blocks can finish despite a stale busy indicator', () => {
  assert.equal(hasCompleteProtocolBlock('[PLAN]\nSTEP 1 | coder1 | work | FILES: a.ts | DEPENDS: none\n[/PLAN]'), true);
  assert.equal(hasCompleteProtocolBlock('[MSG | from: coder1 | to: cli | type: RESULT]\nok\n[/MSG]'), true);
  assert.equal(hasCompleteProtocolBlock('[FS | op: read | path: package.json]'), true);
  assert.equal(hasCompleteProtocolBlock('[PLAN]\nstill streaming'), false);
});

test('FS writes wait for their declared end marker', () => {
  const header = '[FS | op: write | path: a.txt | end: ---FS_END---]';
  assert.equal(hasCompleteProtocolBlock(`${header}\npartial`), false);
  assert.equal(hasCompleteProtocolBlock(`${header}\ncomplete\n---FS_END---`), true);
});

test('queue: second inject waits for first to finish', async () => {
  const queue = new InjectQueue();
  const order: string[] = [];
  let resolveFirst: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    queue.run(async () => {
      order.push('first-start');
      resolve();
      await new Promise<void>((r) => (resolveFirst = r));
      order.push('first-end');
    });
  });
  await firstStarted;

  const second = queue.run(async () => {
    order.push('second-start');
  });

  assert.deepEqual(order, ['first-start']);
  resolveFirst();
  await second;
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});
