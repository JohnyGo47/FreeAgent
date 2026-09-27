// Schema llm_adapter_registry - defined here and nowhere else (spec_llm_adapter_registry).
export interface LLMAdapter {
  domain: string;
  selectors: {
    input: string[];
    submit: string[];
    response_container: string[];
    typing_indicator: string[] | null;
    stop_button?: string[]; // optional, spec_response_complete_detection strategy 3
  };
  failure_patterns: {
    unavailable: string[];
    rate_limited: string[];
    context_full: string[];
  };
  context_window: number;
  max_retries: number;
  needs_auth: boolean;
}

export type DefaultAdapter = Omit<LLMAdapter, 'domain' | 'needs_auth'>;

export interface AdapterRegistry {
  registry_version: number;
  adapters: Record<string, LLMAdapter>;
  default: DefaultAdapter;
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string');
}

function validateSelectors(x: unknown, prefix: string, errors: string[]): void {
  if (typeof x !== 'object' || x === null) {
    errors.push(`${prefix}.selectors: missing`);
    return;
  }
  const s = x as Record<string, unknown>;
  for (const key of ['input', 'submit', 'response_container'] as const) {
    if (!isStringArray(s[key])) errors.push(`${prefix}.selectors.${key}: must be a string array`);
  }
  if (s.typing_indicator !== null && !isStringArray(s.typing_indicator)) {
    errors.push(`${prefix}.selectors.typing_indicator: must be a string array or null`);
  }
  if (s.stop_button !== undefined && !isStringArray(s.stop_button)) {
    errors.push(`${prefix}.selectors.stop_button: must be a string array`);
  }
}

function validateFailurePatterns(x: unknown, prefix: string, errors: string[]): void {
  if (typeof x !== 'object' || x === null) {
    errors.push(`${prefix}.failure_patterns: missing`);
    return;
  }
  const f = x as Record<string, unknown>;
  for (const key of ['unavailable', 'rate_limited', 'context_full'] as const) {
    if (!isStringArray(f[key])) errors.push(`${prefix}.failure_patterns.${key}: must be a string array`);
  }
}

// context_window is intentionally not required here - if absent, it is substituted from default when loading
// (spec_llm_adapter_registry test 3), this is not a circuit error.
export function validateAdapterRegistry(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return { ok: false, errors: ['registry: not an object'] };
  const reg = input as Record<string, unknown>;

  if (typeof reg.registry_version !== 'number') errors.push('registry_version: must be a number');
  if (typeof reg.adapters !== 'object' || reg.adapters === null) errors.push('adapters: must be an object');
  if (typeof reg.default !== 'object' || reg.default === null) {
    errors.push('default: missing');
  } else {
    const def = reg.default as Record<string, unknown>;
    validateSelectors(def.selectors, 'default', errors);
    validateFailurePatterns(def.failure_patterns, 'default', errors);
  }

  if (reg.adapters && typeof reg.adapters === 'object') {
    for (const [key, value] of Object.entries(reg.adapters as Record<string, unknown>)) {
      const prefix = `adapters.${key}`;
      if (typeof value !== 'object' || value === null) {
        errors.push(`${prefix}: not an object`);
        continue;
      }
      const a = value as Record<string, unknown>;
      if (typeof a.domain !== 'string') errors.push(`${prefix}.domain: must be a string`);
      validateSelectors(a.selectors, prefix, errors);
      validateFailurePatterns(a.failure_patterns, prefix, errors);
      if (typeof a.max_retries !== 'number') errors.push(`${prefix}.max_retries: must be a number`);
      if (typeof a.needs_auth !== 'boolean') errors.push(`${prefix}.needs_auth: must be a boolean`);
      if (a.context_window !== undefined && typeof a.context_window !== 'number') {
        errors.push(`${prefix}.context_window: must be a number when present`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Substitutes context_window from default if the adapter has not specified it (spec test 3).
export function fillAdapterDefaults(registry: AdapterRegistry): AdapterRegistry {
  const adapters: Record<string, LLMAdapter> = {};
  for (const [key, adapter] of Object.entries(registry.adapters)) {
    adapters[key] = {
      ...adapter,
      context_window: adapter.context_window ?? registry.default.context_window,
    };
  }
  return { ...registry, adapters };
}

// Detect: exact domain match → partial (subdomain) → default.
export function detectAdapter(hostname: string, registry: AdapterRegistry): LLMAdapter {
  const filled = fillAdapterDefaults(registry);
  if (filled.adapters[hostname]) return filled.adapters[hostname];

  for (const [domain, adapter] of Object.entries(filled.adapters)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return adapter;
  }

  return { ...filled.default, domain: hostname, needs_auth: true };
}
