const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); };
const fromBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function keyFor(passphrase, salt) {
  if (!globalThis.crypto?.subtle) throw new Error('Encrypted backups require HTTPS or localhost.');
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(value, passphrase) {
  if (passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return { format: 'visa-desk-encrypted-v1', kdf: 'PBKDF2-SHA256', iterations: 310000, cipher: 'AES-256-GCM', salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBackup(envelope, passphrase) {
  if (envelope?.format !== 'visa-desk-encrypted-v1' || envelope.iterations !== 310000 || envelope.cipher !== 'AES-256-GCM') throw new Error('Unknown encrypted backup format.');
  const key = await keyFor(passphrase, fromBase64(envelope.salt));
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.data));
    return decoder.decode(bytes);
  } catch { throw new Error('Incorrect passphrase or damaged backup.'); }
}
