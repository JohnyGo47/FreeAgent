// freeagent.config.json — единая точка настроек CLI + расширения (spec_config, ARCHITECTURE §4).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface KnownInstance {
  label: string;
  last_seen: string;
}

export interface FreeAgentConfig {
  version: number;
  project_root: string;
  context_threshold_pct: number;
  backoff_ms: number[];
  init_timeout_ms: number;
  test_timeout_ms: number;
  self_assessment_threshold: number;
  mode: 'plan' | 'yolo';
  auto_backup: boolean;
  git_checkpoints: boolean;
  checkpoint_branch: boolean;
  registry_url: string;
  registry_check_hours: number;
  known_instances: Record<string, KnownInstance>;
  project_id?: string;
  [extra: string]: unknown;
}

export const DEFAULT_CONFIG: FreeAgentConfig = {
  version: 1,
  project_root: '.',
  context_threshold_pct: 60,
  backoff_ms: [30000, 60000, 120000],
  init_timeout_ms: 60000,
  test_timeout_ms: 120000,
  self_assessment_threshold: 70,
  mode: 'plan',
  auto_backup: true,
  git_checkpoints: true,
  checkpoint_branch: false,
  registry_url: 'https://raw.githubusercontent.com/<repo>/main/llm_adapter_registry.json',
  registry_check_hours: 24,
  known_instances: {},
};

export function configPath(freeagentDir: string): string {
  return join(freeagentDir, 'freeagent.config.json');
}

export async function loadConfig(
  freeagentDir: string,
): Promise<{ config: FreeAgentConfig; initialized: boolean }> {
  const raw = await readFile(configPath(freeagentDir), 'utf8').catch(() => null);
  if (raw === null) {
    return { config: structuredClone(DEFAULT_CONFIG), initialized: false };
  }
  const onDisk = JSON.parse(raw) as Partial<FreeAgentConfig>;
  return { config: { ...structuredClone(DEFAULT_CONFIG), ...onDisk }, initialized: true };
}

export async function saveConfig(freeagentDir: string, config: FreeAgentConfig): Promise<void> {
  await writeFile(configPath(freeagentDir), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
