# Spec: ext_manifest
# Version: 2.0
# Читать вместе с ARCHITECTURE.md (§5 правило MV3 — критично)

## Goal
Каркас расширения: manifest, permissions, entry points, сборка esbuild. Все спеки расширения строятся на нём.

## Output
```json
{
  "manifest_version": 3,
  "name": "FreeAgent",
  "permissions": ["tabs", "scripting", "alarms", "storage", "offscreen", "activeTab"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle" }]
}
```
Плюс собранные бандлы: background, content, popup, offscreen.

## Constraints
- `<all_urls>` оправдан: список LLM-сервисов открытый (community registry), заранее не перечислим. Объяснить в README при публикации
- **Правило MV3 (ARCHITECTURE §5) — обязательно для всего кода расширения.** CI-проверка: grep на `setInterval` вне `src/content/`
- Разделение контекстов:
  - content script — единственный, кто трогает DOM LLM-страницы
  - service worker — единственный, кто владеет `chrome.tabs` / `chrome.alarms`
  - offscreen document — единственный, кто владеет FSA-хэндлом и пишет файлы
  - popup — user gesture операции (выбор папки, пиннинг вкладки)
- Общение между контекстами: `chrome.runtime.sendMessage`
- `chrome.offscreen.createDocument({ reasons:['WORKERS'], url:'offscreen.html' })` — проверять существование перед созданием
- esbuild: 4 бандла, общий код из `/shared`
- Chrome ≥ 121; `FileSystemObserver` раньше был за флагом — для MVP допустим polling

## Dependencies
Нет — каркасная спека.

## Tests
### Unit
1. Manifest валиден при тестовой загрузке
2. esbuild собирает 4 бандла, `/shared` импортируется
3. Обработчик `chrome.alarms.onAlarm` работает после принудительной остановки SW (chrome://serviceworker-internals → stop)
4. Offscreen создаётся один раз, повторный вызов не дублирует
5. CI-grep: нет `setInterval` вне `src/content/`

### Integration check
Load unpacked → popup открывается, alarm тикает, content script инжектится, offscreen жив

### Definition of done
- Тесты зелёные, ручная загрузка в Chrome
- Прогон integration check'ов предыдущих PR
