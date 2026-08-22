# Spec: agent_recovery
# Version: 3.0 — реактивный, без таймаутов
# Читать вместе с ARCHITECTURE.md (§6 наблюдение, §16 ограничение по кросс-браузерности)

## Changelog
v2.x строилась на heartbeat-таймауте (150с молчания = агент упал). Heartbeat от LLM убран — модель не шлёт сообщений по своей инициативе, здоровый ждущий агент считался бы мёртвым. Теперь состояние вкладки наблюдается напрямую через `chrome.tabs`, реакция реактивная.

## Goal
Расширение видит, что вкладка агента мертва → сообщает `TAB_STATE` → CLI решает → команда на восстановление → агент переинициализирован под тем же `agent_id`.

## Input
- `TAB_STATE` от расширения: `closed` | `wrong_domain` | `selectors_broken`
- `agents_registry.json`: `agent_id`, `role`, `llm_url`, `md_path`, `instance_id`, `tab_id`, `status`, `attempts`
- `MEMORY.md` агента, если есть

## Output
- CLI → `COMMAND: RECOVER_AGENT` в `commands/<instance_id>.jsonl`
- Расширение: новая вкладка + инжект роли и `RECOVERY CONTEXT`
- После `READY`: статус `IDLE`, `NOTIFY: AGENT_RECOVERED`, задачи из очереди доставлены

## Constraints
- **Нет таймеров детектирования** — расширение сообщает об изменении состояния вкладки
- Максимум 3 попытки подряд → `FAILED`, `NOTIFY`, задачи агента остановлены
- Не восстанавливать в статусах `SWITCHING`, `SERVICE_DOWN`, `STANDBY`, `FAILED`
- **Кросс-браузерное восстановление невозможно** (ARCHITECTURE §16.1): команда идёт в инстанс, где агент был зарегистрирован. Если тот браузер закрыт — команда ждёт в файле, `NOTIFY` пользователю
- Задачи, адресованные агенту вне `IDLE`/`WORKING` (в переходном статусе), **буферизуются CLI** и доставляются после `READY`
- `llm_url` недоступен (нет сети) → сразу `FAILED`, попытки не тратятся
- Переиспользует `initializeAgent` из `spec_init_agent` — процедура не дублируется

## Dependencies
`spec_message_bus_types`, `spec_message_bus_read`, `spec_init_agent`, `spec_md_memory_template`

## Implementation notes
```typescript
// CLI — реакция на TAB_STATE, без опроса
onBusMessage('TAB_STATE', async (msg) => {
  const { agent_id, state } = msg.payload as TabStatePayload;
  if (state === 'alive') return;
  const agent = registry.get(agent_id);
  if (SKIP_RECOVERY.has(agent.status)) return;
  if (++agent.attempts > 3) return markFailed(agent);
  agent.status = 'INITIALIZING';
  writeCommand(agent.instance_id, { command: 'RECOVER_AGENT', agent_id });
});
```

Промпт восстановления — тег-текст (слой перевода), содержит полный MD роли + блок `[RECOVERY CONTEXT]` с MEMORY.md либо пометкой о его отсутствии.

## Tests
### Unit
1. `TAB_STATE: closed` → команда восстановления отправлена немедленно, без ожидания таймаута
2. Recovery не триггерится в статусах `SWITCHING`, `SERVICE_DOWN`, `STANDBY`, `FAILED`
3. После 3 попыток — `FAILED` + `NOTIFY`
4. Агент с MEMORY.md получает RECOVERY CONTEXT; без него — базовый промпт
5. Задача, отправленная агенту в `INITIALIZING`, буферизуется и доставляется после `READY`
6. Команда для закрытого браузера остаётся в файле, пользователь уведомлён
7. В коде расширения нет `setInterval` в модулях recovery (grep в CI)

### Integration check
Закрыть вкладку агента вручную → команда ушла на ближайшем тике `chrome.alarms` → агент ответил `READY` → буферизованная задача доставлена

### Definition of done
- Тесты зелёные, ручная проверка на 2 разных LLM
- Вся логика решений в CLI; расширение только сообщает состояние и исполняет команды
- Прогон integration check'ов предыдущих PR
