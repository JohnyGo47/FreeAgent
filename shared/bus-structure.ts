// The /freeagent/ structure is common to the CLI (created at `init`) and the extension (FolderAccessService).
// 6 files + 6 directories = 12 positions (STACK.md, spec_fs_folder_access, spec_cli_init).

export const STRUCTURE_FILES = [
  'message_bus.jsonl',
  'freeagent.config.json',
  'agents_registry.json',
  'llm_adapter_registry.json',
  'selector_overrides.json',
  'checkpoints.json',
] as const;

export const STRUCTURE_DIRS = ['incoming', 'commands', 'cursors', 'memory', 'skills', 'logs'] as const;
