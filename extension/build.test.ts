import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = fileURLToPath(new URL('.', import.meta.url));

test('esbuild собирает 4 бандла, /shared импортируется и инлайнится', async () => {
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
      // spec_init_agent: реестр агентов пишет только CLI, расширение — никогда (ARCHITECTURE §2).
      // Имя файла agents_registry.json легитимно попадает в бандл как часть STRUCTURE_FILES
      // (shared/bus-structure.ts, нужно для создания структуры папки) — проверяем отсутствие
      // самой функции-писателя, а не имени файла.
      assert.ok(!content.includes('saveRegistry'), `${name}.js must not bundle the registry writer (saveRegistry)`);
    }

    const background = await readFile(join(outdir, 'background.js'), 'utf8');
    assert.ok(!background.includes('@freeagent/shared'), 'shared import must be bundled, not left unresolved');
    assert.ok(background.includes('ensureOffscreenDocument'), 'background.js should contain bundled background code');
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
