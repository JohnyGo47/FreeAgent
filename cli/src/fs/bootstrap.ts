// Bootstrap project tree (spec_file_access "Bootstrap project tree"): list from the root,
// depth 2-3, injected before the first move of the model. Unlocks md_orchestrator (PR-5)
// and cli_plan_mode, which refer to real paths from this tree.
import { list } from './list.ts';
import { renderFsResult } from './dispatch.ts';
import type { FsResult } from './types.ts';

export const BOOTSTRAP_DEPTH = 3;

export async function buildBootstrapTree(root: string, depth: number = BOOTSTRAP_DEPTH): Promise<FsResult> {
  return list(root, '.', depth);
}

// The text that the CLI puts first in the agent's thread - before his first move.
export async function bootstrapInjectionText(root: string, depth: number = BOOTSTRAP_DEPTH): Promise<string> {
  const result = await buildBootstrapTree(root, depth);
  return renderFsResult(result);
}
