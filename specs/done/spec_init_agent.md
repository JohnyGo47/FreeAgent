# Spec: init_agent
# Version: 2.0
# Читать вместе с ARCHITECTURE.md (§15 инициализация, §14 роли)

## Goal
Единая процедура `initializeAgent(agent, extraContext?)`, используемая в четырёх сценариях: первичное создание, recovery, активация бэкапа, переподключение после отказа сервиса.

## Input
- Флоу А: вкладка, выбранная пользователем в UI расширения + роль из `/skills/`
- Флоу Б: `llm_url` + роль из реестра (программное открытие)
- `llm_adapter_registry` — селекторы
- Опциональный `extraContext` (RECOVERY CONTEXT / MEMORY.md)

## Output
- `REGISTER_REQUEST` → CLI присваивает `agent_id` → запись в `agents_registry.json`
- Инжектирован INIT-промпт → агент отвечает `[READY]` → статус `IDLE`
- `NOTIFY: AGENT_READY`, ростер оркестратора обновлён

## Contract

### Два флоу, один код
**Флоу А — пиннинг (человек).** Пользователь открыл чат и залогинился → клик по расширению → «сделать агентом» → выбор роли из списка (список = MD-файлы `/skills/` с валидным frontmatter) → расширение шлёт `REGISTER_REQUEST` с `tab_id`.

Решает авторизацию по построению: чат открыт → вход выполнен → нужный аккаунт выбран.

**Флоу Б — программное открытие (система).** `chrome.tabs.create({ url, active: false })` + инжект. Используется recovery и активацией бэкапа. Работает только там, где вход уже выполнен; иначе `BLOCKED: auth_required`.

### Присвоение agent_id
- CLI — единственный writer `agents_registry.json`
- `agent_id` = `<role><N>`, где N — минимальный свободный номер для этой роли
- Расширение **не пишет реестр** — только `REGISTER_REQUEST` в свой incoming

### INIT-промпт (тег-текст, слой перевода)
```
[INIT: {agent_id}]
Ты — {role}. Работаешь в системе FreeAgent.
{полное содержимое MD роли}
{extraContext, если передан}
Ответь [READY] когда готов принимать задачи.
[/INIT]
```

## Constraints
- Timeout ожидания `READY`: 60с → `INIT_FAILED` + `NOTIFY`. Это **не** recovery-FAILED, попытки recovery не тратятся
- `needs_auth: true` + детектирована login-форма (нет `input` селектора) → `BLOCKED`, инжект не выполняется
- Роль без обязательного `summary` во frontmatter не появляется в списке (`spec_skills_system`)
- Оркестратор создаётся этим же флоу с ролью `orchestrator` — отдельного пути нет

## Dependencies
`spec_message_bus_types`, `spec_message_bus_write`, `spec_llm_adapter_registry`, `spec_fs_folder_access`, `spec_skills_system`

## Tests
### Unit
1. `agent_id` уникален: второй coder → `coder2`; после удаления coder1 следующий занимает свободный номер
2. `READY` в срок → `IDLE`; тишина 60с → `INIT_FAILED`, recovery-попытки не тронуты
3. `needs_auth` + login-форма → `BLOCKED`, инжекта не было
4. Реестр не пишется из кода расширения (grep в CI: нет записи `agents_registry` в бандле расширения)
5. `extraContext` вставляется в отведённое место шаблона
6. Оркестратор создаётся тем же кодом, что обычный агент

### Integration check
Живая вкладка: добавить агента через popup → `READY` → `freeagent agents` показывает `IDLE` → отправить тестовую задачу

### Definition of done
- Тесты зелёные, ручная проверка на 2 разных LLM
- Recovery, бэкап и переподключение переиспользуют `initializeAgent` — дублирования нет
- Прогон integration check'ов предыдущих PR
