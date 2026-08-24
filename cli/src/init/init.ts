// `freeagent init` — spec_cli_init. Создаёт /freeagent/, конфиг, копирует встроенные скиллы,
// опционально git init. Идемпотентно: повторный вызов без --force ничего не трогает.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STRUCTURE_FILES, STRUCTURE_DIRS } from '../../../shared/bus-structure.ts';
import { loadConfig, saveConfig } from '../config/config.ts';

const execFileAsync = promisify(execFile);
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'skills');

const DEFAULT_FREEAGENTIGNORE = ['.git/', 'node_modules/', '.env', '/freeagent/'].join('\n') + '\n';

export interface InitOptions {
  noGit?: boolean;
  force?: boolean;
  confirmGitInit?: () => Promise<boolean>;
  execGitInit?: (cwd: string) => Promise<void>;
}

export interface InitResult {
  alreadyInitialized: boolean;
  projectId: string;
  gitInitialized: boolean;
  checkpointsDisabledWarning: boolean;
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

async function ensureStructure(freeagentDir: string): Promise<void> {
  await mkdir(freeagentDir, { recursive: true });
  for (const dir of STRUCTURE_DIRS) await mkdir(join(freeagentDir, dir), { recursive: true });
  for (const file of STRUCTURE_FILES) {
    if (file === 'freeagent.config.json') continue; // конфиг создаёт saveConfig — валидный JSON, не пустой файл
    const path = join(freeagentDir, file);
    if (!(await exists(path))) await writeFile(path, '', 'utf8');
  }
}

async function copySkills(freeagentDir: string): Promise<void> {
  const skillsDir = join(freeagentDir, 'skills');
  await mkdir(skillsDir, { recursive: true });
  const templates = await readdir(TEMPLATES_DIR);
  for (const name of templates) {
    const dest = join(skillsDir, name);
    if (!(await exists(dest))) await copyFile(join(TEMPLATES_DIR, name), dest);
  }
}

async function ensureFreeagentIgnore(freeagentDir: string): Promise<void> {
  const path = join(freeagentDir, '..', '.freeagentignore');
  if (!(await exists(path))) await writeFile(path, DEFAULT_FREEAGENTIGNORE, 'utf8');
}

async function ensureGitignoreEntry(projectRoot: string): Promise<void> {
  const path = join(projectRoot, '.gitignore');
  const current = await readFile(path, 'utf8').catch(() => '');
  const lines = current.length > 0 ? current.split('\n') : [];
  if (lines.includes('/freeagent/')) return;
  const withEntry = current.length > 0 && !current.endsWith('\n') ? `${current}\n/freeagent/\n` : `${current}/freeagent/\n`;
  await writeFile(path, withEntry, 'utf8');
}

async function defaultExecGitInit(cwd: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd });
}

export async function runInit(projectRoot: string, opts: InitOptions = {}): Promise<InitResult> {
  const freeagentDir = join(projectRoot, 'freeagent');
  const { config: existingConfig, initialized } = await loadConfig(freeagentDir);

  if (initialized && !opts.force) {
    const config = existingConfig;
    return {
      alreadyInitialized: true,
      projectId: config.project_id ?? '',
      gitInitialized: false,
      checkpointsDisabledWarning: false,
    };
  }

  const hasGit = await exists(join(projectRoot, '.git'));
  let gitInitialized = false;
  let checkpointsDisabledWarning = false;
  if (opts.noGit) {
    checkpointsDisabledWarning = true;
  } else if (!hasGit) {
    const shouldInit = (await opts.confirmGitInit?.()) ?? false;
    if (shouldInit) {
      await (opts.execGitInit ?? defaultExecGitInit)(projectRoot);
      gitInitialized = true;
    } else {
      checkpointsDisabledWarning = true;
    }
  }

  await ensureStructure(freeagentDir);
  await copySkills(freeagentDir);
  await ensureFreeagentIgnore(freeagentDir);
  if (hasGit || gitInitialized) await ensureGitignoreEntry(projectRoot);

  const projectId = randomUUID();
  const { config } = await loadConfig(freeagentDir);
  config.project_id = projectId;
  await saveConfig(freeagentDir, config);

  return { alreadyInitialized: false, projectId, gitInitialized, checkpointsDisabledWarning };
}
