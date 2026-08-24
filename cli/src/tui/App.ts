// Ink TUI — рендер асинхронный, не блокирует главный цикл (spec_cli constraint). Без JSX: node
// стрипует типы, а не транспилирует JSX, поэтому компоненты собраны через React.createElement.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentsRegistry } from '../registry/registry.ts';
import { runReplCommand, type ReplContext, type ReplResult } from '../cli/replCommands.ts';

const h = React.createElement;

export interface AppProps {
  getContext: () => ReplContext;
  onResult: (result: ReplResult) => void;
  tickMs?: number;
}

export function App({ getContext, onResult, tickMs = 1000 }: AppProps): React.ReactElement {
  const [, forceTick] = useState(0);
  const [input, setInput] = useState('');
  const [lastOutput, setLastOutput] = useState('');

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  useInput((char, key) => {
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

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { bold: true }, 'FreeAgent'),
    ...rows,
    h(Text, { dimColor: true }, lastOutput),
    h(Text, null, `> ${input}`),
  );
}
