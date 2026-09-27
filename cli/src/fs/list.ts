// fs.list (spec_file_access): directory tree, filtered from garbage.
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInRoot } from './pathGuard.ts';
import { loadIgnoreMatcher } from './ignore.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

export type TreeNode = string[] | { [key: string]: TreeNode };

async function buildNode(root: string, dirAbs: string, depthRemaining: number, ignore: { isIgnored(p: string): boolean }): Promise<TreeNode> {
  if (depthRemaining <= 0) return {}; // beyond depth — stub “there is inside, not opened”

  const entries = await readdir(dirAbs, { withFileTypes: true });
  const kept = entries.filter((e) => !ignore.isIgnored(relative(root, join(dirAbs, e.name)).split('\\').join('/')));
  const dirs = kept.filter((e) => e.isDirectory());
  const files = kept.filter((e) => e.isFile()).map((e) => e.name).sort();

  if (dirs.length === 0) return files;

  const node: Record<string, TreeNode> = {};
  // ponytail: a directory where files and subdirectories are mixed, puts its files under the key '.'
  // - otherwise the file name and the name of a subdirectory with the same key name would conflict. Didn't meet
  // in test trees; upgrade if real projects show name collisions.
  if (files.length > 0) node['.'] = files;
  for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    node[d.name] = await buildNode(root, join(dirAbs, d.name), depthRemaining - 1, ignore);
  }
  return node;
}

export async function list(root: string, path: string, depth = 1): Promise<FsResult> {
  const check = await resolveInRoot(root, path);
  if (!check.ok) return check.error;

  const st = await stat(check.resolved).catch(() => null);
  if (!st || !st.isDirectory()) {
    return fsError('NOT_FOUND', `not found: ${path}`, 'use list/search to find the target');
  }

  const ignore = await loadIgnoreMatcher(root);
  const tree = await buildNode(root, check.resolved, depth, ignore);
  return fsOk({ path: path === '.' ? '.' : path.split('\\').join('/'), tree });
}
