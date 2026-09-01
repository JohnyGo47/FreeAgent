// Внутрисессионные команды TUI (spec_cli §"Внутрисессионные команды").
// /status /agents /log /files отвечают механически из уже известного состояния — ни одна не
// требует сообщения оркестратору (ARCHITECTURE §13).
import { randomUUID } from 'node:crypto';
import type { AgentsRegistry } from '../registry/registry.ts';
import type { BusMessage, TaskPayload } from '../../../shared/bus-types/index.ts';
import type { FreeAgentConfig } from '../config/config.ts';
import { agentsStatus, filesWritten, recentLog, statusSummary } from './status.ts';

export interface ReplContext {
  registry: AgentsRegistry;
  messages: BusMessage[];
  config: FreeAgentConfig;
}

export interface ReplResult {
  output: string;
  toOrchestrator?: BusMessage;
  configPatch?: Partial<FreeAgentConfig>;
  stopExecution?: true; // /stop (spec_plan_execution задача B.13) — bin.ts применяет к MainLoopState.execution
  undoRequest?: { taskId?: string }; // /undo [task_id] (spec_git_checkpoints задача B.12) — git revert
  // реальная I/O-операция, runReplCommand синхронна; bin.ts выполняет её и сообщает исход через NOTIFY
}

function out(output: string): ReplResult {
  return { output };
}

export function runReplCommand(input: string, ctx: ReplContext): ReplResult {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case '/status': {
      const s = statusSummary(ctx.registry, ctx.messages);
      return out(`working: ${s.agentsWorking}, idle: ${s.agentsIdle}, unavailable: ${s.agentsUnavailable}`);
    }
    case '/agents':
      return out(
        agentsStatus(ctx.registry)
          .map((a) => `${a.agent_id} [${a.role}] ${a.status}`)
          .join('\n'),
      );
    case '/log':
      return out(recentLog(ctx.messages, Number(arg) || 20).map((m) => `${m.ts} ${m.from}->${m.to} ${m.type}`).join('\n'));
    case '/files':
      return out(filesWritten(ctx.messages).join('\n'));
    case '/mode': {
      const mode = arg === 'yolo' ? 'yolo' : 'plan';
      return { output: `mode: ${mode}`, configPatch: { mode } };
    }
    case '/btw': {
      const payload: TaskPayload = { task_id: randomUUID(), description: arg };
      return {
        output: 'sent to orchestrator',
        toOrchestrator: {
          id: randomUUID(),
          from: 'user',
          to: 'orchestrator',
          type: 'TASK',
          ts: new Date().toISOString(),
          payload,
        },
      };
    }
    // /stop (spec_plan_execution задача B.13): текущие задачи дорабатывают, новые не уходят —
    // stopExecution() в planExecution.ts, bin.ts применяет флаг к MainLoopState.execution.
    case '/stop':
      return { output: 'stop: новые задачи плана не будут отправлены, текущие дорабатывают', stopExecution: true };
    // /undo [task_id] (spec_git_checkpoints задача B.12): без аргумента — последний чекпоинт,
    // с task_id — именно эта задача. Сам git revert делает bin.ts (реальная I/O), здесь только сигнал.
    case '/undo':
      return { output: arg ? `undo: откатываю ${arg}...` : 'undo: откатываю последний чекпоинт...', undoRequest: { taskId: arg || undefined } };
    default:
      return out(`unknown command: ${cmd}`);
  }
}
