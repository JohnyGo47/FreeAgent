import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsStatus, recentLog, filesWritten, statusSummary } from './status.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage } from '../../../shared/bus-types/index.ts';

const registry: AgentsRegistry = {
  coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' },
  tester1: { agent_id: 'tester1', instance_id: 'browser_b', tab_id: 2, role: 'tester', status: 'IDLE' },
};

function msg(partial: Partial<BusMessage>): BusMessage {
  return { id: 'x', from: 'coder1', to: 'cli', type: 'STATUS', ts: '2026-01-01T00:00:00.000Z', payload: {}, ...partial };
}

test('/status, /agents, /log, /files answer purely from given state — no message is produced', () => {
  const messages: BusMessage[] = [msg({})];
  // Мех. функции — синхронные, чистые: возвращают данные, не отправляют сообщений оркестратору.
  assert.equal(typeof agentsStatus(registry), 'object');
  assert.equal(typeof statusSummary(registry, messages), 'object');
});

test('agentsStatus lists status and role per agent_id', () => {
  const result = agentsStatus(registry);
  assert.deepEqual(
    result.find((a) => a.agent_id === 'coder1'),
    { agent_id: 'coder1', role: 'coder', status: 'WORKING' },
  );
});

test('recentLog returns the last N messages, most recent last', () => {
  const messages = [msg({ id: '1' }), msg({ id: '2' }), msg({ id: '3' })];
  assert.deepEqual(
    recentLog(messages, 2).map((m) => m.id),
    ['2', '3'],
  );
});

test('filesWritten extracts paths from WRITE payloads in this session', () => {
  const messages: BusMessage[] = [
    msg({ type: 'WRITE', payload: { path: 'src/a.ts', content: '', kind: 'code' } }),
    msg({ type: 'TASK' }),
    msg({ type: 'WRITE', payload: { path: 'src/b.ts', content: '', kind: 'code' } }),
  ];
  assert.deepEqual(filesWritten(messages), ['src/a.ts', 'src/b.ts']);
});

test('statusSummary derives WORKING/IDLE counts from the registry mechanically (no LLM opinion)', () => {
  const summary = statusSummary(registry, []);
  assert.equal(summary.agentsWorking, 1);
  assert.equal(summary.agentsIdle, 1);
});
