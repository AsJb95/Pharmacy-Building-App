#!/usr/bin/env node
// v3.19.5 Drive Backup v2 envelope: round-trip, wrong key, tamper detection, integrity, key handling.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const c = require(path.join(__dirname, '..', 'electron', 'vhc-backup-crypto.cjs'));

const KEY = c.generateRecoveryKey();
const SAMPLE = JSON.stringify({ appName: 'VHC Pharmacy POS', salesHistory: [{ billId: 'B-1', total: 120 }], inventory: [{ name: 'Paracetamol 500', stock: 40 }] });

test('recovery key is 64 hex, normalizes display form, rejects junk', () => {
  assert.match(KEY, /^[0-9a-f]{64}$/);
  const shown = c.formatRecoveryKey(KEY);
  assert.equal(shown.split(' ').length, 16);
  assert.equal(c.normalizeRecoveryKey(shown.toUpperCase().replace(/ /g, ' - ')), KEY);
  for (const bad of ['', null, 'abc', KEY.slice(1), KEY + '0', 'z'.repeat(64)]) assert.equal(c.normalizeRecoveryKey(bad), null);
  assert.notEqual(c.generateRecoveryKey(), KEY);
});

test('round trip restores the exact payload and header metadata', () => {
  const { envelopeText, header, envelopeMd5 } = c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY, meta: { kind: 'daily', appVersion: '3.19.5', counts: { bills: 1 } } });
  assert.ok(!envelopeText.includes('Paracetamol'), 'payload must not be readable in the file');
  assert.equal(header.kind, 'daily');
  assert.equal(header.keyId, c.keyIdFor(KEY));
  assert.match(envelopeMd5, /^[0-9a-f]{32}$/);
  const out = c.decryptBackup({ envelopeText, recoveryKey: c.formatRecoveryKey(KEY) });
  assert.equal(out.ok, true);
  assert.equal(out.plaintext, SAMPLE);
  assert.equal(out.header.payloadSha256, c.sha256Hex(SAMPLE));
});

test('wrong key is reported as WRONG_KEY, never decrypts', () => {
  const { envelopeText } = c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY });
  const out = c.decryptBackup({ envelopeText, recoveryKey: c.generateRecoveryKey() });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'WRONG_KEY');
  assert.equal(out.plaintext, undefined);
  assert.equal(c.decryptBackup({ envelopeText, recoveryKey: 'nope' }).code, 'INVALID_KEY');
});

test('any modification of ciphertext, tag or header is detected', () => {
  const { envelopeText } = c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY, meta: { counts: { bills: 1 } } });
  const env = JSON.parse(envelopeText);
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  const variants = [
    { ...env, ciphertext: flip(env.ciphertext) },
    { ...env, tag: flip(env.tag) },
    { ...env, createdAt: '2020-01-01T00:00:00.000Z' },
    { ...env, counts: { bills: 999 } },
    { ...env, kind: 'daily' },
  ];
  for (const v of variants) {
    const out = c.decryptBackup({ envelopeText: JSON.stringify(v), recoveryKey: KEY });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'TAMPERED');
  }
  const hashEdit = c.decryptBackup({ envelopeText: JSON.stringify({ ...env, payloadSha256: 'f'.repeat(64) }), recoveryKey: KEY });
  assert.equal(hashEdit.ok, false);
});

test('non-v2 and damaged files are rejected before any key use', () => {
  assert.equal(c.readHeader('{not json').code, 'CORRUPT');
  assert.equal(c.readHeader(JSON.stringify({ appName: 'VHC Pharmacy POS', salesHistory: [] })).code, 'NOT_V2');
  const { envelopeText } = c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY });
  const env = JSON.parse(envelopeText);
  assert.equal(c.readHeader(JSON.stringify({ ...env, version: 3 })).code, 'UNSUPPORTED_VERSION');
  const { ciphertext, ...noCipher } = env;
  assert.equal(c.readHeader(JSON.stringify(noCipher)).code, 'CORRUPT');
  assert.equal(c.readHeader(envelopeText).ok, true);
});

test('each backup uses a fresh IV; canonical header is order independent', () => {
  const a = JSON.parse(c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY }).envelopeText);
  const b = JSON.parse(c.encryptBackup({ plaintext: SAMPLE, recoveryKey: KEY }).envelopeText);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(c.canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), c.canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.throws(() => c.encryptBackup({ plaintext: '', recoveryKey: KEY }), /EMPTY_PAYLOAD/);
  assert.throws(() => c.encryptBackup({ plaintext: SAMPLE, recoveryKey: 'x' }), /INVALID_KEY/);
});
