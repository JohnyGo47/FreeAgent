// File System Access API — не входит в стандартный lib.dom.d.ts TypeScript (Chrome-only API).
// Минимальные типы под то, что реально используется в этом расширении.

export {};

type FsaPermissionMode = { mode?: 'read' | 'readwrite' };
type FsaPermissionState = 'granted' | 'prompt' | 'denied';

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: FsaPermissionMode): Promise<FsaPermissionState>;
    requestPermission(descriptor?: FsaPermissionMode): Promise<FsaPermissionState>;
  }

  interface Window {
    showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  }
}
