# FreeAgent — Stack
# Version: 2.0
# Читать вместе с ARCHITECTURE.md

## CLI
- **Runtime:** Node.js 20+
- **Language:** TypeScript 5
- **UI:** ink (React для терминала)
- **File watching:** `fs.watch`
- **Git:** через `child_process`, без libgit2-биндингов
- **Таймеры:** обычный `setInterval` — процесс не спит, ограничений MV3 нет

## Расширение
- **Manifest:** V3
- **Language:** TypeScript 5
- **Bundler:** esbuild — 4 бандла (background, content, popup, offscreen)
- **File System:** File System Access API, хэндл в IndexedDB
- **File watching:** `FileSystemObserver` (Chrome/Edge) + polling fallback 2с
- **Таймеры:** только `chrome.alarms` (минимум 1 мин). `setInterval` легален **исключительно в content script**

## Shared
- **Package manager:** npm
- **Monorepo:**
```
/freeagent
  /cli          Node.js CLI
  /extension    браузерное расширение
  /shared       типы протокола, схема адаптера, шаблоны, конвертеры
```

## Файловая структура проекта пользователя
```
/freeagent/
  message_bus.jsonl          главная шина, единственный writer — CLI
  freeagent.config.json      настройки
  agents_registry.json       реестр агентов, единственный writer — CLI
  llm_adapter_registry.json  DOM-адаптеры
  selector_overrides.json    локальные починки селекторов
  checkpoints.json           маппинг task_id → commit hash
  incoming/<instance_id>.jsonl   пишет offscreen этого инстанса
  commands/<instance_id>.jsonl   пишет CLI, читает этот инстанс
  cursors/<reader_id>.json
  memory/<agent_id>.md
  skills/*.md
  logs/
```

## Браузеры
| Браузер | FileSystemObserver | Статус |
|---|---|---|
| Chrome / Chromium ≥121 | ✅ | Полная поддержка |
| Edge | ✅ | Полная поддержка |
| Brave / Opera | ✅ | Полная поддержка |
| Firefox | ❌ polling | С ограничениями |
| Safari | ❌ polling | С ограничениями |

## Целевая платформа MVP
Chrome + Node.js 20 на Windows / macOS / Linux

## Отвергнутые варианты
- **Форк opencode или плагин к нему** — их агентный цикл построен на function calling, которого в браузерных чат-интерфейсах нет. Эмуляция тегами ломалась бы непредсказуемо на многошаговых циклах
- **Gemini-сайдбар Chrome** — нативный UI браузера, не веб-страница: нет URL для `chrome.tabs.create`, нет document для content script
