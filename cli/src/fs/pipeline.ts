// Сборка вертикали: текст → parseFsCall → enforcement (MULTIPLE_CALLS) → dispatch → [FS_RESULT]
// (spec_file_access шаг 4). "Играешь модель руками" — вход текст хода модели, выход текст(ы)
// для инъекции обратно.
import { parseFsCall } from './parseFsCall.ts';
import { dispatch } from './dispatch.ts';
import { renderFsResult } from './dispatch.ts';
import { fsError, type FsResult } from './types.ts';

export interface FsTurnResult {
  hasCall: boolean;
  results: FsResult[]; // [0] — исполненный первый вызов; остальные — MULTIPLE_CALLS
  rendered: string[]; // текстовые [FS_RESULT] блоки в том же порядке
}

export async function runFsTurn(root: string, modelText: string): Promise<FsTurnResult> {
  const { calls } = parseFsCall(modelText);
  if (calls.length === 0) return { hasCall: false, results: [], rendered: [] };

  const results: FsResult[] = [];
  results.push(await dispatch(root, calls[0].args));
  for (let i = 1; i < calls.length; i++) {
    results.push(fsError('MULTIPLE_CALLS', `only one [FS] call per turn; ignored: op=${calls[i].args.op}`, 'one call per turn, then wait'));
  }

  return { hasCall: true, results, rendered: results.map(renderFsResult) };
}
