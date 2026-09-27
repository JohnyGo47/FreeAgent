// Manual test helper: append a message to freeagent/incoming/<instance>.jsonl,
// matching what the extension writer would produce. This is not product code.
//
//   node tools/send.mjs <from> <to> <TYPE> [payload...] [--instance browser_test] [--dir <projectRoot>]
//
// Supply payload in either form:
//   key=value key=value ...  — object (integer values such as tab_id=42 are parsed)
//   'raw text'                — string (useful for PLAN or FS_CALL); \n becomes a newline
// Prefer key=value on PowerShell 5.1 because it strips quotes inside JSON arguments.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const [value] = argv.splice(i, 2).slice(1);
  return value ?? dflt;
};

const instance = flag('instance', 'browser_test');
const projectRoot = flag('dir', process.cwd());
const [from, to, type, ...rest] = argv;

if (!from || !to || !type) {
  console.error('usage: node tools/send.mjs <from> <to> <TYPE> [key=value... | "text"] [--instance id] [--dir path]');
  process.exit(1);
}

const isKeyValue = rest.length > 0 && rest.every((a) => /^[A-Za-z_][\w.]*=/.test(a));
let payload;
if (rest.length === 0) {
  payload = {};
} else if (isKeyValue) {
  payload = {};
  for (const pair of rest) {
    const i = pair.indexOf('=');
    const key = pair.slice(0, i);
    const value = pair.slice(i + 1);
    payload[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
} else {
  payload = rest.join(' ').replace(/\\n/g, '\n');
}

const msg = { id: randomUUID(), from, to, type, ts: new Date().toISOString(), payload };
const dir = join(projectRoot, 'freeagent', 'incoming');
await mkdir(dir, { recursive: true });
await appendFile(join(dir, `${instance}.jsonl`), JSON.stringify(msg) + '\n', 'utf8');
console.log(`-> incoming/${instance}.jsonl  ${from} -> ${to}  ${type}`);
