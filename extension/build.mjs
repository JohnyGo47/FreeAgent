import * as esbuild from 'esbuild';

// background - service worker "type": "module" in manifest, ESM. The other three
// loaded via <script src="..."> (popup/offscreen) or as classic content
// script - they need IIFE, ESM will give "Cannot use import statement" there.
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
