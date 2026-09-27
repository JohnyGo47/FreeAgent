// Inject/extract tag blocks into the DOM of the LLM tab (spec_llm_message_format). Content script only
// (ARCHITECTURE §5). [MSG]-extract reuses /shared/bus-types (fromTagFormat/toTagFormat) -
// the converter is not duplicated here (constraint spec). [FS]-text is extracted separately (verbatim,
// without removing backticks/markdown) and is passed above as raw text - it is parsed by parseFsCall in the CLI.
import { fromTagFormat, toTagFormat, type BusMessage } from '../../../shared/bus-types/index.ts';

export interface EditableElement {
  tagName: string; // 'TEXTAREA' | anything for contenteditable
  isContentEditable: boolean;
  value?: string;
  dispatchEvent(event: unknown): void;
  focus(): void;
}

export interface InputEventFactory {
  makeInsertTextEvent(text: string): unknown;
  makeInputEvent(): unknown;
}

// Inject: contenteditable → InputEvent('insertText'), textarea → .value + 'input' event.
// Direct writing to the DOM (element.textContent = ...) is not guaranteed to be picked up
// frameworks (React/Vue) - hence dispatchEvent, not assignment.
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

// Resolve by simple search of the fallback chain - PR-4 without selector_resilience (PR-6),
// see spec_llm_message_format "Resolve selector without selector_resilience".
export function resolveSelector<T>(chain: string[], query: (selector: string) => T | null): T | null {
  for (const selector of chain) {
    const found = query(selector);
    if (found) return found;
  }
  return null;
}

export interface RawResponseSource {
  domText: string; // innerHTML-derived textContent as rendered in the DOM
  rawText: string; // text without markdown interpretation (if the interface gives it separately)
  isInsideCodeBlock: boolean; // true if the response is wrapped in <code> - extract textContent, not innerHTML
}

export interface ExtractedMessages {
  messages: BusMessage[];
  fsCallText: string | null; // raw [FS | ...] verbatim block, up to the first closing marker - see note below
  noise: string[]; // text between blocks is not garbage for the user, it is logged
}

const FS_HEADER_RE = /\[FS\s*\|[\s\S]*?\]/;

// Extracts the raw text of the [FS] verbatim call (without removing backticks - heredoc body of FS is not markdown,
// parses it parseFsCall in the CLI, not here). Searches from header [FS|...] to end of response: exact
// the heredoc marker of this version is not known to the browser (it is in the args model), so the entire tail is transmitted
// from the header and cut in place, in the CLI (parseFsCall is the same method as tail truncation).
function extractFsCallText(text: string): string | null {
  const match = FS_HEADER_RE.exec(text);
  if (!match) return null;
  return text.slice(match.index);
}

// Text outside [MSG]...[/MSG] blocks is not garbage for the parser (constraint spec), logged separately
// from fromTagFormat, which returns only parsed messages, not surrounding prose.
const MSG_BLOCK_RE = /\[MSG\s*\|[\s\S]*?\]\s*[\s\S]*?\[\/MSG\]/g;

export function hasCompleteProtocolBlock(text: string): boolean {
  if (/\[READY\]/.test(text)) return true;
  if (/\[PLAN\][\s\S]*?\[\/PLAN\]/.test(text)) return true;
  if (/\[MSG\s*\|[\s\S]*?\]\s*[\s\S]*?\[\/MSG\]/.test(text)) return true;

  const fsHeader = /\[FS\s*\|([^\]]*)\]/.exec(text);
  if (!fsHeader) return false;
  const endMarker = /(?:^|\|)\s*end\s*:\s*([^|\s]+)/i.exec(fsHeader[1])?.[1];
  if (!endMarker) return true;
  return text.slice(fsHeader.index + fsHeader[0].length).includes(endMarker);
}

function extractNoise(text: string): string[] {
  const segments = text.split(MSG_BLOCK_RE).map((s) => s.trim()).filter((s) => s.length > 0);
  return segments;
}

// Extracts [MSG] blocks (via fromTagFormat) and (optional) raw [FS] call from the model response.
export function extractMessages(source: RawResponseSource): ExtractedMessages {
  const text = source.isInsideCodeBlock ? source.rawText : source.domText;
  const messages = fromTagFormat(text);
  const fsCallText = extractFsCallText(text);
  const noise = extractNoise(text);

  return { messages, fsCallText, noise };
}

export { fromTagFormat, toTagFormat };

// One injection queue per tab (constraint: "do not inject until the previous response
// completed"). A promise chain like InstanceBusWriter is the same pattern proven in PR-2.
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
