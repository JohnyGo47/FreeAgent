// spec_llm_adapter_registry Tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { validateAdapterRegistry, detectAdapter, type AdapterRegistry } from './index.ts';

const REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'llm-adapter-registry.default.json');

async function loadDefaultRegistry(): Promise<AdapterRegistry> {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw) as AdapterRegistry;
}

test('detect by exact domain, by subdomain, fallback to default', async () => {
  const registry = await loadDefaultRegistry();

  const exact = detectAdapter('claude.ai', registry);
  assert.equal(exact.domain, 'claude.ai');

  const subdomain = detectAdapter('www.claude.ai', registry);
  assert.equal(subdomain.domain, 'claude.ai');

  const fallback = detectAdapter('unknown-llm.example.com', registry);
  assert.equal(fallback.domain, 'unknown-llm.example.com');
  assert.equal(fallback.context_window, registry.default.context_window);
});

test('adapter without failure_patterns fails schema validation', () => {
  const bad = {
    registry_version: 1,
    default: {
      selectors: { input: ['x'], submit: ['x'], response_container: ['x'], typing_indicator: null },
      failure_patterns: { unavailable: [], rate_limited: [], context_full: [] },
      context_window: 8000,
      max_retries: 3,
    },
    adapters: {
      'broken.example.com': {
        domain: 'broken.example.com',
        selectors: { input: ['x'], submit: ['x'], response_container: ['x'], typing_indicator: null },
        // failure_patterns отсутствует
        max_retries: 3,
        needs_auth: true,
      },
    },
  };
  const result = validateAdapterRegistry(bad);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes('failure_patterns')));
});

test('missing context_window is filled from default with fallback value', async () => {
  const registry = await loadDefaultRegistry();
  const adapter = detectAdapter('claude.ai', registry);
  assert.notEqual(adapter.context_window, undefined);
  assert.notEqual(adapter.context_window, 0);
});

test('all 11 default services pass schema validation', async () => {
  const registry = await loadDefaultRegistry();
  const result = validateAdapterRegistry(registry);
  assert.deepEqual(result, { ok: true });
  assert.equal(Object.keys(registry.adapters).length, 11);
  assert.equal('www.01.ai' in registry.adapters, false);
});
