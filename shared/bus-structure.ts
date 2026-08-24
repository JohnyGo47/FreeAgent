// Структура /freeagent/ — общая для CLI (создаёт при `init`) и расширения (FolderAccessService).
// 6 файлов + 6 директорий = 12 позиций (STACK.md, spec_fs_folder_access, spec_cli_init).

export const STRUCTURE_FILES = [
  'message_bus.jsonl',
  'freeagent.config.json',
  'agents_registry.json',
  'llm_adapter_registry.json',
  'selector_overrides.json',
  'checkpoints.json',
] as const;

export const STRUCTURE_DIRS = ['incoming', 'commands', 'cursors', 'memory', 'skills', 'logs'] as const;
