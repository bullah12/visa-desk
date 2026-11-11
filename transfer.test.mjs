import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspace, mergeWorkspaces } from './transfer.mjs';
import { encryptBackup, decryptBackup } from './crypto.mjs';

const image = { name: 'test.png', data: 'data:image/png;base64,YWJj' };
const person = (id = 'one') => ({ id, fields: { first_names: 'Test', surname: 'Traveller', passport_number: 'TEST123' }, passport: image, headshot: image, preparedPhoto: image, createdAt: '2026-01-01T00:00:00Z' });
const workspace = () => ({ version: 1, defaults: { email: 'test@example.invalid' }, people: [person()], history: [{ id: 'history', submittedAt: '2026-01-01T00:00:00Z', reference: 'TEST', snapshot: person() }], unassigned: [{ ...image, id: 'photo' }] });

test('encrypted transfer preserves every collection and image across installations', async () => {
  const source = workspace();
  const encrypted = await encryptBackup(JSON.stringify({ app: 'Visa Desk', version: 1, workspace: source }), 'a local test passphrase');
  const { workspace: restored } = parseWorkspace(JSON.parse(await decryptBackup(encrypted, 'a local test passphrase')));
  assert.deepEqual(restored.people[0].fields, source.people[0].fields);
  for (const key of ['passport', 'headshot', 'preparedPhoto']) assert.equal(restored.people[0][key].data, image.data);
  assert.equal(restored.history[0].snapshot.passport.data, image.data);
  assert.equal(restored.unassigned[0].data, image.data);
  assert.deepEqual(restored.defaults, source.defaults);
});

test('merge keeps existing defaults, skips identical IDs and preserves changed copies', () => {
  const current = workspace();
  const incoming = parseWorkspace({ workspace: workspace() }).workspace;
  incoming.defaults.email = 'another@example.invalid';
  assert.equal(mergeWorkspaces(current, incoming).people.length, 1);
  incoming.people[0].fields.first_names = 'Changed';
  const merged = mergeWorkspaces(current, incoming);
  assert.equal(merged.people.length, 2);
  assert.notEqual(merged.people[0].id, merged.people[1].id);
  assert.equal(merged.people[0].fields.first_names, 'Test');
  assert.equal(merged.defaults.email, current.defaults.email);
  assert.equal(current.people.length, 1);
  assert.equal(merged.history.length, 1);
  assert.equal(merged.unassigned.length, 1);
});

test('invalid and future backups fail without changing the current workspace', () => {
  for (const bad of [null, [], {}, { version: 2, ...workspace() , version: 2 }, { ...workspace(), unassigned: {} }, { ...workspace(), people: [{ fields: { surname: {} } }] }, { ...workspace(), history: [{ snapshot: person(), submittedAt: 'invalid' }] }]) assert.throws(() => parseWorkspace(bad));
});

test('remote and SVG images are removed; duplicate IDs cannot break editor selection', () => {
  const source = workspace();
  source.people.push(person());
  source.people[0].passport = { data: 'https://example.invalid/private.png' };
  source.people[0].headshot = { data: 'data:image/svg+xml;base64,YWJj' };
  const restored = parseWorkspace(source).workspace;
  assert.equal(restored.people[0].passport, null);
  assert.equal(restored.people[0].headshot, null);
  assert.notEqual(restored.people[0].id, restored.people[1].id);
});

test('desktop batches import details with an explicit image-path warning', () => {
  const result = parseWorkspace({ applicants: [{ applicant: { first_names: 'Test', passport_image_path: 'C:/private/passport.jpg', photo_path: 'C:/private/photo.jpg', ocr_status: 'Reviewed' } }] });
  assert.equal(result.missingDesktopImages, true);
  assert.equal(result.workspace.people[0].fields.first_names, 'Test');
  assert.equal(result.workspace.people[0].passport, null);
  assert.equal(result.workspace.people[0].fields.passport_image_path, undefined);
});
