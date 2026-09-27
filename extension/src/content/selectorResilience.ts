// selector_resilience (spec_selector_resilience v2.0) - fallback chains, self-healing with
// confirmation, community-registry. The adapter schema is not overridden here (constraint spec,
// defined in shared/adapter-types). Content script only - no direct DOM API here,
// fixtures/queries are injected externally using the same technique as responseComplete.ts/messageFormat.ts.
import type { AdapterRegistry } from '../../../shared/adapter-types/index.ts';

// Resolution order: local override → chain from registry in order → self-healing (BLOCKED,
// see SelectorHealer). The failure of each failed selector is logged by the caller.
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

// Heuristic input: the largest visible [contenteditable=true] or textarea in the viewport.
export function guessInputCandidate(elements: ElementFixture[]): ElementFixture | null {
  const candidates = elements.filter((el) => el.visible && el.inViewport && (el.contentEditable || el.textarea));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, el) => (el.area > best.area ? el : best));
}

export type SelectorRole = 'input' | 'submit' | 'response_container';

// The candidate is never applied silently (constraint spec) - until the agent confirm()/reject()
// SELECTOR_BROKEN (isBlocked() === true), the task is suspended.
export class SelectorHealer {
  private pending = new Map<SelectorRole, ElementFixture>();
  private confirmed = new Map<SelectorRole, ElementFixture>();
  // The role remains "broken" after reject() - a rejected candidate does not mean there is a problem
  // solved, just that this particular option is incorrect (the task remains suspended).
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

// Community-registry: the confirmed selector is written locally immediately; sending to community -
// only by explicit user action (constraint: “no automatic telemetry”) —
// outside this function. The network error is the caller's concern (he just doesn't call merge).
export function mergeRemoteRegistry(local: AdapterRegistry, remote: AdapterRegistry): AdapterRegistry {
  return remote.registry_version > local.registry_version ? remote : local;
}
