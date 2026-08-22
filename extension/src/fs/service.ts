// Единственный экземпляр FolderAccessService на расширение — общий для popup и offscreen
// через IndexedDB (её содержимое общее для всех контекстов одного origin расширения).
import { FolderAccessService } from './folderAccessService.ts';
import { idbHandleStore } from './idbHandleStore.ts';

export const folderAccessService = new FolderAccessService(idbHandleStore);
