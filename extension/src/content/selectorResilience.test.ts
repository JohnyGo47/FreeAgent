import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelectorChain, guessInputCandidate, SelectorHealer, mergeRemoteRegistry, type ElementFixture } from './selectorResilience.ts';
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';

test('цепочка: первый селектор null, второй находит -> возвращён второй, поломка залогирована', () => {
  const log: string[] = [];
  const query = (sel: string): string | null => (sel === '.gone' ? null : `found:${sel}`);
  const result = resolveSelectorChain(['.gone', '.works'], undefined, query, (broken) => log.push(broken));
  assert.equal(result, 'found:.works');
  assert.deepEqual(log, ['.gone']);
});

test('override приоритетнее цепочки из registry', () => {
  const query = (sel: string): string | null => `found:${sel}`;
  const result = resolveSelectorChain(['.registry'], '.override', query, () => {});
  assert.equal(result, 'found:.override');
});

test('эвристика input: на Gemini-подобной вёрстке находит самый большой видимый contenteditable во viewport', () => {
  const fixtures: ElementFixture[] = [
    { tag: 'DIV', contentEditable: false, textarea: false, visible: true, inViewport: true, area: 50000 }, // обычный контейнер
    { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 400 }, // мелкий редактируемый виджет
    { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 2200 }, // основное поле ввода
    { tag: 'DIV', contentEditable: true, textarea: false, visible: false, inViewport: true, area: 9999 }, // скрытый — не кандидат
  ];
  const candidate = guessInputCandidate(fixtures);
  assert.equal(candidate, fixtures[2]);
});

test('кандидат без подтверждения не используется, агент остаётся в SELECTOR_BROKEN', () => {
  const healer = new SelectorHealer();
  healer.propose('input', { tag: 'DIV', contentEditable: true, textarea: false, visible: true, inViewport: true, area: 100 });
  assert.equal(healer.confirmedSelectorFor('input'), null);
  assert.equal(healer.isBlocked(), true);

  healer.reject('input');
  assert.equal(healer.confirmedSelectorFor('input'), null);
  assert.equal(healer.isBlocked(), true);
});

test('подтверждённый кандидат используется, блокировка снимается', () => {
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

test('registry_version удалённого выше локального -> локальный обновлён remote-версией', () => {
  const merged = mergeRemoteRegistry(fakeRegistry(1), fakeRegistry(2));
  assert.equal(merged.registry_version, 2);
});

test('registry_version удалённого не выше -> локальный не тронут', () => {
  const merged = mergeRemoteRegistry(fakeRegistry(3), fakeRegistry(2));
  assert.equal(merged.registry_version, 3);
});
