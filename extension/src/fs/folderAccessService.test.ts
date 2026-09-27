import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FolderAccessService, FolderAccessLost, resolvePath, type HandleStore } from './folderAccessService.ts';

// Mock FileSystemDirectoryHandle - only that part of the contract that uses the service.
class FakeDirHandle {
  dirs = new Map<string, FakeDirHandle>();
  files = new Set<string>();
  permission: 'granted' | 'prompt' | 'denied' = 'granted';
  revoked = false;

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    if (this.revoked) throw new DOMException('revoked', 'NotAllowedError');
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      dir = new FakeDirHandle();
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<{ name: string }> {
    if (this.revoked) throw new DOMException('revoked', 'NotAllowedError');
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      this.files.add(name);
    }
    return { name };
  }

  async queryPermission(): Promise<'granted' | 'prompt' | 'denied'> {
    return this.permission;
  }

  async requestPermission(): Promise<'granted' | 'prompt' | 'denied'> {
    return this.permission;
  }
}

function memoryStore(): HandleStore & { seed(handle: FileSystemDirectoryHandle): void } {
  let saved: FileSystemDirectoryHandle | undefined;
  return {
    async get() {
      return saved;
    },
    async set(_key, handle) {
      saved = handle;
    },
    seed(handle) {
      saved = handle;
    },
  };
}

test('ensureStructure on empty folder creates whole tree; second call does not overwrite existing files', async () => {
  const fake = new FakeDirHandle();
  const store = memoryStore();
  const service = new FolderAccessService(store, async () => fake as unknown as FileSystemDirectoryHandle);

  await service.pickFolder();
  assert.equal(fake.dirs.size, 6);
  assert.equal(fake.files.size, 6);

  fake.files.add('message_bus.jsonl'); // simulates already written data
  await service.ensureStructure();
  assert.ok(fake.files.has('message_bus.jsonl'), 'existing file entry is preserved, not recreated');
});

test('restore without a saved handle returns "none"', async () => {
  const service = new FolderAccessService(memoryStore());
  assert.equal(await service.restore(), 'none');
});

test('restore with granted permission is ready without a dialog', async () => {
  const fake = new FakeDirHandle();
  fake.permission = 'granted';
  const store = memoryStore();
  store.seed(fake as unknown as FileSystemDirectoryHandle);
  const service = new FolderAccessService(store);

  assert.equal(await service.restore(), 'granted');
  assert.equal(service.root(), fake);
});

test('operation on revoked access throws FolderAccessLost, not a generic exception', async () => {
  const fake = new FakeDirHandle();
  const store = memoryStore();
  const service = new FolderAccessService(store, async () => fake as unknown as FileSystemDirectoryHandle);
  await service.pickFolder();

  fake.revoked = true;
  await assert.rejects(() => service.ensureStructure(), FolderAccessLost);
});

test('resolvePath creates subdirectories only when create:true', async () => {
  const root = new FakeDirHandle();

  await assert.rejects(() => resolvePath(root as unknown as FileSystemDirectoryHandle, 'incoming/browser_a1b2.jsonl'));

  const handle = await resolvePath(root as unknown as FileSystemDirectoryHandle, 'incoming/browser_a1b2.jsonl', {
    create: true,
  });
  assert.equal(handle.name, 'browser_a1b2.jsonl');
  assert.ok(root.dirs.has('incoming'));
});

test('all 12 structure positions are created', async () => {
  const fake = new FakeDirHandle();
  const service = new FolderAccessService(memoryStore(), async () => fake as unknown as FileSystemDirectoryHandle);

  await service.pickFolder();
  assert.equal(fake.dirs.size + fake.files.size, 12);
});
