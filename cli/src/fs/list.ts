// fs.list (spec_file_access): дерево директории, отфильтрованное от мусора.
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInRoot } from './pathGuard.ts';
import { loadIgnoreMatcher } from './ignore.ts';
import { fsError, fsOk, type FsResult } from './types.ts';

export type TreeNode = string[] | { [key: string]: TreeNode };

async function buildNode(root: string, dirAbs: string, depthRemaining: number, ignore: { isIgnored(p: string): boolean }): Promise<TreeNode> {
  if (depthRemaining <= 0) return {}; // beyond depth — заглушка "внутри есть, не раскрыто"

  const entries = await readdir(dirAbs, { withFileTypes: true });
  const kept = entries.filter((e) => !ignore.isIgnored(relative(root, join(dirAbs, e.name)).split('\\').join('/')));
  const dirs = kept.filter((e) => e.isDirectory());
  const files = kept.filter((e) => e.isFile()).map((e) => e.name).sort();

  if (dirs.length === 0) return files;

  const node: Record<string, TreeNode> = {};
  // ponytail: каталог, где вперемешку файлы и подкаталоги, кладёт свои файлы под ключ '.'
  // — иначе имя файла и имя подкаталога с тем же именем-ключом конфликтовали бы. Не встретилось
  // в тестовых деревьях; апгрейд, если реальные проекты покажут коллизию имён.
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
