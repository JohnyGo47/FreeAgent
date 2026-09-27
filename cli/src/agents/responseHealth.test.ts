import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactToResponseHealth, candidateServices } from './responseHealth.ts';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { HealthPayload } from '../../../shared/bus-types/index.ts';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';

const BACKOFF_MS = [30000, 60000, 120000];

function registry(): AgentsRegistry {
  return { coder1: { agent_id: 'coder1', instance_id: 'browser_a', tab_id: 1, role: 'coder', status: 'WORKING' } };
}

function health(klass: HealthPayload['klass']): HealthPayload {
  return { agent_id: 'coder1', klass, raw_excerpt: 'excerpt' };
}

test('unavailable: backoff increases according to BACKOFF_MS, the recovery (attempts) counter does not change', () => {
  let reg = registry();
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    const outcome = reactToResponseHealth(reg, health('unavailable'), 'now', BACKOFF_MS, []);
    reg = outcome.registry;
    if (outcome.action.kind === 'backoff') delays.push(outcome.action.delayMs);
  }
  assert.deepEqual(delays, BACKOFF_MS);
  assert.equal(reg.coder1.status, 'SERVICE_DOWN');
  assert.equal(reg.coder1.attempts, undefined);
});

test('unavailable: after exhaustion backoff - NOTIFY with all candidates except the failed one', () => {
  let reg = registry();
  for (let i = 0; i < 3; i++) {
    reg = reactToResponseHealth(reg, health('unavailable'), 'now', BACKOFF_MS, []).registry;
  }
  const exhausted = reactToResponseHealth(reg, health('unavailable'), 'now', BACKOFF_MS, ['kimi.com', 'grok.com']);
  assert.equal(exhausted.action.kind, 'notify_exhausted');
  assert.equal(exhausted.toBus?.type, 'NOTIFY');
  if (exhausted.action.kind === 'notify_exhausted') {
    assert.deepEqual(exhausted.action.candidates, ['kimi.com', 'grok.com']);
  }
});

test('candidateServices: all registry domains except the fallen one', () => {
  const adapterRegistry: AdapterRegistry = {
    registry_version: 1,
    adapters: {
      'kimi.com': { domain: 'kimi.com', selectors: { input: [], submit: [], response_container: [], typing_indicator: null }, failure_patterns: { unavailable: [], rate_limited: [], context_full: [] }, context_window: 1000, max_retries: 3, needs_auth: false },
      'grok.com': { domain: 'grok.com', selectors: { input: [], submit: [], response_container: [], typing_indicator: null }, failure_patterns: { unavailable: [], rate_limited: [], context_full: [] }, context_window: 1000, max_retries: 3, needs_auth: false },
    },
    default: { selectors: { input: [], submit: [], response_container: [], typing_indicator: null }, failure_patterns: { unavailable: [], rate_limited: [], context_full: [] }, context_window: 1000, max_retries: 3 },
  };
  assert.deepEqual(candidateServices(adapterRegistry, 'kimi.com'), ['grok.com']);
});

test('rate_limited / context_full -> switch_backup, orchestrator receives nothing', () => {
  const forRateLimited = reactToResponseHealth(registry(), health('rate_limited'), 'now', BACKOFF_MS, []);
  assert.equal(forRateLimited.action.kind, 'switch_backup');
  assert.equal(forRateLimited.toBus, undefined);

  const forContextFull = reactToResponseHealth(registry(), health('context_full'), 'now', BACKOFF_MS, []);
  assert.equal(forContextFull.action.kind, 'switch_backup');
  assert.equal(forContextFull.toBus, undefined);
});

test('no_tags: up to 3 attempts to ask the format again, then - NOTIFY, the fourth attempt is not made', () => {
  let reg = registry();
  const kinds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const outcome = reactToResponseHealth(reg, health('no_tags'), 'now', BACKOFF_MS, []);
    reg = outcome.registry;
    kinds.push(outcome.action.kind);
  }
  assert.deepEqual(kinds, ['ask_reformat', 'ask_reformat', 'notify_no_tags_exhausted', 'notify_no_tags_exhausted']);
});
