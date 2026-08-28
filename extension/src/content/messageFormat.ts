// Инжект/извлечение тег-блоков в DOM вкладки LLM (spec_llm_message_format). Только content script
// (ARCHITECTURE §5). [MSG]-извлечение переиспользует /shared/bus-types (fromTagFormat/toTagFormat) —
// конвертер не дублируется здесь (constraint spec). [FS]-текст извлекается отдельно (verbatim,
// без снятия бэктиков/markdown) и передаётся выше как сырой текст — парсит его parseFsCall в CLI.
import { fromTagFormat, toTagFormat, type BusMessage } from '../../../shared/bus-types/index.ts';

export interface EditableElement {
  tagName: string; // 'TEXTAREA' | что угодно для contenteditable
  isContentEditable: boolean;
  value?: string;
  dispatchEvent(event: unknown): void;
  focus(): void;
}

export interface InputEventFactory {
  makeInsertTextEvent(text: string): unknown;
  makeInputEvent(): unknown;
}

// Инжект: contenteditable → InputEvent('insertText'), textarea → .value + 'input' event.
// Прямая запись в DOM (element.textContent = ...) не гарантированно подхватывается
// фреймворками (React/Vue) — отсюда dispatchEvent, не присваивание.
export function injectText(el: EditableElement, text: string, events: InputEventFactory): void {
  el.focus();
  if (el.isContentEditable) {
    el.dispatchEvent(events.makeInsertTextEvent(text));
  } else {
    el.value = text;
    el.dispatchEvent(events.makeInputEvent());
  }
}

export interface ClickableElement {
  click(): void;
}

export function submit(button: ClickableElement): void {
  button.click();
}

// Резолв простым перебором fallback-цепочки — PR-4 без selector_resilience (PR-6),
// см. spec_llm_message_format "Резолв селектора без selector_resilience".
export function resolveSelector<T>(chain: string[], query: (selector: string) => T | null): T | null {
  for (const selector of chain) {
    const found = query(selector);
    if (found) return found;
  }
  return null;
}

export interface RawResponseSource {
  domText: string; // innerHTML-derived textContent как рендерится в DOM
  rawText: string; // текст без интерпретации markdown (если интерфейс отдаёт его отдельно)
  isInsideCodeBlock: boolean; // true, если ответ обёрнут в <code> — извлекать textContent, не innerHTML
}

export interface ExtractedMessages {
  messages: BusMessage[];
  fsCallText: string | null; // сырой [FS | ...] блок verbatim, до первого закрывающего маркера — см. note ниже
  noise: string[]; // текст между блоками — не мусор для пользователя, логируется
}

const FS_HEADER_RE = /\[FS\s*\|[\s\S]*?\]/;

// Извлекает сырой текст [FS]-вызова verbatim (без снятия бэктиков — heredoc-тело FS не markdown,
// парсит его parseFsCall в CLI, не здесь). Ищет от заголовка [FS|...] до конца ответа: точный
// heredoc-маркер этой версии не знает браузер (он в args модели), поэтому передаётся весь хвост
// от заголовка и режется на месте, в CLI (parseFsCall тот же способ, что и tail truncation).
function extractFsCallText(text: string): string | null {
  const match = FS_HEADER_RE.exec(text);
  if (!match) return null;
  return text.slice(match.index);
}

// Текст вне [MSG]...[/MSG] блоков — не мусор для парсера (constraint spec), логируется отдельно
// от fromTagFormat, которая отдаёт только распарсенные сообщения, не окружающую прозу.
const MSG_BLOCK_RE = /\[MSG\s*\|[\s\S]*?\]\s*[\s\S]*?\[\/MSG\]/g;

function extractNoise(text: string): string[] {
  const segments = text.split(MSG_BLOCK_RE).map((s) => s.trim()).filter((s) => s.length > 0);
  return segments;
}

// Извлекает [MSG]-блоки (через fromTagFormat) и (опционально) сырой [FS]-вызов из ответа модели.
export function extractMessages(source: RawResponseSource): ExtractedMessages {
  const text = source.isInsideCodeBlock ? source.rawText : source.domText;
  const messages = fromTagFormat(text);
  const fsCallText = extractFsCallText(text);
  const noise = extractNoise(text);

  return { messages, fsCallText, noise };
}

export { fromTagFormat, toTagFormat };

// Одна очередь инжектов на вкладку (constraint: "не инжектировать, пока предыдущий ответ не
// завершён"). Промис-цепочка, как InstanceBusWriter — тот же паттерн, доказанный в PR-2.
export class InjectQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
