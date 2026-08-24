# Spec: config
# Version: 1.0 — НОВАЯ
# Читать вместе с ARCHITECTURE.md (§4 instance_id)

## Goal
`freeagent.config.json` — единая точка настроек, общая для CLI и расширения. Процедура первого запуска, связывающая обе стороны с одной папкой.

## Output
```jsonc
{
  "version": 1,
  "project_root": ".",
  "context_threshold_pct": 60,        // порог переключения на бэкап
  "backoff_ms": [30000, 60000, 120000],
  "init_timeout_ms": 60000,
  "test_timeout_ms": 120000,
  "self_assessment_threshold": 70,
  "mode": "plan",                      // plan | yolo
  "auto_backup": true,                 // рекомендуется включённым
  "git_checkpoints": true,
  "checkpoint_branch": false,
  "registry_url": "https://raw.githubusercontent.com/<repo>/main/llm_adapter_registry.json",
  "registry_check_hours": 24,
  "known_instances": {
    "browser_a1b2c3": { "label": "Chrome — основной", "last_seen": "..." }
  }
}
```

## Contract

### Связывание CLI и расширения
Обе стороны работают с одной папкой проекта, но приходят к ней по-разному:
- CLI — через рабочую директорию (`freeagent init`)
- расширение — через `showDirectoryPicker`

Проверка совпадения: `freeagent init` записывает в конфиг маркер `project_id` (UUID). Расширение после выбора папки читает конфиг и показывает `project_id` и метку. Если конфига нет — предупреждение, что папка не инициализирована CLI.

### `known_instances`
CLI ведёт список виденных инстансов с человекочитаемыми метками, которые задаёт пользователь («Chrome — основной», «Opera — второй Kimi»). Нужно, чтобы `instance_id`-UUID был читаем в выводе `freeagent agents`.

## Constraints
- Конфиг пишет CLI; расширение читает и может запросить изменение через сообщение
- Значения по умолчанию работают без правки — конфиг опционален для старта
- `context_threshold_pct` и `backoff_ms` **требуют калибровки на реальных сервисах** — значения по умолчанию являются начальным приближением
- Неизвестные поля в конфиге сохраняются при перезаписи (forward compatibility)

## Dependencies
`spec_fs_folder_access`

## Tests
### Unit
1. Отсутствующий конфиг → все значения по умолчанию, работа не блокируется
2. Частичный конфиг → недостающие поля из умолчаний
3. Неизвестное поле сохраняется при перезаписи
4. `project_id` совпадает между CLI и расширением → связь подтверждена
5. Папка без конфига, выбранная в расширении → предупреждение

### Integration check
`freeagent init` в новой папке → выбрать её в расширении → обе стороны показывают один `project_id`

### Definition of done
- Тесты зелёные
- Прогон integration check'ов предыдущих PR
