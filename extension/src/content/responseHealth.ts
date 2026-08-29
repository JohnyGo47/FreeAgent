// response_health (spec_response_health): классификация ответа, который пришёл, но не рабочий.
// Детект — в расширении (оно видит DOM), решения по классу — в CLI (ARCHITECTURE §5/§6).
// Только content script — здесь нет DOM API напрямую, текст и счётчики передаются снаружи.

export interface FailurePatterns {
  unavailable: string[];
  rate_limited: string[];
  context_full: string[];
}

export type HealthClass = 'unavailable' | 'rate_limited' | 'context_full' | 'no_tags';

export interface ClassifyParams {
  text: string;
  parsedMessageCount: number; // fromTagFormat(text).length — не дублируется здесь
  patterns: FailurePatterns;
  threadCharCount: number;
  contextWindow: number;
  contextThresholdPct: number;
}

const NO_TAGS_MAX_LENGTH = 200;

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.toLowerCase().includes(p.toLowerCase()));
}

// Stateful: no_tags триггерит только на второй подряд короткий/безтеговый ответ (ARCHITECTURE §6) —
// счётчик живёт на уровне вкладки, поэтому класс, а не чистая функция.
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
