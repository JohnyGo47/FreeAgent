# Spec: llm_adapter_registry
# Version: 2.0 — единая схема, без v1/v2
# Читать вместе с ARCHITECTURE.md (§6 классификация ответов, §16 ограничения)

## Goal
Реестр DOM-адаптеров: селекторы для инжекта/чтения, паттерны нездоровых ответов, размер контекстного окна. Единственное место, где определена схема адаптера.

## Output
- `llm_adapter_registry.json` — данные
- `/shared/adapter-types/index.ts` — схема

## Contract

### Схема — определяется здесь и больше нигде
```typescript
export interface LLMAdapter {
  domain: string;
  selectors: {
    input: string[];              // fallback-цепочка, пробовать по порядку
    submit: string[];
    response_container: string[];
    typing_indicator: string[] | null;
  };
  failure_patterns: {
    unavailable: string[];        // «сервис недоступен»
    rate_limited: string[];       // «лимит исчерпан»
    context_full: string[];       // «слишком длинный разговор»
  };
  context_window: number;         // токенов, для оценки заполненности
  max_retries: number;
  needs_auth: boolean;
}

export interface AdapterRegistry {
  registry_version: number;       // версия СОДЕРЖИМОГО для community-обновлений,
                                  // не версия схемы
  adapters: Record<string, LLMAdapter>;
  default: Omit<LLMAdapter, 'domain' | 'needs_auth'>;
}
```

**Позитивных паттернов нет намеренно.** Успешный ответ приходит тегами и парсится `fromTagFormat`; `failure_patterns` нужны ровно там, где протокол не сработал — говорит интерфейс поверх модели, а не агент.

### Детект адаптера по URL
Порядок: точное совпадение домена → частичное (поддомены) → `default`.

### Покрытые сервисы (MVP)
claude.ai, gemini.google.com, chatgpt.com, copilot.microsoft.com, grok.com, chat.mistral.ai, huggingface.co/chat, perplexity.ai, chat.deepseek.com, chat.qwen.ai, kimi.moonshot.cn

`www.01.ai` исключён — нерабочий.

`context_window` заполняется по документации сервиса; при неизвестном — консервативное значение из `default`.

## Constraints
- Селекторы — всегда массивы (fallback-цепочки), даже если элемент один
- `failure_patterns` — подстроки, регистронезависимое сравнение; поддерживать локализованные варианты (сервисы отвечают на языке интерфейса)
- Registry загружается один раз при старте расширения, кэшируется в памяти
- Обновления из community-репо и локальные override — см. `spec_selector_resilience`

## Dependencies
`spec_fs_folder_access` — чтение файла реестра

## Tests
### Unit
1. Детект по точному домену, по поддомену, фолбэк на `default`
2. Адаптер без `failure_patterns` → валидация схемы падает при загрузке
3. `context_window` отсутствует → берётся из `default`, warning
4. Все 11 сервисов проходят валидацию схемы

### Integration check
Открыть по одной вкладке двух разных сервисов → селекторы `input` и `submit` резолвятся на живых страницах

### Definition of done
- Тесты зелёные, ручная проверка селекторов минимум на 2 сервисах
- Схема адаптера не продублирована ни в одной другой спеке
- Прогон integration check'ов предыдущих PR
