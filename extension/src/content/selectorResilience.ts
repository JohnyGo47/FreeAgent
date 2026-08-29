// selector_resilience (spec_selector_resilience v2.0) — fallback-цепочки, self-healing с
// подтверждением, community-registry. Схема адаптера не переопределяется здесь (constraint spec,
// определена в shared/adapter-types). Только content script — здесь нет прямого DOM API,
// фикстуры/query внедряются снаружи, тем же приёмом, что responseComplete.ts/messageFormat.ts.
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';

// Порядок разрешения: локальный override → цепочка из registry по порядку → self-healing (BLOCKED,
// см. SelectorHealer). Поломка каждого проваленного селектора логируется вызывающей стороной.
export function resolveSelectorChain<T>(
  chain: string[],
  override: string | undefined,
  query: (selector: string) => T | null,
  onBroken: (selector: string) => void,
): T | null {
  if (override !== undefined) {
    const found = query(override);
    if (found) return found;
    onBroken(override);
  }
  for (const selector of chain) {
    const found = query(selector);
    if (found) return found;
    onBroken(selector);
  }
  return null;
}

export interface ElementFixture {
  tag: string;
  contentEditable: boolean;
  textarea: boolean;
  visible: boolean;
  inViewport: boolean;
  area: number;
}

// Эвристика input: самый большой видимый [contenteditable=true] или textarea во viewport.
export function guessInputCandidate(elements: ElementFixture[]): ElementFixture | null {
  const candidates = elements.filter((el) => el.visible && el.inViewport && (el.contentEditable || el.textarea));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, el) => (el.area > best.area ? el : best));
}

export type SelectorRole = 'input' | 'submit' | 'response_container';

// Кандидат никогда не применяется молча (constraint spec) — до confirm()/reject() агент в
// SELECTOR_BROKEN (isBlocked() === true), задача приостановлена.
export class SelectorHealer {
  private pending = new Map<SelectorRole, ElementFixture>();
  private confirmed = new Map<SelectorRole, ElementFixture>();
  // Роль остаётся "сломанной" после reject() — отклонённый кандидат не значит, что проблема
  // решена, только что этот конкретный вариант неверен (задача остаётся приостановленной).
  private blocked = new Set<SelectorRole>();

  propose(role: SelectorRole, candidate: ElementFixture): void {
    this.pending.set(role, candidate);
    this.blocked.add(role);
  }

  confirm(role: SelectorRole): void {
    const candidate = this.pending.get(role);
    if (!candidate) return;
    this.confirmed.set(role, candidate);
    this.pending.delete(role);
    this.blocked.delete(role);
  }

  reject(role: SelectorRole): void {
    this.pending.delete(role);
  }

  confirmedSelectorFor(role: SelectorRole): ElementFixture | null {
    return this.confirmed.get(role) ?? null;
  }

  isBlocked(): boolean {
    return this.blocked.size > 0;
  }
}

// Community-registry: подтверждённый селектор пишется локально сразу; отправка в community —
// только по явному действию пользователя (constraint: "никакой автоматической телеметрии") —
// вне этой функции. Сетевая ошибка — забота вызывающего (он просто не вызывает merge).
export function mergeRemoteRegistry(local: AdapterRegistry, remote: AdapterRegistry): AdapterRegistry {
  return remote.registry_version > local.registry_version ? remote : local;
}
