#!/usr/bin/env node
// `freeagent` — каркас CLI (spec_cli). Команды: init, start, do, agents, log.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { render } from 'ink';
import React from 'react';
import { runInit } from './init/init.ts';
import { loadConfig, saveConfig } from './config/config.ts';
import { loadRegistry, saveRegistry } from './registry/registry.ts';
import { BusWriter } from './bus/write.ts';
import { runMainLoopOnce, appendCommands, type MainLoopState } from './cli/mainLoop.ts';
import { buildTabStateRequests, reconcileFromResponses } from './cli/reconcile.ts';
import { acquireSessionLock, SessionAlreadyRunning } from './cli/singleSession.ts';
import { agentsStatus, recentLog } from './cli/status.ts';
import { runReplCommand } from './cli/replCommands.ts';
import { IDLE_GATE, approvePlan, cancelPlan, revisePlan, planToEditableText } from './cli/planMode.ts';
import { startExecution, stopExecution } from './cli/planExecution.ts';
import { loadCheckpoints, undoCheckpoint, undoOutcomeNotify } from './cli/gitCheckpoints.ts';
import { App } from './tui/App.ts';
import type { BusMessage } from '../../shared/bus-types/index.ts';

const h = React.createElement;

async function cmdInit(projectRoot: string, args: string[]): Promise<void> {
  const noGit = args.includes('--no-git');
  const force = args.includes('--force');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<boolean> => new Promise((resolve) => rl.question(q, (a) => resolve(/^y/i.test(a))));

  const result = await runInit(projectRoot, {
    noGit,
    force,
    confirmGitInit: async () => (noGit ? false : ask('git init? (y/N) ')),
  });
  rl.close();

  if (result.alreadyInitialized) {
    console.log('Проект уже инициализирован — используй --force для пересоздания конфига.');
    return;
  }
  console.log('✓ Проект инициализирован');
  console.log(`project_id: ${result.projectId} (покажите его в расширении для связывания)`);
  if (result.checkpointsDisabledWarning) console.warn('warning: git-чекпоинты отключены в этой сессии');
  console.log('Следующий шаг: установите расширение и выберите папку /freeagent');
}

