'use strict';
// v3.19.5 Google Drive Backup v2 — encryption envelope (pure Node, no Electron imports so it is unit-testable).
//
// WhatsApp-style model: a random 256-bit RECOVERY KEY (shown to the admin as 64 hex digits) encrypts every
// backup. The key is kept on this PC with Windows DPAPI (Electron safeStorage, see main.js) so daily backups
// run unattended; on a NEW PC the admin types the recovery key to restore. Without the key a backup cannot be
// read — there is no built-in or recovery-by-vendor key.
//
// Envelope: AES-256-GCM over the backup JSON. The header (everything except ciphertext/tag) is bound as AAD,
// so editing any header field (dates, counts, keyId, hash) makes decryption fail. payloadSha256 is the SHA-256
// of the plaintext and is re-verified after decryption.
const crypto = require('crypto');

const FORMAT = 'vhc-pharmacy-backup';
const VERSION = 2;
const HKDF_SALT = Buffer.from('vhc-pharmacy-backup-v2', 'utf8');

function normalizeRecoveryKey(input) {
  const hex = String(input == null ? '' : input).replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function generateRecoveryKey() {
  return crypto.randomBytes(32).toString('hex');
}

function formatRecoveryKey(hex) {
  const k = normalizeRecoveryKey(hex);
  return k ? k.match(/.{4}/g).join(' ') : '';
}

function hkdf(keyHex, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(keyHex, 'hex'), HKDF_SALT, Buffer.from(info, 'utf8'), len));
}

function keyIdFor(recoveryKey) {
  const k = normalizeRecoveryKey(recoveryKey);
  if (!k) throw new Error('INVALID_KEY');
  return hkdf(k, 'key-id', 8).toString('hex');
}

function sha256Hex(bufOrText) {
  return crypto.createHash('sha256').update(bufOrText).digest('hex');
}

function md5Hex(bufOrText) {
  return crypto.createHash('md5').update(bufOrText).digest('hex');
}

// Stable JSON (sorted keys) so the AAD is identical on every machine.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function headerOf(env) {
  const { ciphertext, tag, ...header } = env;
  return header;
}

function encryptBackup({ plaintext, recoveryKey, meta = {} }) {
  const key = normalizeRecoveryKey(recoveryKey);
  if (!key) throw new Error('INVALID_KEY');
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('EMPTY_PAYLOAD');
  const payload = Buffer.from(plaintext, 'utf8');
  const iv = crypto.randomBytes(12);
  const header = {
    format: FORMAT,
    version: VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'HKDF-SHA256',
    keyId: keyIdFor(key),
    iv: iv.toString('base64'),
    payloadSha256: sha256Hex(payload),
    payloadBytes: payload.length,
    createdAt: meta.createdAt || new Date().toISOString(),
    appVersion: meta.appVersion || null,
    kind: meta.kind === 'daily' ? 'daily' : 'manual',
    deviceLabel: meta.deviceLabel || null,
    counts: meta.counts && typeof meta.counts === 'object' ? meta.counts : {},
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', hkdf(key, 'encryption', 32), iv);
  cipher.setAAD(Buffer.from(canonical(header), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const envelope = { ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  const envelopeText = JSON.stringify(envelope);
  return { envelopeText, header, envelopeMd5: md5Hex(Buffer.from(envelopeText, 'utf8')), envelopeSha256: sha256Hex(envelopeText) };
}

function readHeader(envelopeText) {
  let env;
  try { env = JSON.parse(envelopeText); } catch (e) { return { ok: false, code: 'CORRUPT' }; }
  if (!env || env.format !== FORMAT) return { ok: false, code: 'NOT_V2' };
  if (env.version !== VERSION) return { ok: false, code: 'UNSUPPORTED_VERSION' };
  if (typeof env.ciphertext !== 'string' || typeof env.tag !== 'string' || typeof env.iv !== 'string') return { ok: false, code: 'CORRUPT' };
  return { ok: true, header: headerOf(env), envelope: env };
}

function decryptBackup({ envelopeText, recoveryKey }) {
  const parsed = readHeader(envelopeText);
  if (!parsed.ok) return parsed;
  const key = normalizeRecoveryKey(recoveryKey);
  if (!key) return { ok: false, code: 'INVALID_KEY' };
  const env = parsed.envelope;
  if (env.keyId !== keyIdFor(key)) return { ok: false, code: 'WRONG_KEY', header: parsed.header };
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', hkdf(key, 'encryption', 32), Buffer.from(env.iv, 'base64'));
    decipher.setAAD(Buffer.from(canonical(parsed.header), 'utf8'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]);
  } catch (e) {
    return { ok: false, code: 'TAMPERED', header: parsed.header };
  }
  if (plain.length !== env.payloadBytes || sha256Hex(plain) !== env.payloadSha256) {
    return { ok: false, code: 'HASH_MISMATCH', header: parsed.header };
  }
  return { ok: true, plaintext: plain.toString('utf8'), header: parsed.header };
}

module.exports = {
  FORMAT, VERSION, normalizeRecoveryKey, generateRecoveryKey, formatRecoveryKey, keyIdFor,
  encryptBackup, decryptBackup, readHeader, sha256Hex, md5Hex, canonical,
};
