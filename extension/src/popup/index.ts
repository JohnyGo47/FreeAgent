import { folderAccessService } from '../fs/service.ts';

const pickButton = document.getElementById('pick-folder') as HTMLButtonElement | null;
const restoreButton = document.getElementById('restore-access') as HTMLButtonElement | null;
const registerButton = document.getElementById('register-tab') as HTMLButtonElement | null;
const roleSelect = document.getElementById('role') as HTMLSelectElement | null;
const status = document.getElementById('status');

function showStatus(text: string, error = false): void {
  if (!status) return;
  status.textContent = text;
  status.className = error ? 'error' : 'ok';
}

async function notifyFolderReady(resetCursor = false): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'FOLDER_READY', resetCursor }) as { ok?: boolean; error?: string };
  if (result?.ok === false) throw new Error(result.error ?? 'offscreen startup failed');
}

pickButton?.addEventListener('click', () => {
  void (async () => {
    try {
      await folderAccessService.pickFolder();
      await notifyFolderReady(true);
      restoreButton?.removeAttribute('hidden');
      showStatus('Project folder connected');
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

restoreButton?.addEventListener('click', () => {
  void (async () => {
    try {
      const granted = await folderAccessService.requestAccess();
      if (!granted) throw new Error('Access to the folder is not granted');
      await notifyFolderReady();
      restoreButton.hidden = false;
      showStatus('Access restored');
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

registerButton?.addEventListener('click', () => {
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error('Open a supported LLM site in the active tab');
      const result = await chrome.runtime.sendMessage({
        type: 'REGISTER_TAB',
        role: roleSelect?.value ?? 'coder',
        tabId: tab.id,
        url: tab.url,
      }) as { ok?: boolean; error?: string };
      if (result?.ok === false) throw new Error(result.error ?? 'Failed to register tab');
      showStatus('Registration request recorded. Launch CLI or wait for INIT.');
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

void folderAccessService.restore().then(async (state) => {
  if (restoreButton) restoreButton.hidden = state === 'none';
  if (state === 'granted') {
    await notifyFolderReady();
    showStatus('Project folder connected');
  } else if (state === 'prompt') {
    showStatus('You need to restore access to the folder', true);
  } else {
    showStatus('Select the project root first');
  }
}).catch((error: unknown) => showStatus(String(error), true));
