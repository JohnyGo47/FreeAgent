# Spec: llm adapter registry
Version 2.0 - Unified schema, without v1/v2
# Read with ARCHITECTURE.md (§6 classification of answers, §16 restrictions)

#Goal
DOM adapter registry: Inject/read selectors, unhealthy response patterns, context window size. The only place where the adapter circuit is defined.

#Output
- `llm_adapter_registry.json` - data
- `/shared/adapter-types/index.ts` - diagram

##Contract ##

### Scheme – defined here and nowhere else
```typescript
export interface LLMAdapter {
  domain: string;
  selectors: {
    input: string[];              // fallback-chain, try out
    submit: string[];
    response_container: string[];
    typing_indicator: string[] | null;
  };
  failure_patterns: {
    unavailable: string[];        // «service unavailable»
    rate_limited: string[];       // «limit exhausted»
    context_full: string[];       // «long-term»
  };
  context_window: number;         // token, fullness-assessment
  max_retries: number;
  needs_auth: boolean;
}

export interface AdapterRegistry {
  registry_version: number;       // version of the content for community-update,
                                  // schema
  adapters: Record<string, LLMAdapter>;
  default: Omit<LLMAdapter, 'domain' | 'needs_auth'>;
}
```**No positive patterns intentionally.** A successful response comes tagged and parsed by `fromTagFormat`; `failure_patterns` is needed exactly where the protocol didn't work, says the interface over the model, not the agent.

### Adapter Detection by URL
Order: exact domain match → partial (subdomains) → `default`.

##### Covered Services (MVP)
claude.ai, gemini.google.com, chatgpt.com, copilot.microsoft.com, grok.com, chat.mistral.ai, huggingface.co/chat, perplexity.ai, chat.deepseek.com, chat.qwen.ai, kimi.moonshot.cn

`www.01.ai` excluded - non-working.

`context_window` is filled in according to the service documentation; if unknown, the conservative value from `default` is filled in.

##Constraints
Selectors are always arrays (fallback chains), even if the element is one
`failure_patterns` – substrings, register-independent comparison; support localized options (services respond in the interface language)
Registry is loaded once at the start of the expansion, cached in memory
Updates from community repo and local override – see `spec_selector_resilience`

## Dependencies
`spec_fs_folder_access` - Reading the Registry File

## Tests
################################################################################################################################################################################################################################################################
1. Detection by exact domain, subdomain, foulback on `default`
2. Adapter without `failure_patterns` → Circuit Validation Drops When Booting
3. `context_window` is missing → Taken from `default`, warning
4. All 11 services are validated

###Integration check
Open one tab of two different services → selectors `input` and `submit` will be resolved on the live pages

###Definition of done
- Tests are green, manual check of selectors on at least 2 services
The adapter circuit is not duplicated in any other speck
- Run integration checks of previous PR
