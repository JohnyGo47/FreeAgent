import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('offscreen delivers INIT after reopening a nonempty Unicode command file', async () => {
  const files = new Map<string, string>();
  const commandPath = 'commands/browser-test.jsonl';
  const oldText = JSON.stringify({ description: 'Old agent instruction 🚀'.repeat(100) }) + '\n';
  files.set(commandPath, oldText);
  const storage = new Map<string, string>([
    ['instanceId', JSON.stringify('browser-test')],
    ['commandCursor:browser-test', String(Buffer.byteLength(oldText))],
    ['agentTabs', JSON.stringify({ orchestrator: 10 })],
    ['pendingRegistrations', JSON.stringify([{ role: 'orchestrator', tabId: 10, url: 'https://chatgpt.com/' }])],
  ]);
  const directory = (prefix = ''): unknown => ({
    async getDirectoryHandle(name: string) { return directory(prefix + name + '/'); },
    async getFileHandle(name: string) {
      const path = prefix + name;
      return {
        async getFile() {
          const text = files.get(path) ?? '';
          return { size: Buffer.byteLength(text), async text() { return text; } };
        },
        async createWritable() {
          return {
            async write(value: { position: number; data: string }) {
              const previous = Buffer.from(files.get(path) ?? '');
              files.set(path, Buffer.concat([previous.subarray(0, value.position), Buffer.from(value.data)]).toString());
            },
            async close() {},
          };
        },
      };
    },
  });
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife',
    plugins: [{ name: 'folder-fixture', setup(builder) {
      builder.onLoad({ filter: /[\\/]fs[\\/]service\.ts$/ }, () => ({
        contents: 'export const folderAccessService = globalThis.testFolderService;', loader: 'js',
      }));
    } }],
  });
  type Listener = (msg: unknown, sender: unknown, response: (value: unknown) => void) => unknown;
  let listener: Listener;
  const timers: Array<() => void> = [];
  const dispatched: Array<{ tabId: number; message: { id: string } }> = [];
  runInNewContext(bundle.outputFiles[0].text, {
    testFolderService: { async restore() { return 'granted'; }, async ensureStructure() {}, root: () => directory() },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    chrome: { runtime: {
      onMessage: { addListener: (fn: Listener) => { listener = fn; } },
      async sendMessage(msg: typeof dispatched[number]) { dispatched.push(msg); return {}; },
    } },
    crypto, DOMException, console,
    setTimeout: (fn: () => void) => { timers.push(fn); },
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const send = (msg: unknown) => new Promise<unknown>(resolve => listener(msg, {}, resolve));
  await settle();
  for (const [attempt, resetCursor] of [false, true, false].entries()) {
    await send({ type: 'FOLDER_READY_OFFSCREEN', resetCursor });
    await send({ type: 'REGISTER_TAB_OFFSCREEN', role: 'orchestrator', tabId: 123, url: 'https://chatgpt.com/' });
    const command = { id: `init-${attempt}`, from: 'cli', to: 'orchestrator', type: 'COMMAND', ts: new Date().toISOString(), payload: { command: 'INIT', agent_id: 'orchestrator', args: { text: 'Hello' } } };
    files.set(commandPath, files.get(commandPath) + JSON.stringify(command) + '\n');
    for (const tick of timers.splice(0)) tick();
    await settle();
    assert.ok(dispatched.some(msg => msg.message.id === command.id && msg.tabId === 123), `INIT not delivered (resetCursor=${resetCursor})`);
    assert.equal(dispatched.length, attempt + 1, 'old commands must not be replayed');
  }
});
