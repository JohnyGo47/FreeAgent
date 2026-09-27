// Intra-session TUI commands (spec_cli §"Intra-session commands").
// /status /agents /log /files respond mechanically from an already known state - none
// requires a message to the orchestrator (ARCHITECTURE §13).
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
  stopExecution?: true; // /stop (spec_plan_execution task B.13) - bin.ts applies to MainLoopState.execution
  undoRequest?: { taskId?: string }; // /undo [task_id] (spec_git_checkpoints task B.12) - git revert
  // real I/O operation, runReplCommand is synchronous; bin.ts executes it and reports the outcome via NOTIFY
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
    // /stop (spec_plan_execution task B.13): current tasks are being finalized, new ones are not leaving -
    // stopExecution() in planExecution.ts, bin.ts applies a flag to MainLoopState.execution.
    case '/stop':
      return { output: 'stop: new tasks of the plan will not be sent, current ones are being finalized', stopExecution: true };
    // /undo [task_id] (spec_git_checkpoints task B.12): without argument - last checkpoint,
    // with task_id - exactly this task. git revert itself does bin.ts (real I/O), there is only a signal here.
    case '/undo':
      return { output: arg ? `undo: rolling back ${arg}...` : 'undo: rolling back the last checkpoint...', undoRequest: { taskId: arg || undefined } };
    default:
      return out(`unknown command: ${cmd}`);
  }
}
