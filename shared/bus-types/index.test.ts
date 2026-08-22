import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_TYPES,
  AGENT_STATUSES,
  parseBusLine,
  toTagFormat,
  fromTagFormat,
  type BusMessage,
} from './index.ts';

function makeMsg(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    id: 'a1b2c3',
    from: 'coder1',
    to: 'orchestrator',
    type: 'RESULT',
    ts: '2026-08-02T14:04:22Z',
    payload: { task_id: 't1', status: 'DONE', summary: 'done' },
    ...overrides,
  };
}

test('valid message of each of the 17 types parses', () => {
  for (const type of MESSAGE_TYPES) {
    const line = JSON.stringify(makeMsg({ type }));
    const result = parseBusLine(line);
    assert.equal(result.ok, true, `type ${type} should parse`);
  }
  assert.equal(MESSAGE_TYPES.length, 17);
});

test('broken lines fail without throwing', () => {
  const cases = [
    'not json at all',
    JSON.stringify({ from: 'a', to: 'b', type: 'TASK', ts: '2026-08-02T14:04:22Z' }), // no id
    JSON.stringify({ id: 'x', to: 'b', type: 'TASK', ts: '2026-08-02T14:04:22Z' }), // no from
    JSON.stringify({ id: 'x', from: 'a', to: 'b', type: 'NOT_A_TYPE', ts: '2026-08-02T14:04:22Z' }), // unknown type
    JSON.stringify({ id: 'x', from: 'a', to: 'b', type: 'TASK', ts: 'not-a-date' }), // bad ts
  ];
  for (const line of cases) {
    assert.doesNotThrow(() => parseBusLine(line));
    const result = parseBusLine(line);
    assert.equal(result.ok, false, `should reject: ${line}`);
  }
});

test('round-trip fromTagFormat(toTagFormat(msg)) preserves from/to/type/payload', () => {
  const msg = makeMsg({ type: 'TASK', payload: { task_id: 't1', description: 'do it' } });
  const tagged = toTagFormat(msg);
  const [parsed] = fromTagFormat(tagged);
  assert.ok(parsed);
  assert.equal(parsed.from, msg.from);
  assert.equal(parsed.to, msg.to);
  assert.equal(parsed.type, msg.type);
  assert.deepEqual(parsed.payload, msg.payload);
});

test('fromTagFormat survives surrounding garbage, markdown fences, and two blocks', () => {
  const msg1 = makeMsg({ type: 'TASK', from: 'orchestrator', to: 'coder1', payload: { task_id: 't1', description: 'a' } });
  const msg2 = makeMsg({ type: 'STATUS', from: 'coder1', to: 'orchestrator', payload: { state: 'IDLE' } });
  const text = [
    'some chatter before the block',
    '```',
    toTagFormat(msg1),
    '```',
    'some text between blocks',
    toTagFormat(msg2),
    'trailing chatter',
  ].join('\n');

  const parsed = fromTagFormat(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, 'TASK');
  assert.deepEqual(parsed[0].payload, msg1.payload);
  assert.equal(parsed[1].type, 'STATUS');
  assert.deepEqual(parsed[1].payload, msg2.payload);
});

test('unclosed tag is extracted and logged as a warning', () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const text = '[MSG | from: coder1 | to: orchestrator | type: RESULT]{"task_id":"t1","status":"DONE","summary":"ok"}';
    const parsed = fromTagFormat(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].type, 'RESULT');
    assert.equal(warned, true);
  } finally {
    console.warn = originalWarn;
  }
});

test('AgentStatus covers all 10 values as a runtime value', () => {
  assert.equal(AGENT_STATUSES.length, 10);
  assert.ok(AGENT_STATUSES.includes('IDLE'));
  assert.ok(AGENT_STATUSES.includes('WORKING'));
  assert.ok(!AGENT_STATUSES.includes('ACTIVE' as unknown as typeof AGENT_STATUSES[number]));
});
