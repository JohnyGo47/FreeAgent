# Spec: selector_resilience
# Version: 2.0 — схема адаптера не дублируется
# Читать вместе с ARCHITECTURE.md, схема адаптера — в spec_llm_adapter_registry

## Goal
DOM-селекторы гниют: сервисы меняют вёрстку без предупреждения. Превратить главную слабость в опенсорс-преимущество: fallback-цепочки, self-healing с подтверждением, community-registry через GitHub.

## Input
- Локальный `llm_adapter_registry.json` + `selector_overrides.json`
- Удалённый registry по `registry_url` из конфига
- DOM текущей страницы

## Output
- Рабочий селектор (цепочка → свежий registry → подтверждение пользователя)
- Обновлённый `selector_overrides.json`
- Опционально: pre-filled ссылка на GitHub issue с новым селектором

## Contract

### Порядок разрешения
```
локальный override → цепочка из registry по порядку → self-healing эвристика → BLOCKED
```

### Self-healing
Эвристики кандидатов:
- **input** — самый большой видимый `[contenteditable=true]` или `textarea` во viewport
- **submit** — ближайшая к input кнопка с aria-label/иконкой отправки или `type=submit`
- **response_container** — контейнер с максимальным приростом текста при следующем **реальном** ответе. Тестовые сообщения автоматически не отправляются

**Никогда не применяется молча.** Кандидат подсвечивается outline, пользователь подтверждает/отклоняет минимальным тултипом («Это поле ввода? ✓ / ✗»), не модалкой. До подтверждения агент в статусе `SELECTOR_BROKEN`, задача приостановлена.

Статус в реестр пишет CLI (расширение шлёт сообщение) — реестр имеет единственного writer'а.

### Community-registry
- Проверка обновлений раз в 24ч (`chrome.alarms`) по `registry_version` с GitHub raw
- Сетевая ошибка → молча работать на локальном
- Подтверждённый селектор пишется в override **локально сразу**; отправка в community — только по явному действию пользователя (никакой автоматической телеметрии)
- В репо: CI-проверка схемы для PR, CONTRIBUTING-секция «как починить селектор» как first-issue

## Constraints
- **Схема адаптера определена в `spec_llm_adapter_registry` и здесь не переопределяется.** Селекторы уже массивы, `registry_version` уже есть
- `registry_url` конфигурируем — форки указывают свой

## Dependencies
`spec_llm_adapter_registry`, `spec_ext_manifest`, `spec_fs_folder_access`

## Tests
### Unit
1. Цепочка: первый селектор null, второй находит → возвращён второй, поломка залогирована
2. Override приоритетнее registry
3. Эвристика input на фикстуре Gemini-подобной вёрстки находит contenteditable
4. Кандидат без подтверждения не используется, агент в `SELECTOR_BROKEN`
5. `registry_version` удалённого выше → локальный обновлён; ниже или сеть упала → нетронут
6. Статус `SELECTOR_BROKEN` попадает в реестр через CLI, не напрямую из расширения

### Integration check
Сломать селектор input для одного сервиса в локальном registry → расширение подсвечивает кандидата → подтверждение → агент продолжает, override сохранён

### Definition of done
- Тесты зелёные, integration check пройден
- Схема адаптера не продублирована
- Прогон integration check'ов предыдущих PR
