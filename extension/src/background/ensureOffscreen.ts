// Offscreen document is the sole owner of the FSA handle and the writer of the files (ARCHITECTURE §4/§5).
// Existence is checked before creation, calling again does not duplicate the document.

export interface OffscreenApi {
  hasDocument?: () => Promise<boolean>;
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

export interface RuntimeContextsApi {
  getURL(path: string): string;
  getContexts?: (filter: { contextTypes: Array<'OFFSCREEN_DOCUMENT'>; documentUrls: string[] }) => Promise<unknown[]>;
}

const OFFSCREEN_URL = 'offscreen.html';

export async function ensureOffscreenDocument(offscreen: OffscreenApi, runtime?: RuntimeContextsApi): Promise<void> {
  if (offscreen.hasDocument && await offscreen.hasDocument()) return;
  if (!offscreen.hasDocument && runtime?.getContexts) {
    const contexts = await runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [runtime.getURL(OFFSCREEN_URL)],
    });
    if (contexts.length > 0) return;
  }
  await offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'owns the FSA handle and writes project files',
  });
}

export async function sendWhenReady<T>(send: () => Promise<T>, attempts = 20, delayMs = 100): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await send();
    } catch (error: unknown) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
