// Bootstrap-дерево проекта (spec_file_access "Bootstrap дерева проекта"): list от корня,
// depth 2-3, инжектируется до первого хода модели. Разблокирует md_orchestrator (PR-5)
// и cli_plan_mode, которые ссылаются на реальные пути из этого дерева.
import { list } from './list.ts';
import { renderFsResult } from './dispatch.ts';
import type { FsResult } from './types.ts';

export const BOOTSTRAP_DEPTH = 3;

export async function buildBootstrapTree(root: string, depth: number = BOOTSTRAP_DEPTH): Promise<FsResult> {
  return list(root, '.', depth);
}

// Текст, который CLI кладёт первым в тред агента — до его первого хода.
export async function bootstrapInjectionText(root: string, depth: number = BOOTSTRAP_DEPTH): Promise<string> {
  const result = await buildBootstrapTree(root, depth);
  return renderFsResult(result);
}
