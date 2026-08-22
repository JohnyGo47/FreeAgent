// Offscreen document — единственный владелец FSA-хэндла (ARCHITECTURE §4).
// Запись в incoming/ (Tier 1 message_bus_write) — предмет отдельной задачи PR-2 по ROADMAP,
// здесь только восстановление доступа к уже выбранной папке при старте документа.
import { folderAccessService } from '../fs/service.ts';

void folderAccessService.restore();
