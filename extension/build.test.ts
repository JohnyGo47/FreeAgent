import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = fileURLToPath(new URL('.', import.meta.url));

test('esbuild builds 4 bundles, /shared is imported and inlined', async () => {
  const outdir = await mkdtemp(join(tmpdir(), 'freeagent-ext-build-'));
  try {
    await esbuild.build({
      entryPoints: [{ out: 'background', in: join(extensionDir, 'src/background/index.ts') }],
      outdir,
      bundle: true,
      format: 'esm',
      target: 'chrome121',
    });
    await esbuild.build({
      entryPoints: [
        { out: 'content', in: join(extensionDir, 'src/content/index.ts') },
        { out: 'popup', in: join(extensionDir, 'src/popup/index.ts') },
        { out: 'offscreen', in: join(extensionDir, 'src/offscreen/index.ts') },
      ],
      outdir,
      bundle: true,
      format: 'iife',
      target: 'chrome121',
    });

    for (const name of ['background', 'content', 'popup', 'offscreen']) {
      const content = await readFile(join(outdir, `${name}.js`), 'utf8');
      assert.ok(content.length > 0, `${name}.js is empty`);
      // spec_init_agent: the agent registry writes only the CLI, the extension never (ARCHITECTURE §2).
      // The file name agents_registry.json is legitimately included in the bundle as part of STRUCTURE_FILES
      // (shared/bus-structure.ts, needed to create a folder structure) - check the absence
      // the writer function itself, not the file name.
      assert.ok(!content.includes('saveRegistry'), `${name}.js must not bundle the registry writer (saveRegistry)`);
    }

    const background = await readFile(join(outdir, 'background.js'), 'utf8');
    assert.ok(!background.includes('@freeagent/shared'), 'shared import must be bundled, not left unresolved');
    assert.ok(background.includes('ensureOffscreenDocument'), 'background.js should contain bundled background code');
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
