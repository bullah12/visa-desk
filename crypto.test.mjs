import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup } from './crypto.mjs';

test('encrypted backup survives a large round trip', async () => {
  const value = JSON.stringify({ documents: 'A'.repeat(1500000) });
  const envelope = await encryptBackup(value, 'a long private test passphrase');
  assert.equal(await decryptBackup(envelope, 'a long private test passphrase'), value);
  await assert.rejects(decryptBackup(envelope, 'the wrong passphrase'), /Incorrect passphrase/);
});
