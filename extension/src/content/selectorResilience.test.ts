import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelectorChain, guessInputCandidate, SelectorHealer, mergeRemoteRegistry, type ElementFixture } from './selectorResilience.ts';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';

test('chain: the first selector is null, the second finds -> the second is returned, the failure is logged', () => {
  const log: string[] = [];
  const query = (sel: string): string | null => (sel === '.gone' ? null : `found:${sel}`);
  const result = resolveSelectorChain(['.gone', '.works'], undefined, query, (broken) => log.push(broken));
  assert.equal(result, 'found:.works');
  assert.deepEqual(log, ['.gone']);
});

test('override takes precedence over the chain from registry', () => {
  const query = (sel: string): string | null => `found:${sel}`;
  const result = resolveSelectorChain(['.registry'], '.override', query, () => {});
  assert.equal(result, 'found:.override');
});

test('input heuristic: on Gemini-like layout finds the largest visible contenteditable in the viewport', () => {
  const fixtures: ElementFixture[] = [
    { tag: 'DIV', contentEditable: false, textarea: false, visible: true, inViewport: true, area: 50000 }, // regular container
    { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 400 }, // small editable widget
    { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 2200 }, // main input field
    { tag: 'DIV', contentEditable: true, textarea: false, visible: false, inViewport: true, area: 9999 }, // hidden - not a candidate
  ];
  const candidate = guessInputCandidate(fixtures);
  assert.equal(candidate, fixtures[2]);
});

test('candidate without confirmation is not used, the agent remains in SELECTOR_BROKEN', () => {
  const healer = new SelectorHealer();
  healer.propose('input', { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 100 });
  assert.equal(healer.confirmedSelectorFor('input'), null);
  assert.equal(healer.isBlocked(), true);

  healer.reject('input');
  assert.equal(healer.confirmedSelectorFor('input'), null);
  assert.equal(healer.isBlocked(), true);
});

test('verified candidate is used, lock is released', () => {
  const healer = new SelectorHealer();
  const candidate: ElementFixture = { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 100 };
  healer.propose('input', candidate);
  healer.confirm('input');
  assert.equal(healer.confirmedSelectorFor('input'), candidate);
  assert.equal(healer.isBlocked(), false);
});

function fakeRegistry(version: number): AdapterRegistry {
  return {
    registry_version: version,
    adapters: {},
    default: { selectors: { input: [], submit: [], response_container: [], typing_indicator: null }, failure_patterns: { unavailable: [], rate_limited: [], context_full: [] }, context_window: 1000, max_retries: 3 },
  };
}

test('registry_version of the remote is higher than the local -> local is updated with the remote version', () => {
  const merged = mergeRemoteRegistry(fakeRegistry(1), fakeRegistry(2));
  assert.equal(merged.registry_version, 2);
});

test('registry_version of the remote one is not higher -> the local one is not touched', () => {
  const merged = mergeRemoteRegistry(fakeRegistry(3), fakeRegistry(2));
  assert.equal(merged.registry_version, 3);
});
