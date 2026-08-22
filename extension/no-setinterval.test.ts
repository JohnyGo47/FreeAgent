import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI-проверка из spec_ext_manifest: setInterval легален только в src/content/ (ARCHITECTURE §5).
async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

test('no setInterval outside src/content/', async () => {
  const srcDir = fileURLToPath(new URL('./src', import.meta.url));
  const files = await listTsFiles(srcDir);
  for (const file of files) {
    if (file.includes(`${join('src', 'content')}`)) continue;
    const content = await readFile(file, 'utf8');
    assert.ok(!content.includes('setInterval'), `setInterval found outside src/content/: ${file}`);
  }
});
