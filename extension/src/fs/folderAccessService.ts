// FolderAccessService — единственный владелец FSA-хэндла корня проекта (ARCHITECTURE §4, spec_fs_folder_access).
// Ни один другой модуль не должен вызывать showDirectoryPicker/handle.getDirectoryHandle напрямую.

export interface HandleStore {
  get(key: string): Promise<FileSystemDirectoryHandle | undefined>;
  set(key: string, handle: FileSystemDirectoryHandle): Promise<void>;
}

export class FolderAccessLost extends Error {
  constructor() {
    super('folder access lost');
    this.name = 'FolderAccessLost';
  }
}

function toFolderAccessError(err: unknown): Error {
  if (err instanceof DOMException && err.name === 'NotAllowedError') return new FolderAccessLost();
  return err instanceof Error ? err : new Error(String(err));
}

// 6 файлов + 6 директорий = 12 позиций структуры (spec_fs_folder_access, тест 6).
const STRUCTURE_FILES = [
  'message_bus.jsonl',
  'freeagent.config.json',
  'agents_registry.json',
  'llm_adapter_registry.json',
  'selector_overrides.json',
  'checkpoints.json',
] as const;

const STRUCTURE_DIRS = ['incoming', 'commands', 'cursors', 'memory', 'skills', 'logs'] as const;

const STORE_KEY = 'projectRoot';

export class FolderAccessService {
  private handle: FileSystemDirectoryHandle | null = null;
  private readonly store: HandleStore;
  private readonly pickDirectory: () => Promise<FileSystemDirectoryHandle>;

  constructor(
    store: HandleStore,
    pickDirectory: () => Promise<FileSystemDirectoryHandle> = () => window.showDirectoryPicker({ mode: 'readwrite' }),
  ) {
    this.store = store;
    this.pickDirectory = pickDirectory;
  }

  // Только из user gesture — платформенное ограничение showDirectoryPicker.
  async pickFolder(): Promise<void> {
    this.handle = await this.pickDirectory();
    await this.store.set(STORE_KEY, this.handle);
    await this.ensureStructure();
  }

  async restore(): Promise<'granted' | 'prompt' | 'none'> {
    const stored = await this.store.get(STORE_KEY);
    if (!stored) return 'none';
    this.handle = stored;
    const permission = await stored.queryPermission({ mode: 'readwrite' });
    return permission === 'granted' ? 'granted' : 'prompt';
  }

  // По клику на «Восстановить доступ» — requestPermission тоже требует user gesture.
  async requestAccess(): Promise<boolean> {
    if (!this.handle) return false;
    const permission = await this.handle.requestPermission({ mode: 'readwrite' });
    return permission === 'granted';
  }

  async ensureStructure(): Promise<void> {
    const root = this.root();
    try {
      for (const dir of STRUCTURE_DIRS) await root.getDirectoryHandle(dir, { create: true });
      for (const file of STRUCTURE_FILES) await root.getFileHandle(file, { create: true });
    } catch (err) {
      throw toFolderAccessError(err);
    }
  }

  root(): FileSystemDirectoryHandle {
    if (!this.handle) throw new FolderAccessLost();
    return this.handle;
  }
}

export async function resolvePath(
  root: FileSystemDirectoryHandle,
  path: string,
  opts: { create?: boolean } = {},
): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`resolvePath: empty path`);
  try {
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: opts.create === true });
    }
    return await dir.getFileHandle(fileName, { create: opts.create === true });
  } catch (err) {
    throw toFolderAccessError(err);
  }
}