async function cmdStart(projectRoot: string): Promise<void> {
  const freeagentDir = join(projectRoot, 'freeagent');
  const lock = await acquireSessionLock(freeagentDir).catch((err) => {
    if (err instanceof SessionAlreadyRunning) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  });

  const { config } = await loadConfig(freeagentDir);
  let registry = await loadRegistry(freeagentDir);
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));

  // Реестр после рестарта не считается достоверным — сверка через TAB_STATE (ARCHITECTURE §2).
  const tabStateRequests = buildTabStateRequests(registry);
  if (tabStateRequests.length > 0) {
    await appendCommands(freeagentDir, tabStateRequests);
  }
  registry = reconcileFromResponses(registry, {}); // ответы приходят через обычный цикл ниже; на старте — консервативно
  await saveRegistry(freeagentDir, registry);

  const state: MainLoopState = { registry, buffered: {}, cursor: 0 };
  const messages: BusMessage[] = [];

  process.on('exit', () => void lock.release());
  process.on('SIGINT', () => process.exit(0));

  const tick = async (): Promise<void> => {
    const { commands } = await runMainLoopOnce(freeagentDir, writer, state);
    if (commands.length > 0) await appendCommands(freeagentDir, commands);
    await saveRegistry(freeagentDir, state.registry);
  };
  setInterval(() => void tick(), 2000);
  await tick();

  // Правка плана: markdown в $EDITOR, отредактированное -> PLAN_REVISED (spec_cli_plan_mode).
  // Реальный spawn/temp-файл живёт здесь (composition root), planMode.ts/App.ts остаются чистыми
  // и тестируемыми без живого терминала.
  const editPlanInEditor = async (): Promise<void> => {
    if (!state.gate?.plan) return;
    const editorCmd = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'vi');
    const tmpFile = join(tmpdir(), `freeagent-plan-${Date.now()}.md`);
    await writeFile(tmpFile, planToEditableText(state.gate.plan), 'utf8');
    spawnSync(editorCmd, [tmpFile], { stdio: 'inherit' });
    const edited = await readFile(tmpFile, 'utf8').catch(() => null);
    await unlink(tmpFile).catch(() => {});
    if (edited === null || !state.gate) return;

    const outcome = revisePlan(state.gate, edited, Object.keys(state.registry));
    if ('toOrchestrator' in outcome) {
      state.gate = outcome.gate;
      state.execution = startExecution(outcome.gate.plan!);
      await writer.mergeOnce([JSON.stringify(outcome.toOrchestrator)]);
    }
    // невалидная правка: гейт остаётся plan_ready, план не тронут — можно попробовать [e] снова
  };

  render(
    h(App, {
      getContext: () => ({ registry: state.registry, messages, config }),
      getGate: () => state.gate ?? IDLE_GATE,
      onApprovePlan: () => {
        if (!state.gate) return;
        const approved = approvePlan(state.gate);
        state.gate = approved;
        if (approved.status === 'approved' && approved.plan) state.execution = startExecution(approved.plan);
      },
      onCancelPlan: () => {
        state.gate = cancelPlan();
        state.execution = undefined;
      },
      onEditPlan: () => void editPlanInEditor(),
      onResult: async (result) => {
        if (result.configPatch) {
          Object.assign(config, result.configPatch);
          await saveConfig(freeagentDir, config);
        }
        if (result.toOrchestrator) {
          await writer.mergeOnce([JSON.stringify(result.toOrchestrator)]);
        }
        if (result.stopExecution && state.execution) {
          state.execution = stopExecution(state.execution);
        }
        if (result.undoRequest) {
          // /undo — реальная I/O (git revert), поэтому исполняется здесь, не в runReplCommand
          // (spec_git_checkpoints задача B.12). Исход виден через /log (undoOutcomeNotify).
          const entries = await loadCheckpoints(freeagentDir);
          const target = result.undoRequest.taskId
            ? entries.find((e) => e.task_id === result.undoRequest!.taskId)
            : [...entries].reverse().find((e) => e.done_commit);
          if (!target) {
            const detail = result.undoRequest.taskId ? `no checkpoint for ${result.undoRequest.taskId}` : 'no checkpoints recorded';
            await writer.mergeOnce([JSON.stringify(undoOutcomeNotify(result.undoRequest.taskId ?? '(none)', false, detail))]);
          } else {
            const fsRoot = join(projectRoot, config.project_root);
            const outcome = await undoCheckpoint(fsRoot, target);
            const detail = outcome.ok ? 'reverted, files restored to pre-task state' : `${outcome.conflict ? 'conflict' : 'error'}: ${outcome.detail}`;
            await writer.mergeOnce([JSON.stringify(undoOutcomeNotify(target.task_id, outcome.ok, detail))]);
          }
        }
      },
    }),
  );
}

async function cmdDo(projectRoot: string, taskText: string): Promise<void> {
  const freeagentDir = join(projectRoot, 'freeagent');
  const writer = await BusWriter.create(join(freeagentDir, 'message_bus.jsonl'));
  const result = runReplCommand(`/btw ${taskText}`, {
    registry: {},
    messages: [],
    config: (await loadConfig(freeagentDir)).config,
  });
  if (result.toOrchestrator) await writer.mergeOnce([JSON.stringify(result.toOrchestrator)]);
  console.log('sent to orchestrator');
}

async function cmdAgents(projectRoot: string): Promise<void> {
  const registry = await loadRegistry(join(projectRoot, 'freeagent'));
  for (const row of agentsStatus(registry)) console.log(`${row.agent_id} [${row.role}] ${row.status}`);
}

async function cmdLog(projectRoot: string, n: number): Promise<void> {
  const busPath = join(projectRoot, 'freeagent', 'message_bus.jsonl');
  const { readFile } = await import('node:fs/promises');
  const { parseBusLine } = await import('../../shared/bus-types/index.ts');
  const content = await readFile(busPath, 'utf8').catch(() => '');
  const messages = content
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => parseBusLine(l))
    .filter((r): r is { ok: true; msg: BusMessage } => r.ok)
    .map((r) => r.msg);
  for (const m of recentLog(messages, n)) console.log(`${m.ts} ${m.from}->${m.to} ${m.type}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const projectRoot = process.cwd();

  switch (command) {
    case 'init':
      return cmdInit(projectRoot, args);
    case 'start':
      return cmdStart(projectRoot);
    case 'do':
      return cmdDo(projectRoot, args.join(' '));
    case 'agents':
      return cmdAgents(projectRoot);
    case 'log':
      return cmdLog(projectRoot, Number(args[0]) || 20);
    default:
      console.error('usage: freeagent <init|start|do|agents|log> [args]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
