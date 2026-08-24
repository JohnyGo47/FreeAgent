// Offscreen document — единственный владелец FSA-хэндла (ARCHITECTURE §4).
// InstanceBusWriter (Tier 1, src/bus/instanceBusWriter.ts) пишет в incoming/<instance_id>.jsonl,
// но instance_id/его хранение в chrome.storage.local — часть spec_config/spec_cli_init (PR-3),
// здесь только восстановление доступа к уже выбранной папке при старте документа.
import { folderAccessService } from '../fs/service.ts';

void folderAccessService.restore();
