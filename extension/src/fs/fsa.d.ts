// File System Access API - not included in the standard lib.dom.d.ts TypeScript (Chrome-only API).
// Minimal types for what is actually used in this extension.

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

  // FileSystemObserver - Chrome/Edge only (spec_message_bus_read), not in lib.dom.d.ts.
  interface FileSystemObserverConstructor {
    new (callback: () => void): {
      observe(handle: FileSystemHandle): Promise<void>;
      disconnect(): void;
    };
  }
}
