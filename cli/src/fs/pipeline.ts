// Vertical assembly: text → parseFsCall → enforcement (MULTIPLE_CALLS) → dispatch → [FS_RESULT]
// (spec_file_access step 4). “You play the model with your hands” - input text of the model’s move, output text(s)
// for injection back.
import { parseFsCall } from './parseFsCall.ts';
import { dispatch } from './dispatch.ts';
import { renderFsResult } from './dispatch.ts';
import { fsError, type FsResult } from './types.ts';

export interface FsTurnResult {
  hasCall: boolean;
  results: FsResult[]; // [0] — first call completed; the rest are MULTIPLE_CALLS
  rendered: string[]; // text [FS_RESULT] blocks in the same order
}

export async function runFsTurn(root: string, modelText: string, ownedFiles?: string[] | null): Promise<FsTurnResult> {
  const { calls } = parseFsCall(modelText);
  if (calls.length === 0) return { hasCall: false, results: [], rendered: [] };

  const results: FsResult[] = [];
  results.push(await dispatch(root, calls[0].args, ownedFiles));
  for (let i = 1; i < calls.length; i++) {
    results.push(fsError('MULTIPLE_CALLS', `only one [FS] call per turn; ignored: op=${calls[i].args.op}`, 'one call per turn, then wait'));
  }

  return { hasCall: true, results, rendered: results.map(renderFsResult) };
}
