// Offscreen document — единственный владелец FSA-хэндла и писатель файлов (ARCHITECTURE §4/§5).
// Существование проверяется перед созданием, повторный вызов не дублирует документ.

export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

const OFFSCREEN_URL = 'offscreen.html';

export async function ensureOffscreenDocument(offscreen: OffscreenApi): Promise<void> {
  if (await offscreen.hasDocument()) return;
  await offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'владеет FSA-хэндлом и пишет файлы проекта',
  });
}
