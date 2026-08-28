import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAgentId, buildInitPrompt, registerAgent, checkInitTimeouts } from './initAgent.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { RegisterPayload } from '../../../shared/bus-types/index.ts';

function registerPayload(role: string): RegisterPayload {
  return { role, llm_url: 'https://example.com', tab_id: 1 };
}

test('agent_id is unique: second coder gets coder2', () => {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  assert.equal(nextAgentId(registry, 'coder'), 'coder2');
});

test('after removing coder1, the next registration reuses the freed number', () => {
  const registry: AgentsRegistry = {
    coder2: { agent_id: 'coder2', instance_id: 'a', tab_id: 1, role: 'coder', status: 'IDLE' },
  };
  assert.equal(nextAgentId(registry, 'coder'), 'coder1');
});

test('buildInitPrompt inserts extraContext at the designated place', () => {
  const withoutContext = buildInitPrompt('coder1', 'coder', 'ROLE BODY');
  assert.doesNotMatch(withoutContext, /EXTRA CONTEXT MARKER/);

  const withContext = buildInitPrompt('coder1', 'coder', 'ROLE BODY', 'EXTRA CONTEXT MARKER');
  assert.match(withContext, /\[INIT: coder1\]/);
  assert.match(withContext, /ROLE BODY/);
  assert.match(withContext, /EXTRA CONTEXT MARKER/);
  assert.match(withContext, /\[READY\]/);
  assert.match(withContext, /\[\/INIT\]/);
  // порядок: роль, затем extraContext, затем инструкция ответить READY
  const roleIdx = withContext.indexOf('ROLE BODY');
  const ctxIdx = withContext.indexOf('EXTRA CONTEXT MARKER');
  const readyIdx = withContext.indexOf('[READY]');
  assert.ok(roleIdx < ctxIdx && ctxIdx < readyIdx);
});

test('registerAgent: normal flow creates INITIALIZING entry and an INIT command to inject', () => {
  const outcome = registerAgent({
    registry: {},
    payload: registerPayload('coder'),
    instanceId: 'browser_a',
    roleMd: 'ROLE BODY',
    now: '2026-08-29T00:00:00.000Z',
    authBlocked: false,
  });

  assert.equal(outcome.registry.coder1.status, 'INITIALIZING');
  assert.equal(outcome.registry.coder1.instance_id, 'browser_a');
  assert.ok(outcome.toCommand);
  assert.equal(outcome.toCommand?.instanceId, 'browser_a');
  assert.equal(outcome.toCommand?.message.type, 'COMMAND');
  assert.equal(outcome.toCommand?.message.to, 'coder1');
  assert.equal(outcome.toBus, undefined);
});

test('registerAgent: needs_auth + no login selector -> BLOCKED, no inject happened', () => {
  const outcome = registerAgent({
    registry: {},
    payload: registerPayload('coder'),
    instanceId: 'browser_a',
    roleMd: 'ROLE BODY',
    now: '2026-08-29T00:00:00.000Z',
    authBlocked: true,
  });

  assert.equal(outcome.registry.coder1.status, 'BLOCKED');
  assert.equal(outcome.toCommand, undefined);
  assert.ok(outcome.toBus);
  assert.equal(outcome.toBus?.type, 'NOTIFY');
});

test('READY within the timeout -> IDLE; silence past the timeout -> INIT_FAILED, no recovery attempt spent', () => {
  const registry: AgentsRegistry = {
    coder1: { agent_id: 'coder1', instance_id: 'a', tab_id: 1, role: 'coder', status: 'INITIALIZING', registered_at: '2026-08-29T00:00:00.000Z' },
  };
  const withinTimeout = checkInitTimeouts(registry, Date.parse('2026-08-29T00:00:30.000Z'), 60000);
  assert.equal(withinTimeout.coder1.status, 'INITIALIZING');

  const pastTimeout = checkInitTimeouts(registry, Date.parse('2026-08-29T00:01:01.000Z'), 60000);
  assert.equal(pastTimeout.coder1.status, 'INIT_FAILED');
});

test('the orchestrator is created through the same registerAgent code as any other agent', () => {
  const outcome = registerAgent({
    registry: {},
    payload: registerPayload('orchestrator'),
    instanceId: 'browser_a',
    roleMd: 'ORCHESTRATOR ROLE',
    now: '2026-08-29T00:00:00.000Z',
    authBlocked: false,
    extraContext: 'ROSTER TEXT',
  });
  assert.equal(outcome.registry.orchestrator1.role, 'orchestrator');
  assert.equal(outcome.registry.orchestrator1.status, 'INITIALIZING');
  const args = (outcome.toCommand?.message.payload as { args: { text: string } }).args;
  assert.match(args.text, /ROSTER TEXT/);
});
