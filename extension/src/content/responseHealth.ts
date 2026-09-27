// response_health (spec_response_health): classification of a response that arrived, but is not working.
// Detection is in the extension (it sees the DOM), class decisions are in the CLI (ARCHITECTURE §5/§6).
// Content script only - there is no DOM API directly, text and counters are passed externally.

export interface FailurePatterns {
  unavailable: string[];
  rate_limited: string[];
  context_full: string[];
}

export type HealthClass = 'unavailable' | 'rate_limited' | 'context_full' | 'no_tags';

export interface ClassifyParams {
  text: string;
  parsedMessageCount: number; // fromTagFormat(text).length - not duplicated here
  patterns: FailurePatterns;
  threadCharCount: number;
  contextWindow: number;
  contextThresholdPct: number;
}

const NO_TAGS_MAX_LENGTH = 200;

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.toLowerCase().includes(p.toLowerCase()));
}

// Stateful: no_tags triggers only the second short/tagged reply in a row (ARCHITECTURE §6) —
// the counter lives at the tab level, so it's a class and not a pure function.
export class ResponseHealthTracker {
  private consecutiveNoTags = 0;

  classify(params: ClassifyParams): HealthClass | null {
    const { text, parsedMessageCount, patterns, threadCharCount, contextWindow, contextThresholdPct } = params;

    if (matchesAny(text, patterns.unavailable)) {
      this.consecutiveNoTags = 0;
      return 'unavailable';
    }
    if (matchesAny(text, patterns.rate_limited)) {
      this.consecutiveNoTags = 0;
      return 'rate_limited';
    }
    const contextPct = contextWindow > 0 ? (threadCharCount / contextWindow) * 100 : 0;
    if (matchesAny(text, patterns.context_full) || contextPct >= contextThresholdPct) {
      this.consecutiveNoTags = 0;
      return 'context_full';
    }

    const looksTagless = text.length < NO_TAGS_MAX_LENGTH && parsedMessageCount === 0;
    if (!looksTagless) {
      this.consecutiveNoTags = 0;
      return null;
    }
    this.consecutiveNoTags += 1;
    return this.consecutiveNoTags >= 2 ? 'no_tags' : null;
  }
}
