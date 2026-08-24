# FreeAgent — Roadmap
# Version: 3.0
# Дата: 2026-08-02

> Архитектурные решения — в `ARCHITECTURE.md` (журнал из 46 решений).
> Здесь только статус спек и порядок работ.

## Статус спек

### ✅ Готовы
| Спека | Версия | Что внутри |
|---|---|---|
| ARCHITECTURE.md | 1.1 | сквозные решения + журнал |
| STACK.md | 2.0 | стек, файловая структура, отвергнутые варианты |
| spec_message_bus_types | 2.1 | 17 типов, AgentStatus (10, без ACTIVE), id, конвертеры |
| spec_message_bus_write | 3.1 | два уровня, seq-recovery, дедуп по id |
| spec_message_bus_read | 2.1 | курсоры (at-least-once), две реализации source |
| spec_config | 1.0 | настройки, связывание CLI ↔ расширение |
| spec_cli | 1.0 | команды, TUI, главный цикл |
| spec_ext_manifest | 2.0 | MV3-каркас, 4 контекста |
| spec_fs_folder_access | 2.0 | FSA, IndexedDB, структура папки |
| spec_llm_adapter_registry | 2.0 | единая схема, failure_patterns, context_window |
| spec_selector_resilience | 2.0 | цепочки, self-healing, community |
| spec_skills_system | 1.0 | роли как MD, обязательный summary, ростер |
| spec_init_agent | 2.0 | два флоу, один код |
| spec_md_memory_template | 2.0 | формат, постоянная генерация |
| spec_agent_recovery | 3.0 | реактивный, без таймаутов |
| spec_response_health | 1.0 | 4 класса нездоровых ответов |
| spec_backup_agents | 1.0 | горячий бэкап, переключение |
| spec_plan_execution | 1.0 | план как программа |
| spec_verification | 1.0 | тест→код→CLI запускает |
| spec_cli_plan_mode | 2.0 | план по умолчанию, enforcement в CLI |
| spec_git_checkpoints | 2.0 | чекпоинты, /undo, параллельные DONE |

### ⬜ Осталось написать
| Спека | Зачем |
|---|---|
| **spec_file_access** | **READ-протокол, дерево проекта — пишется в отдельном чате, БЛОКЕР PR-4** |

### Многоэтапные спеки (реализуются в двух PR)
| Спека | PR | Что в каком PR |
|---|---|---|
| spec_message_bus_write | PR-1 + PR-2 | Tier 2 (CLI-мерж) в PR-1; Tier 1 (offscreen-писатель в incoming/) в PR-2 |
| spec_message_bus_read | PR-1 + PR-2 | NodeFsSource в PR-1; FsaSource в PR-2 |

**Не уводить эти две спеки в `specs/done/` до конца PR-2** — после PR-1 они реализованы наполовину. Это единственные многоэтапные спеки в проекте (проверено по всем зависимостям).

## Порядок PR

**PR-1 — Шина** *(самодостаточен, готов к передаче)*
`/shared` каркас → message_bus_types → message_bus_write (Tier 2) → message_bus_read (NodeFsSource)
Тест: write → read → seq монотонный.

**PR-2 — Каркас расширения**
ext_manifest → fs_folder_access → message_bus_write Tier 1 → message_bus_read FsaSource
Тест: расширение пишет в incoming → Node читает.

**PR-3 — CLI**
config → cli → cli_init
Тест: полный цикл incoming → merge → главная шина → читатель.

**PR-4 — Адаптеры и инжект**
llm_adapter_registry → llm_message_format → response_complete_detection → **file_access**

**PR-5 — Агенты**
skills_system → md_orchestrator → init_agent → md_memory_template

**PR-6 — Устойчивость**
agent_recovery → response_health → backup_agents → selector_resilience → bus_rotation

**PR-7 — Безопасность**
write_path_validation → context_privacy_filter

**PR-8 — Координация**
cli_plan_mode → plan_execution → verification → git_checkpoints

## Правило тестирования
Каждый PR заканчивается прогоном integration check'ов **всех** предыдущих PR, не только своего.

## Отложено (пост-MVP)
- Холодный бэкап (конфиг вместо открытой вкладки)
- FreeAgent как OpenAI-совместимый эндпоинт
- Полностью-CLI инициализация агентов
- README и формулировка про ToS
- Цепочки бэкапов (бэкап бэкапа)
