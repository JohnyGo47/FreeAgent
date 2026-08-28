# Spec: llm_message_format
# Version: 1.0
# Читать вместе с ARCHITECTURE.md (§3 путь сообщения, §4 формат)

## Goal
Инжект тег-блоков в DOM вкладки LLM и извлечение тег-блоков из ответа. Мост между JSON-шиной (мир CLI) и текстовым чатом (мир LLM).

## Input
- **Инжект:** `BusMessage` из `commands/`, конвертированное в тег-текст через `toTagFormat`
- **Извлечение:** текст ответа из DOM `response_container`, парсится `fromTagFormat`

## Output
- **Инжект:** текст вставлен в `selectors.input`, кнопка `selectors.submit` нажата
- **Извлечение:** массив `BusMessage`, записанных в `incoming/<instance_id>.jsonl`

## Contract

### Инжект
```
1. Получить адаптер по домену вкладки
2. Разрезолвить селектор input (через цепочку fallback из spec_selector_resilience)
3. Вставить текст:
     contenteditable → вставка через InputEvent('insertText')
     textarea → установка .value + dispatch('input')
4. Разрезолвить селектор submit
5. Кликнуть submit
6. Подождать подтверждения отправки:
     typing_indicator появился → отправлено
     typing_indicator === null → ждать 500ms (best effort)
```

**Почему не `element.textContent =`:** многие фреймворки (React, Vue) не слышат прямую запись в DOM. `InputEvent` и dispatch гарантируют, что фреймворк подхватит.

### Извлечение
```
1. Дождаться завершения ответа (spec_response_complete_detection)
2. Прочитать innerText последнего ответа из response_container
3. Пропустить через fromTagFormat → массив BusMessage
4. Для каждого:
     parseBusLine-валидация → ок → записать в incoming
     невалидный → handleSuspiciousResponse (spec_response_health)
5. Если fromTagFormat вернул пусто → классификация no_tags
```

### Обработка markdown-обёрток
LLM часто оборачивают ответ в markdown: ` ```\n[MSG|...]\n``` `. Конвертер `fromTagFormat` уже умеет это (`spec_message_bus_types`), но content script дополнительно:
- ищет теги как в rendered HTML (DOM), так и в raw text (некоторые интерфейсы рендерят markdown, некоторые нет)
- если DOM содержит `<code>` блок с тегами внутри — извлекает из `textContent` элемента, а не из innerHTML

### Множественные блоки в одном ответе
Оркестратор может выдать несколько `[MSG]` блоков в одном ответе (задачи нескольким агентам). Каждый извлекается отдельно. Текст между блоками (пояснения оркестратора) игнорируется — это шум для парсера, но может быть полезен пользователю → логируется.

## Constraints
- Инжект и извлечение — **только в content script** (единственный контекст с доступом к DOM страницы)
- Content script → offscreen — через `chrome.runtime.sendMessage`
- Между инжектом и извлечением content script **не блокируется** — он продолжает мониторить другие вкладки. Завершение ответа — событие, а не ожидание
- Не инжектировать, пока предыдущий ответ не завершён (одна очередь на вкладку)
- `toTagFormat` и `fromTagFormat` импортируются из `/shared/bus-types` — content script не дублирует конвертацию

### Проводка [FS]/[FS_RESULT] через шину (микро-PR перед PR-5)
Тело `[FS|...]`-вызова браузер **не парсит**: content script кладёт сырой heredoc-блок от модели в `payload` `BusMessage` типа `FS_CALL` как есть, строкой. Разбирает его только `parseFsCall` в CLI (`spec_file_access`) — здесь, как и во всей шине, действует одно правило: тег-слой payload возит, но не читает. `FS_RESULT` возвращается **вызвавшему агенту** через `commands/<instance_id>` и инжектится в DOM тем же механизмом, что любая команда агенту (§ Инжект выше) — не широковещательно и не напрямую из CLI.

## Dependencies
`spec_message_bus_types` (конвертеры), `spec_llm_adapter_registry` (селекторы), `spec_selector_resilience` (fallback-цепочки — **PR-6**; в PR-4 резолв простым перебором, см. заметку), `spec_response_complete_detection` (когда ответ готов), `spec_ext_manifest` (content script контекст)

> **Резолв селектора без `selector_resilience` (PR-6).** В PR-4 инжект резолвит `input`/`submit` **простым перебором массива** селекторов из `llm_adapter_registry` — первый найденный побеждает. `selector_resilience` (PR-6) позже оборачивает этот резолв self-healing'ом и community-registry, не меняя интерфейс `resolveSelector(chain)`. В PR-4 `selector_resilience` не импортировать — заложить шов.

## Tests
### Unit
1. Инжект в contenteditable: текст появился, InputEvent dispatched
2. Инжект в textarea: value установлен, input event dispatched
3. Submit: кнопка нажата, typing_indicator появился
4. Извлечение одного `[MSG]` блока → один валидный `BusMessage`
5. Извлечение двух блоков из одного ответа → два `BusMessage`, текст между ними залогирован
6. Markdown-обёртка ``` → блок извлечён, обёртка снята
7. Ответ внутри `<code>` в DOM → извлечён из textContent
8. Пустой `fromTagFormat` → классификация `no_tags` вызвана
9. Очередь: второй инжект ждёт завершения первого ответа

### Integration check
Открыть вкладку LLM → инжектировать тестовый `[MSG]` → дождаться ответа → извлечь → проверить round-trip JSON ⇄ теги ⇄ DOM ⇄ теги ⇄ JSON

### Definition of done
- Тесты зелёные на минимум 2 разных LLM (contenteditable + textarea)
- Round-trip не теряет и не искажает поля сообщения
- Прогон integration check'ов предыдущих PR
