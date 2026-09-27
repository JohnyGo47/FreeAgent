// The only instance of FolderAccessService per extension - common for popup and offscreen
// via IndexedDB (its contents are common to all contexts of one origin extension).
import { FolderAccessService } from './folderAccessService.ts';
import { idbHandleStore } from './idbHandleStore.ts';

export const folderAccessService = new FolderAccessService(idbHandleStore);
