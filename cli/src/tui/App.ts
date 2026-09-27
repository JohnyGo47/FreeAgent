// Ink TUI - asynchronous rendering, does not block the main loop (spec_cli constraint). Without JSX: node
// strips types rather than transpiling JSX, so components are assembled via React.createElement.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentsRegistry } from '../registry/registry.ts';
import { runReplCommand, type ReplContext, type ReplResult } from '../cli/replCommands.ts';
import type { PlanGate } from '../cli/planMode.ts';
import type { FreeAgentConfig } from '../config/config.ts';

const h = React.createElement;

// spec_git_checkpoints task B.13: "non-git project - checkpoints disabled on failure, PERMANENT
// warning in TUI (don't be silent)". Pure function - tested without ink render harness; init.ts
// persists git_checkpoints:false, so the banner survives a CLI restart, not just the current one
// session (as opposed to the one-time console.warn in cmdInit).
export function checkpointsWarning(config: FreeAgentConfig): string | null {
  return config.git_checkpoints === false ? 'WARNING: git checkpoints are disabled - /undo is not available, agent changes are not auto-committed' : null;
}

export interface AppProps {
  getContext: () => ReplContext;
  onResult: (result: ReplResult) => void;
  getGate: () => PlanGate;
  onApprovePlan: () => void;
  onCancelPlan: () => void;
  onEditPlan: () => void; // bin.ts does the real $EDITOR (spawn + reading the temp file), the App doesn't know about it
  tickMs?: number;
}

// spec_cli_plan_mode Output: "[Enter] execute / [e] edit in $EDITOR / [Esc] cancel."
function renderPlan(gate: PlanGate): React.ReactElement[] {
  if (gate.status !== 'plan_ready' || !gate.plan) return [];
  const rows = gate.plan.steps.map((s) =>
    h(
      Text,
      { key: s.step_id },
      `  STEP ${s.step_id} | ${s.agent_id} | ${s.description} | FILES: ${s.files.join(', ')} | DEPENDS: ${s.depends_on.join(', ') || 'none'}`,
    ),
  );
  return [
    h(Text, { key: 'hdr', bold: true, color: 'yellow' }, 'PLAN awaiting confirmation:'),
    ...rows,
    h(Text, { key: 'help', dimColor: true }, '[Enter] execute [e] edit in $EDITOR [Esc] cancel'),
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
    // While the plan is waiting for confirmation - modal mode: three keys decide its fate, normal
    // REPL input paused (spec_cli_plan_mode Output).
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

  // The mode indicator is constant, not only during an active gate (spec_cli_plan_mode
  // constraint "yolo... constant indicator in statusbar").
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
