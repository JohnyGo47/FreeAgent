import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manifest.json is valid MV3: required permissions and entry points', async () => {
  const raw = await readFile(new URL('./manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'FreeAgent');
  for (const perm of ['tabs', 'scripting', 'alarms', 'storage', 'offscreen', 'activeTab']) {
    assert.ok(manifest.permissions.includes(perm), `missing permission: ${perm}`);
  }
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.content_scripts[0].js[0], 'content.js');
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
});
