# Spec: message_bus_types
# Version: 2.2 — FS_CALL/FS_RESULT добавлены (микро-PR перед PR-5, проводка [FS] через шину)
# Читать вместе с ARCHITECTURE.md (§4 шина, §2 компоненты)

## Goal
Пакет `/shared/bus-types`: типы протокола шины, статусы агентов, валидация, конвертеры JSON ⇄ тег-текст. Ноль рантайм-зависимостей. Компилируется и для Node.js (CLI), и для esbuild-бандла расширения.

## Output
`/shared/bus-types/index.ts`

## Contract

### MessageType — 19 типов, закрытый union
```typescript
export type MessageType =
  // задачи и результаты
  | 'TASK' | 'RESULT' | 'STATUS'
  // жизненный цикл агента
  | 'READY' | 'REGISTER_REQUEST' | 'TAB_STATE' | 'HEARTBEAT'
  // файлы
  | 'WRITE' | 'READ' | 'TESTS_READY' | 'FS_CALL' | 'FS_RESULT'
  // планирование
  | 'PLAN' | 'PLAN_REVISED' | 'APPROVED'
  // здоровье
  | 'RESPONSE_HEALTH'
  // системное
  | 'NOTIFY' | 'COMMAND' | 'ERROR';
```

**Правило против разбухания union:** конкретные действия (`PAUSE`, `RECOVER_AGENT`, `RESEND_PROMPT`, `SWITCH_TO_BACKUP`, `REQUEST_MEMORY`) — это **значения** `CommandPayload.command`, а не отдельные типы. Тип описывает категорию сообщения, не действие.

**`HEARTBEAT` — от расширения к CLI, один на инстанс.** Не от агента (см. ARCHITECTURE §6).

**`STATUS` — выводит CLI** из тайминга TASK/RESULT (ARCHITECTURE §12); агент его не шлёт — модель по своей инициативе сообщений не отправляет (§6).

**`FS_CALL`/`FS_RESULT` — [FS]-вызов агента и его результат, как обычный `BusMessage`** (микро-PR перед PR-5, `spec_file_access`). Heredoc-тело `[FS]`-вызова едет **строкой** в `payload` — браузер его не парсит (content script кладёт сырой блок от модели как есть), разбирает только `parseFsCall` в CLI. `FS_RESULT` адресуется обратно вызвавшему агенту (`to` = его `agent_id`) тем же маршрутом, что любой адресный `BusMessage` — новый канал не заводится.

### Конверт
```typescript
export interface BusMessage {
  id: string;          // uuid, ставит отправитель при создании; стабилен до записи в incoming; дедуп мержа
  seq?: number;        // только в главной шине, присваивает CLI при мерже
  from: string;        // agent_id | 'user' | 'cli' | 'extension' | instance_id
  to: string;          // agent_id | 'orchestrator' | 'cli' | 'extension' | 'broadcast'
  type: MessageType;
  ts: string;          // ISO 8601 UTC
  payload: unknown;
}
```

`id` присваивается в момент создания сообщения и **не меняется** при переносе incoming → главная шина. Для сообщений, разобранных из ответа LLM, `id` ставит расширение сразу после `fromTagFormat`. На нём держится дедупликация при мерже (`spec_message_bus_write`): повторная обработка той же строки incoming после креша CLI не создаёт дубля.

### Payload-типы
```typescript
export interface TaskPayload      { task_id: string; description: string; files?: string[]; retry?: boolean; }
export interface ResultPayload    { task_id: string; status: 'DONE' | 'FAILED'; summary: string; self_assessment?: { percent: number; reasoning: string }; }
export interface StatusPayload    { state: 'WORKING' | 'IDLE'; task_id?: string; }
export interface WritePayload     { path: string; content: string; kind: 'code' | 'test' | 'doc' | 'data'; }
export interface ReadPayload      { path: string; }
export interface TestsReadyPayload{ task_id: string; command: string; }
export interface TabStatePayload  { agent_id: string; state: 'alive' | 'closed' | 'wrong_domain' | 'selectors_broken'; context_pct?: number; }
export interface RegisterPayload  { role: string; llm_url: string; tab_id: number; name?: string; is_backup_for?: string; }
export interface HealthPayload    { agent_id: string; klass: 'unavailable' | 'rate_limited' | 'context_full' | 'no_tags'; raw_excerpt: string; }
export interface PlanPayload      { steps: PlanStep[]; }
export interface PlanStep         { step_id: number; agent_id: string; description: string; files: string[]; depends_on: number[]; }
export interface CommandPayload   { command: string; agent_id?: string; args?: Record<string, unknown>; }
export interface NotifyPayload    { event: string; agent_id?: string; details?: string; }
export interface ErrorPayload     { message: string; context?: string; valid_agents?: string[]; }
```

