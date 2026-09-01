// Ink TUI — рендер асинхронный, не блокирует главный цикл (spec_cli constraint). Без JSX: node
// стрипует типы, а не транспилирует JSX, поэтому компоненты собраны через React.createElement.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentsRegistry } from '../registry/registry.ts';
import { runReplCommand, type ReplContext, type ReplResult } from '../cli/replCommands.ts';
import type { PlanGate } from '../cli/planMode.ts';
import type { FreeAgentConfig } from '../config/config.ts';

const h = React.createElement;

// spec_git_checkpoints задача B.13: "не-git проект — при отказе чекпоинты отключены, ПОСТОЯННЫЙ
// warning в TUI (не молчать)". Чистая функция — тестируется без ink render harness; init.ts
// персистирует git_checkpoints:false, поэтому баннер переживает рестарт CLI, не только текущую
// сессию (в отличие от разового console.warn в cmdInit).
export function checkpointsWarning(config: FreeAgentConfig): string | null {
  return config.git_checkpoints === false ? 'WARNING: git-чекпоинты отключены — /undo недоступен, изменения агентов не автокоммитятся' : null;
}

export interface AppProps {
  getContext: () => ReplContext;
  onResult: (result: ReplResult) => void;
  getGate: () => PlanGate;
  onApprovePlan: () => void;
  onCancelPlan: () => void;
  onEditPlan: () => void; // bin.ts делает реальный $EDITOR (spawn + чтение temp-файла), App про это не знает
  tickMs?: number;
}

// spec_cli_plan_mode Output: "[Enter] выполнить / [e] править в $EDITOR / [Esc] отменить".
function renderPlan(gate: PlanGate): React.ReactElement[] {
  if (!gate.plan) return [];
  const rows = gate.plan.steps.map((s) =>
    h(
      Text,
      { key: s.step_id },
      `  STEP ${s.step_id} | ${s.agent_id} | ${s.description} | FILES: ${s.files.join(', ')} | DEPENDS: ${s.depends_on.join(', ') || 'none'}`,
    ),
  );
  return [
    h(Text, { key: 'hdr', bold: true, color: 'yellow' }, 'PLAN ждёт подтверждения:'),
    ...rows,
    h(Text, { key: 'help', dimColor: true }, '[Enter] выполнить  [e] править в $EDITOR  [Esc] отменить'),
  ];
}

export function App({ getContext, onResult, getGate, onApprovePlan, onCancelPlan, onEditPlan, tickMs = 1000 }: AppProps): React.ReactElement {
  const [, forceTick] = useState(0);
  const [input, setInput] = useState('');
  const [lastOutput, setLastOutput] = useState('');

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const gate = getGate();
  const planReady = gate.status === 'plan_ready';

  useInput((char, key) => {
    // Пока план ждёт подтверждения — модальный режим: три клавиши решают его судьбу, обычный
    // ввод REPL приостановлен (spec_cli_plan_mode Output).
    if (planReady) {
      if (key.return) onApprovePlan();
      else if (key.escape) onCancelPlan();
      else if (char === 'e') onEditPlan();
      return;
    }

    if (key.return) {
      if (input.length > 0) {
        const result = runReplCommand(input, getContext());
        setLastOutput(result.output);
        onResult(result);
      }
      setInput('');
    } else if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
    } else if (!key.ctrl && !key.meta) {
      setInput((s) => s + char);
    }
  });

  const registry: AgentsRegistry = getContext().registry;
  const rows = Object.values(registry).map((a) =>
    h(Text, { key: a.agent_id }, `${a.agent_id} [${a.role}] ${a.status}`),
  );

  // Индикатор режима — постоянный, не только во время активного гейта (spec_cli_plan_mode
  // constraint "yolo... постоянный индикатор в statusbar").
  const modeLabel = gate.status === 'yolo' || getContext().config.mode === 'yolo' ? 'YOLO' : 'PLAN';
  const warning = checkpointsWarning(getContext().config);

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, `FreeAgent [${modeLabel}]`),
    warning ? h(Text, { key: 'checkpoints-warning', color: 'red' }, warning) : null,
    ...rows,
    ...renderPlan(gate),
    h(Text, { dimColor: true }, lastOutput),
    planReady ? null : h(Text, null, `> ${input}`),
  );
}
