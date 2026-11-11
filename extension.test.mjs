import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('MV3 package exposes no website access, sync or external messaging', async () => {
  const manifest = JSON.parse(await read('./manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['unlimitedStorage']);
  for (const key of ['host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url']) assert.equal(manifest[key], undefined);
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp, /connect-src 'self' data: blob:;/);
  assert.doesNotMatch(csp, /https?:|\*/);
  for (const path of [manifest.background.service_worker, manifest.options_ui.page, ...Object.values(manifest.icons)]) await access(new URL(path, import.meta.url));
  const app = await read('./app.mjs');
  assert.match(app, /workerBlobURL: false/);
  assert.match(app, /isEvalSupported: false/);
  assert.doesNotMatch(app + await read('./storage.mjs'), /chrome\.storage\.sync/);
});
