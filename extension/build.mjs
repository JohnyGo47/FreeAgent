import * as esbuild from 'esbuild';

// background — service worker "type": "module" в manifest, ESM. Остальные три
// грузятся через <script src="..."> (popup/offscreen) или как classic content
// script — им нужен IIFE, ESM там даст "Cannot use import statement".
await esbuild.build({
  entryPoints: [{ out: 'background', in: 'src/background/index.ts' }],
  outdir: '.',
  bundle: true,
  format: 'esm',
  target: 'chrome121',
});

await esbuild.build({
  entryPoints: [
    { out: 'content', in: 'src/content/index.ts' },
    { out: 'popup', in: 'src/popup/index.ts' },
    { out: 'offscreen', in: 'src/offscreen/index.ts' },
  ],
  outdir: '.',
  bundle: true,
  format: 'iife',
  target: 'chrome121',
});
