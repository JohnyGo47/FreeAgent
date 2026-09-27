// Determine when the LLM response is completed (spec_response_complete_detection). Three strategies
// by priority: typing_indicator (+ stop_button as confirmation) > mutation debounce fallback.
// Content script only (ARCHITECTURE §5) - this uses the setInterval-compatible timer API,
// injected externally for testability (like ensureOffscreen.ts).

export interface MinimalElement {
  querySelector(selector: string): MinimalElement | null;
  textContent: string | null;
}

export interface ObserveHandle {
  disconnect(): void;
}

export interface ResponseWatcherDeps {
  observe(target: MinimalElement, onMutation: () => void): ObserveHandle;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  pollTypingIndicator(): boolean; // true while the indicator is visible
  pollStopButton(): boolean | null; // null - the adapter does not have a stop_button
  now?(): number;
}

const MUTATION_DEBOUNCE_MS = 2000;
const TYPING_DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5 * 60 * 1000;

export type ResponseCompleteReason = 'typing_indicator' | 'mutation_debounce' | 'timeout' | 'forced';

export class ResponseWatcher {
  private readonly deps: ResponseWatcherDeps;
  private readonly hasTypingIndicator: boolean;
  private mutationTimer: number | null = null;
  private typingTimer: number | null = null;
  private maxWaitTimer: number | null = null;
  private typingPollTimer: number | null = null;
  private observeHandle: ObserveHandle | null = null;
  private resolved = false;
  private resolve: ((reason: ResponseCompleteReason) => void) | null = null;

  constructor(deps: ResponseWatcherDeps, hasTypingIndicator: boolean) {
    this.deps = deps;
    this.hasTypingIndicator = hasTypingIndicator;
  }

  // One call per response. Returns a promise that resolves when completed.
  waitForComplete(container: MinimalElement): Promise<ResponseCompleteReason> {
    this.resolved = false;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.maxWaitTimer = this.deps.setTimeout(() => this.finish('timeout'), MAX_WAIT_MS);

      if (this.hasTypingIndicator) {
        this.watchTypingIndicator();
      } else {
        this.observeHandle = this.deps.observe(container, () => this.onMutation());
      }
    });
  }

  // New injection while waiting - force completion (constraint spec).
  forceComplete(): void {
    this.finish('forced');
  }

  private watchTypingIndicator(): void {
    // Simple polling of the indicator (implementation of DOM monitoring - content script detail;
    // here abstracted via pollTypingIndicator for testability).
    const tick = (): void => {
      if (this.resolved) return;
      const visible = this.deps.pollTypingIndicator();
      if (!visible) {
        if (this.typingTimer === null) {
          this.typingTimer = this.deps.setTimeout(() => this.confirmTypingIndicatorGone(), TYPING_DEBOUNCE_MS);
        }
      } else if (this.typingTimer !== null) {
        this.deps.clearTimeout(this.typingTimer);
        this.typingTimer = null;
      }
      this.typingPollTimer = this.deps.setTimeout(tick, 50);
    };
    tick();
  }

  private confirmTypingIndicatorGone(): void {
    const stop = this.deps.pollStopButton();
    if (stop === true) return; // the stop button is still visible - we don’t trust the indicator
    this.finish('typing_indicator');
  }

  private onMutation(): void {
    if (this.resolved) return;
    if (this.mutationTimer !== null) this.deps.clearTimeout(this.mutationTimer);
    this.mutationTimer = this.deps.setTimeout(() => this.finish('mutation_debounce'), MUTATION_DEBOUNCE_MS);
  }

  private finish(reason: ResponseCompleteReason): void {
    if (this.resolved) return;
    this.resolved = true;
    if (this.mutationTimer !== null) this.deps.clearTimeout(this.mutationTimer);
    if (this.typingTimer !== null) this.deps.clearTimeout(this.typingTimer);
    if (this.typingPollTimer !== null) this.deps.clearTimeout(this.typingPollTimer);
    if (this.maxWaitTimer !== null) this.deps.clearTimeout(this.maxWaitTimer);
    this.observeHandle?.disconnect();
    this.resolve?.(reason);
  }
}
