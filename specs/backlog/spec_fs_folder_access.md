# Spec: fs_folder_access
# Version: 2.0
# Читать вместе с ARCHITECTURE.md (§4 структура шины)

## Goal
Доступ расширения к папке проекта через FSA, персистентность разрешения между сессиями, идемпотентное создание служебной структуры.

## Input
- Клик пользователя (`showDirectoryPicker()` требует user gesture — ограничение платформы)
- IndexedDB расширения

## Output
- `FileSystemDirectoryHandle` корня, доступный всем модулям через единый сервис
- Структура:
```
/freeagent/
  message_bus.jsonl
  freeagent.config.json
  agents_registry.json
  llm_adapter_registry.json
  selector_overrides.json
  checkpoints.json
  incoming/           ← <instance_id>.jsonl
  commands/           ← <instance_id>.jsonl
  cursors/
  memory/             ← <agent_id>.md
  skills/
  logs/
```

## Constraints
- Handle сохраняется **в IndexedDB** — единственное хранилище, переживающее рестарт браузера для FSA-handles. `chrome.storage` их не умеет
- При старте: `queryPermission({mode:'readwrite'})` → `'prompt'` → кнопка «Восстановить доступ» → `requestPermission()` по клику
- Создание структуры идемпотентно, существующие файлы не перезаписываются
- Все модули получают handle через `FolderAccessService` — никто не вызывает picker самостоятельно
- Доступ отозван во время работы → типизированная ошибка `FolderAccessLost`, `NOTIFY`, баннер в UI
- `showDirectoryPicker` доступен из popup/options/offscreen, **не из service worker**

## Dependencies
`spec_ext_manifest`

## Implementation notes
```typescript
class FolderAccessService {
  private handle: FileSystemDirectoryHandle | null = null;
  async pickFolder(): Promise<void> {           // только из user gesture
    this.handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet('projectRoot', this.handle);
    await this.ensureStructure();
  }
  async restore(): Promise<'granted' | 'prompt' | 'none'> { /* ... */ }
  async ensureStructure(): Promise<void> { /* идемпотентно */ }
  root(): FileSystemDirectoryHandle { /* throw FolderAccessLost если null */ }
}
```
`resolvePath(root, "incoming/browser_a1b2c3.jsonl")` — последовательные `getDirectoryHandle`/`getFileHandle`, `{create:true}` только для служебных файлов.

## Tests
### Unit
1. `ensureStructure` на пустой папке создаёт всё дерево; повторный вызов не перезаписывает
2. `restore` без сохранённого handle → `'none'`
3. `restore` при `granted` → сервис готов без диалога
4. Операция при отозванном доступе → `FolderAccessLost`, не generic exception
5. `resolvePath` создаёт поддиректории только при `create:true`
6. Все 12 позиций структуры создаются

### Integration check
Выбрать папку → перезапустить браузер → доступ восстановлен максимум в один клик → запись в incoming работает

### Definition of done
- Тесты зелёные, ручная проверка в Chrome
- Ни один модуль не обращается к FSA мимо `FolderAccessService`
- Прогон integration check'ов предыдущих PR
