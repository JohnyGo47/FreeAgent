// Popup — user gesture операции: выбор папки, восстановление доступа (spec_fs_folder_access).
import { folderAccessService } from '../fs/service.ts';

const pickButton = document.getElementById('pick-folder');
const restoreButton = document.getElementById('restore-access');

pickButton?.addEventListener('click', async () => {
  await folderAccessService.pickFolder();
});

restoreButton?.addEventListener('click', async () => {
  const granted = await folderAccessService.requestAccess();
  if (granted && restoreButton instanceof HTMLElement) restoreButton.style.display = 'none';
});

void folderAccessService.restore().then((state) => {
  if (state === 'prompt' && restoreButton instanceof HTMLElement) restoreButton.style.display = '';
});
