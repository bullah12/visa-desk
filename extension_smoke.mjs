// Optional browser integration checks. Set PLAYWRIGHT_MODULE to playwright's
// index.mjs and CHROMIUM_EXECUTABLE to a Chromium build that supports loading
// unpacked extensions (branded Chrome restricts command-line side loading).
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(root, 'dist/visa-desk-extension');
const output = path.resolve(root, 'dist');
await mkdir(output, { recursive: true });
const profiles = [];
const contexts = [];
const errors = [];
const requests = [];
async function launch() {
  const profile = await mkdtemp(path.join(output, 'smoke-profile-'));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  });
  contexts.push(context);
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(worker.url().replace(/extension\/background.mjs$/, 'index.html'));
  await page.locator('#storageStatus').filter({ hasText: 'Saved on this device' }).waitFor();
  return { context, page, worker };
}
try {
  const first = await launch();
  const { page } = first;
  await page.locator('[data-action="add-person"]').first().click();
  await page.locator('[data-field="first_names"]').fill('Synthetic');
  await page.locator('[data-field="surname"]').fill('Traveller');
  await page.locator('[data-field="passport_number"]').fill('TEST0001');
  await page.locator('[data-field="surname"]').blur();
  await page.reload();
  await page.locator('#storageStatus').filter({ hasText: 'Saved on this device' }).waitFor();
  assert.equal(await page.locator('#statApplicants').textContent(), '1');
  await page.locator('#overviewCards [data-select]').first().click();
  assert.equal(await page.locator('[data-field="first_names"]').inputValue(), 'Synthetic');
  assert.equal(await page.locator('[data-field="surname"]').inputValue(), 'Traveller');
  assert.equal(await page.locator('[data-field="passport_number"]').inputValue(), 'TEST0001');
  await page.locator('.nav-link[data-view="settings"]').click();
  await page.locator('[data-default-field="email"]').fill('local@example.invalid');
  await page.locator('#saveDefaultsBtn').click();

  // Verify both worker imports and WebAssembly execution under the real MV3 CSP.
  const ocr = await page.evaluate(async () => {
    const local = value => new URL(value, location.href).href;
    const worker = await Tesseract.createWorker('eng', 1, { workerPath: local('vendor/worker.min.js'), corePath: local('vendor/tesseract-core'), langPath: local('vendor/lang'), workerBlobURL: false });
    try {
      const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 120;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1100, 120); ctx.fillStyle = '#000'; ctx.font = '60px monospace'; ctx.fillText('PASSPORT TEST 123456', 20, 80);
      return (await worker.recognize(canvas.toDataURL())).data.text;
    } finally { await worker.terminate(); }
  });
  assert.match(ocr, /PASSPORT TEST 123456/);

  const pdf = await page.evaluate(async () => {
    const lib = await import('./vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    const stream = 'BT /F1 18 Tf 10 50 Td (SYNTHETIC TEST) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let data = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((obj, i) => { offsets.push(data.length); data += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
    const xref = data.length; data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const doc = await lib.getDocument({ data: new TextEncoder().encode(data), isEvalSupported: false }).promise;
    try { const p = await doc.getPage(1); const viewport = p.getViewport({ scale: 2 }); const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height; await p.render({ canvasContext: canvas.getContext('2d'), viewport }).promise; return { pages: doc.numPages, data: canvas.toDataURL('image/png') }; }
    finally { await doc.destroy(); }
  });
  assert.equal(pdf.pages, 1);
  const portable = { version: 1, defaults: { email: 'synthetic@example.invalid' }, people: [{ id: 'portable-person', fields: { first_names: 'Portable', surname: 'Test' }, passport: { name: 'test.png', data: pdf.data }, headshot: { name: 'test.png', data: pdf.data }, preparedPhoto: { name: 'test.png', data: pdf.data } }], history: [], unassigned: [{ id: 'portable-photo', name: 'test.png', data: pdf.data }] };
  portable.history.push({ id: 'portable-history', submittedAt: '2026-11-01T12:00:00Z', reference: 'SYNTHETIC', snapshot: structuredClone(portable.people[0]) });
  await page.locator('#backupInput').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ workspace: portable })) });
  await page.locator('[data-action="import-merge"]').click();
  await page.locator('#statApplicants').filter({ hasText: '2' }).waitFor();
  await page.locator('#overviewCards [data-select="portable-person"]').click();
  await page.locator('[data-action="prepare-photo"]').click();
  await page.locator('#saveCropBtn').click();
  await page.locator('#toast').filter({ hasText: 'Prepared' }).waitFor();
  const prepared = await page.evaluate(async () => (await (await import('./storage.mjs')).loadWorkspace()).people.find(p => p.id === 'portable-person').preparedPhoto);
  assert.equal(prepared.width, 413);
  assert.equal(prepared.height, 531);
  await page.locator('#exportBackupBtn').click();
  await page.locator('#backupPass').fill('synthetic local test passphrase');
  await page.locator('#backupPassConfirm').fill('synthetic local test passphrase');
  const downloaded = page.waitForEvent('download');
  await page.locator('[data-action="create-encrypted-backup"]').click();
  const backup = await downloaded;
  const backupPath = path.join(output, 'synthetic-test-backup.encrypted.json');
  await backup.saveAs(backupPath);

  const second = await launch();
  assert.equal(await second.page.locator('#statApplicants').textContent(), '0');
  await second.page.locator('#backupInput').setInputFiles(backupPath);
  await second.page.locator('#unlockPass').fill('incorrect passphrase');
  await second.page.locator('[data-action="unlock-backup"]').click();
  await second.page.locator('#toast').filter({ hasText: 'Incorrect passphrase' }).waitFor();
  assert.equal(await second.page.locator('#statApplicants').textContent(), '0');
  await second.page.locator('#unlockPass').fill('synthetic local test passphrase');
  await second.page.locator('[data-action="unlock-backup"]').click();
  await second.page.locator('[data-action="import-replace"]').click();
  await second.page.locator('#statApplicants').filter({ hasText: '2' }).waitFor();
  const restored = await second.page.evaluate(async () => (await import('./storage.mjs')).loadWorkspace());
  assert.equal(restored.people.find(p => p.id === 'portable-person').passport.data, pdf.data);
  assert.equal(restored.unassigned.length, 1);
  assert.equal(restored.history[0].snapshot.passport.data, pdf.data);
  assert.equal(restored.defaults.email, 'local@example.invalid');
  assert.equal(restored.people.find(p => p.id === 'portable-person').preparedPhoto.data, prepared.data);
  await second.page.locator('#backupInput').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"people":{},"history":[]}') });
  await second.page.locator('#toast').filter({ hasText: 'Backup import failed' }).waitFor();
  assert.equal(await second.page.locator('#statApplicants').textContent(), '2');
  await second.page.screenshot({ path: path.join(output, 'extension-preview.png'), fullPage: true });
  await second.page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(requests, [], 'The extension must not make remote requests');
  assert.deepEqual(errors, [], 'No browser or CSP errors');
  await rm(backupPath);
  console.log('PASS: real MV3 load, adjacent form edits/reload, offline OCR, PDF worker, photo crop, import preview/merge, encrypted export, isolated profile import, wrong passphrase and invalid-file recovery, embedded images/history/defaults, responsive layout, zero remote requests or CSP errors.');
} finally {
  for (const context of contexts) await context.close();
  for (const profile of profiles) {
    if (path.dirname(profile) !== output || !path.basename(profile).startsWith('smoke-profile-')) throw new Error('Unexpected temporary profile path');
    await rm(profile, { recursive: true, force: true });
  }
}