`FS_CALL`/`FS_RESULT` не заводят собственный payload-тип — их `payload` это `string` (heredoc-текст `[FS|...]` / рендер `[FS_RESULT]...[/FS_RESULT]`), парсится `parseFsCall`/`dispatch` в CLI (`spec_file_access`), не типами шины.

### AgentStatus — единственное определение в проекте
```typescript
export type AgentStatus =
  | 'INITIALIZING'    // инжектирован INIT, ждём READY
  | 'INIT_FAILED'     // READY не пришёл в срок (не тратит recovery-попытки)
  | 'IDLE'            // свободен, готов принимать задачи
  | 'WORKING'         // выполняет задачу
  | 'SWITCHING'       // переезд на бэкап, задачи в очереди
  | 'BLOCKED'         // auth_required
  | 'SELECTOR_BROKEN' // селектор не резолвится, ждём подтверждения пользователя
  | 'SERVICE_DOWN'    // сервис лежит, идёт backoff
  | 'STANDBY'         // горячий бэкап, инициализирован, не активен
  | 'FAILED';         // исчерпаны попытки
```
Десять значений. `IDLE`/`WORKING` — единственная «рабочая» зона: агент готов и получает задачи. Всё остальное — переходные либо терминальные состояния, задачи для них CLI держит в буфере. `ACTIVE` намеренно отсутствует: раньше он пересекался по смыслу с `IDLE`/`WORKING`, а буфер-предикат «вне `ACTIVE`» мог застрять на освободившемся агенте. Ни одна другая спека не объявляет статусы — только импорт отсюда.

### Валидация
```typescript
export type ParseResult = { ok: true; msg: BusMessage } | { ok: false; error: string };
export function parseBusLine(line: string): ParseResult;
```
Не бросает исключений — битая строка в шине не должна крашить читателя. Строка без обязательных полей (`id`, `from`, `to`, `type`, `ts`) → `{ok:false}`.

### Конвертеры (слой перевода для LLM)
```typescript
export function toTagFormat(msg: BusMessage): string;
export function fromTagFormat(text: string): BusMessage[];
```
`fromTagFormat` обязан переживать: лишний текст вокруг блока, markdown-обёртку (```), несколько блоков в одном ответе, незакрытый тег в конце (warning + парсить до конца текста). **Это первый рубеж против главного риска проекта — непредсказуемого форматирования бесплатных LLM.**

> **Правка v2.2.** Markdown-заборы больше не вырезаются глобально по всему тексту перед поиском тегов — поиск `[MSG|...]`/`[/MSG]` их и так игнорирует (независимые структуры), а глобальная вырезка молча портила `payload`, когда он сам легитимно содержал тройные бэктики (найдено при проводке `FS_CALL`/`FS_RESULT`, у которых `payload` — произвольная строка, а не только JSON-данные). Markdown-обёртка *вокруг* блока по-прежнему не мешает извлечению — она никогда и не требовала вырезки для этого.

`id` и `seq` в тег-текст **не попадают** — это плумбинг шины, не данные для модели: `seq` присваивает CLI при мерже, `id` — отправитель при создании (для блоков из ответа LLM — расширение при разборе). Поэтому round-trip тег-формата сохраняет `from`/`to`/`type`/`payload`, но не `id`/`seq`.

## Dependencies
Нет — фундаментная спека.

## Tests
### Unit
1. Валидное сообщение каждого из 19 типов парсится
2. Битые строки (не-JSON, без `id`, без `from`, неизвестный `type`, кривой `ts`) → `{ok:false}` без исключений
3. Round-trip `fromTagFormat(toTagFormat(msg))` эквивалентен исходному по `from`/`to`/`type`/`payload` (`id`/`seq` присваиваются на границах шины и в тег не входят)
4. `fromTagFormat`: мусор вокруг тегов, markdown-обёртка, два блока в одном тексте — все извлечены
5. Незакрытый тег — сообщение извлечено, warning залогирован
6. `AgentStatus` покрывает все 10 значений, экспортируется как значение (не только тип) для рантайм-проверок

### Definition of done
- Тесты зелёные, сборка tsc + esbuild в обоих таргетах
- Ни одна другая спека не объявляет собственные типы сообщений или статусы
