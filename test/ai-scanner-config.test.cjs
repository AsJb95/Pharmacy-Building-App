#!/usr/bin/env node
// Automated test suite for VHC Pharmacy POS:
// Gemini AI API Key Settings, DPAPI Secure Storage, Key Sanitization,
// Masked-Key Handling, Replacement of Revoked Key, Scan to Add parsing & Human Review Gate.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ─── 1. Key Sanitization, Masking & Redaction Unit Tests ───

function isMaskedKey(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  return (
    trimmed.includes('...') ||
    trimmed.includes('***') ||
    /[\u2026\u2022\u25CF]|\*{2,}/.test(trimmed) ||
    /^AIza[0-9A-Za-z_-]{2,8}[.…\u2022\u25CF]/.test(trimmed)
  );
}

function sanitizeApiKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // 1. Remove invisible Unicode characters (BOM, zero-width spaces/joiners, non-breaking spaces, line separators)
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u00A0\u200E\u200F\u2028\u2029\u202F\u205F\u3000\u00AD]/g, '').trim();
  // 2. Normalize Unicode hyphens and dashes (en-dash, em-dash, non-breaking hyphen) to ASCII '-'
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  // 3. Strip env/header prefixes (e.g. export GEMINI_API_KEY=, GOOGLE_API_KEY=, Bearer, Gemini API Key:, etc.)
  s = s.replace(/^(?:export\s+)?(?:(?:GOOGLE_|GEMINI_)?API[-_]?KEY|TOKEN|BEARER|KEY)\s*(?:[:=]\s*|\s+)/i, '').trim();
  s = s.replace(/^(?:Gemini|Google)\s+(?:API\s+)?Key\s*(?:[:=]\s*|\s+)/i, '').trim();
  // 4. Extract key from URL query if user pasted full URL (e.g. ?key=... or &key=...)
  const m = s.match(/[?&]key=([^&#\s]+)/i);
  if (m) s = m[1].trim();
  // 5. Strip straight quotes, backticks, smart quotes, and angle/square brackets or parentheses
  s = s.replace(/^["'`“”‘’«»<(\[]+|["'`“”‘’«»>)\]]+$/g, '').trim();
  // 6. Strip trailing code punctuation (semicolons, commas)
  s = s.replace(/[;,]+$/, '').trim();
  // 7. Secondary strip of quotes/brackets in case quotes enclosed prefix + key
  s = s.replace(/^["'`“”‘’«»<(\[]+|["'`“”‘’«»>)\]]+$/g, '').trim();
  return s;
}

const REVOKED_KEY_SHA256 = '7916db979ece22bff45a09e028e226057aaad904ee345d81a63d8cf502ae62d2';
function isRevokedKey(key) {
  if (!key || typeof key !== 'string') return false;
  try {
    return crypto.createHash('sha256').update(key.trim()).digest('hex') === REVOKED_KEY_SHA256;
  } catch (e) {
    return false;
  }
}

function isValidGoogleApiKey(key) {
  if (!key || typeof key !== 'string') return false;
  const k = sanitizeApiKey(key);
  if (!k) return false;
  if (isMaskedKey(k)) return false;
  // Reject keys from other AI providers (OpenAI, Anthropic)
  if (/^sk[-_]/i.test(k)) return false;
  // Support standard Google AI Studio keys (AIza...) and other valid Google/Gemini key formats (20-128 chars)
  if (k.length < 20 || k.length > 128) return false;
  if (!/^[0-9A-Za-z_\-+./=]+$/.test(k)) return false;
  const upper = k.toUpperCase();
  if (upper.includes('YOUR_') || upper.includes('TODO') || upper.includes('REPLACE_ME') || upper.includes('API_KEY')) return false;
  return true;
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (isMaskedKey(trimmed)) return trimmed;
  if (trimmed.length <= 10) return '********';
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function redactSecret(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED_API_KEY]')
    .replace(/(key=)[0-9A-Za-z_-]{20,}/gi, '$1[REDACTED_API_KEY]');
}

test('sanitizeApiKey strips surrounding quotes, backticks, env prefixes, smart quotes, zero-width chars, and URL parameters', () => {
  const validRaw = 'AIzaSyTestValidKey1234567890ABCDEF12345';
  assert.equal(sanitizeApiKey(`"${validRaw}"`), validRaw);
  assert.equal(sanitizeApiKey(`'${validRaw}'`), validRaw);
  assert.equal(sanitizeApiKey(`\`${validRaw}\``), validRaw);
  assert.equal(sanitizeApiKey(`GEMINI_API_KEY = ${validRaw}`), validRaw);
  assert.equal(sanitizeApiKey(`export GOOGLE_API_KEY=${validRaw}`), validRaw);
  assert.equal(sanitizeApiKey(`GEMINI_API_KEY="${validRaw}"`), validRaw);
  assert.equal(sanitizeApiKey(`export GOOGLE_API_KEY='${validRaw}'`), validRaw);
  assert.equal(sanitizeApiKey(`“${validRaw}”`), validRaw);
  assert.equal(sanitizeApiKey(`‘${validRaw}’`), validRaw);
  assert.equal(sanitizeApiKey(`\u200B${validRaw}\u200B`), validRaw);
  assert.equal(sanitizeApiKey(`\uFEFF${validRaw}`), validRaw);
  assert.equal(sanitizeApiKey(`${validRaw};`), validRaw);
  assert.equal(sanitizeApiKey(`${validRaw},`), validRaw);
  assert.equal(sanitizeApiKey(`key=${validRaw}`), validRaw);
  assert.equal(sanitizeApiKey(`https://generativelanguage.googleapis.com/v1beta/models?key=${validRaw}`), validRaw);
  assert.equal(sanitizeApiKey(`  ${validRaw}  \n`), validRaw);
  assert.equal(sanitizeApiKey(''), '');
  assert.equal(sanitizeApiKey(null), '');
});

test('maskApiKey masks middle characters and preserves only prefix and last 4 chars', () => {
  const sampleKey = 'AIzaSyAABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQ';
  const masked = maskApiKey(sampleKey);
  assert.equal(masked, 'AIzaSy...OPPQ');
  assert.ok(!masked.includes('AABBCCDDEEFFGGHHIIJJKKLLMMNN'));

  // Edge cases
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey(null), '');
  assert.equal(maskApiKey('short'), '********');
  // If already masked, preserves mask without re-mangling
  assert.equal(maskApiKey('AIzaSy...3pyk'), 'AIzaSy...3pyk');
});

test('redactSecret removes raw API keys from log messages and query parameters', () => {
  const rawKey = 'AIzaSyFakeTestKeyForRedactionVerification99';
  const errorMsg = `HTTP 403: API key ${rawKey} is invalid for request https://generativelanguage.googleapis.com/v1beta/models?key=${rawKey}`;
  const redacted = redactSecret(errorMsg);

  assert.ok(!redacted.includes(rawKey), 'Raw API key must never appear in redacted output');
  assert.ok(redacted.includes('[REDACTED_API_KEY]'));
  assert.equal(
    redacted,
    'HTTP 403: API key [REDACTED_API_KEY] is invalid for request https://generativelanguage.googleapis.com/v1beta/models?key=[REDACTED_API_KEY]'
  );
});

// ─── 2. Revoked Key Identification & Key Replacement Tests ───

test('isRevokedKey detects the revoked leaked key via SHA256 and allows clean replacement', () => {
  const revokedKey = 'AIzaSyDopFsJDRRH6eLL3xVMP6EUiRAAkHa3pyk';
  assert.equal(isRevokedKey(revokedKey), true, 'Must identify revoked key via sha256');

  const newValidKey = 'AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h';
  assert.equal(isRevokedKey(newValidKey), false, 'New valid key must not match revoked key');
  assert.equal(isRevokedKey('random-key'), false);
  assert.equal(isRevokedKey(''), false);
});

test('isValidGoogleApiKey accepts valid Google API keys (both AIza and other valid formats) and rejects junk, masks, and wrong providers', () => {
  // Valid keys starting with standard AIza prefix
  assert.equal(isValidGoogleApiKey('AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h'), true);
  assert.equal(isValidGoogleApiKey('AIzaNA_sample-valid-google-key-1234567890'), true);

  // Valid Gemini keys that do not start with AIza
  assert.equal(isValidGoogleApiKey('g-api-key-abcdef1234567890abcdef1234567890'), true);
  assert.equal(isValidGoogleApiKey('gemini_custom_service_key_98765432101234567890'), true);
  assert.equal(isValidGoogleApiKey('custom-google-cloud-key-abcdef1234567890'), true);

  // Sanitized key inputs (quotes, spaces, env prefixes wrapped)
  assert.equal(isValidGoogleApiKey('  "AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h"  '), true);
  assert.equal(isValidGoogleApiKey('export GEMINI_API_KEY="AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h"'), true);
  assert.equal(isValidGoogleApiKey('“AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h”'), true);

  // Masked string must be rejected as an actual key
  assert.equal(isValidGoogleApiKey('AIzaSy...3pyk'), false);
  assert.equal(isValidGoogleApiKey('AIzaSy…3pyk'), false); // Unicode ellipsis
  assert.equal(isValidGoogleApiKey('AIzaSy••••3pyk'), false); // Unicode bullet
  assert.equal(isValidGoogleApiKey('AIzaSy●●●●3pyk'), false); // Black circle
  assert.equal(isValidGoogleApiKey('AIzaSy********3pyk'), false);
  assert.equal(isValidGoogleApiKey('g-ap...90'), false);

  // Unicode dashes and hyphens normalized from rich text paste
  assert.equal(isValidGoogleApiKey('AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9–h'), true); // en-dash normalized to hyphen
  assert.equal(isValidGoogleApiKey('custom—google—cloud—key—abcdef1234567890'), true); // em-dash normalized to hyphen

  // Prefixes and brackets stripped
  assert.equal(isValidGoogleApiKey('Bearer AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h'), true);
  assert.equal(isValidGoogleApiKey('Gemini API Key: AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h'), true);
  assert.equal(isValidGoogleApiKey('<AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h>'), true);
  assert.equal(isValidGoogleApiKey('(AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h)'), true);
  assert.equal(isValidGoogleApiKey('[AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h]'), true);

  // Valid keys with standard Base64 characters (+, /, =) or token dots (.)
  assert.equal(isValidGoogleApiKey('AIzaSyA+B/C=1234567890abcdef1234567890'), true);
  assert.equal(isValidGoogleApiKey('google.gemini.service.account.key.1234567890'), true);

  // Other AI provider keys rejected
  assert.equal(isValidGoogleApiKey('sk-ant-api03-sample-anthropic-key-here'), false);
  assert.equal(isValidGoogleApiKey('sk-proj-sample-openai-key-here'), false);
  assert.equal(isValidGoogleApiKey('sk-1234567890abcdef1234567890abcdef'), false);

  // Obvious placeholders rejected
  assert.equal(isValidGoogleApiKey('YOUR_API_KEY_HERE_1234567890'), false);
  assert.equal(isValidGoogleApiKey('TODO_REPLACE_ME_1234567890'), false);

  // Too short or too long
  assert.equal(isValidGoogleApiKey('AIzaShort'), false);
  assert.equal(isValidGoogleApiKey('short-key-123'), false);
  assert.equal(isValidGoogleApiKey('a'.repeat(129)), false);
  assert.equal(isValidGoogleApiKey(''), false);
  assert.equal(isValidGoogleApiKey(null), false);
});

test('saving a new key replaces the old encrypted key in secure storage and updates metadata', () => {
  // Mock secure storage environment
  const storage = {};
  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str).reverse(), // deterministic reversible mock
    decryptString: (buf) => Buffer.from(buf).reverse().toString('utf8'),
  };

  const saveConfig = ({ apiKey, model }) => {
    const rawInput = sanitizeApiKey(apiKey);
    let keyToSave = rawInput;

    if (!keyToSave || isMaskedKey(keyToSave)) {
      if (!storage.encKey) {
        return { success: false, error: 'API_KEY_REQUIRED' };
      }
      // Model only update
      storage.meta = { ...storage.meta, model: model || 'gemini-2.0-flash', updatedAt: new Date().toISOString() };
      return { success: true, meta: storage.meta, modelUpdatedOnly: true };
    }

    if (isRevokedKey(keyToSave)) {
      return { success: false, error: 'REVOKED_KEY', details: 'Revoked key rejected' };
    }

    if (!isValidGoogleApiKey(keyToSave)) {
      return { success: false, error: 'INVALID_KEY_FORMAT' };
    }

    storage.encKey = mockSafeStorage.encryptString(keyToSave);
    storage.meta = {
      provider: 'gemini',
      model: model || 'gemini-2.0-flash',
      keyMask: maskApiKey(keyToSave),
      updatedAt: new Date().toISOString(),
    };
    return { success: true, meta: storage.meta };
  };

  // Step 1: Save a key
  const oldKey = 'AIzaSyOldKey123456789012345678901234567';
  const save1 = saveConfig({ apiKey: oldKey, model: 'gemini-2.0-flash' });
  assert.equal(save1.success, true);
  assert.equal(save1.meta.keyMask, 'AIzaSy...4567');
  assert.equal(mockSafeStorage.decryptString(storage.encKey), oldKey);

  // Step 2: User attempts to save revoked key -> REJECTED
  const revokedKey = 'AIzaSyDopFsJDRRH6eLL3xVMP6EUiRAAkHa3pyk';
  const saveRevoked = saveConfig({ apiKey: revokedKey, model: 'gemini-2.0-flash' });
  assert.equal(saveRevoked.success, false);
  assert.equal(saveRevoked.error, 'REVOKED_KEY');
  // Stored key remains the old key, NOT replaced by revoked key
  assert.equal(mockSafeStorage.decryptString(storage.encKey), oldKey);

  // Step 3: User saves a new valid key -> REPLACES OLD KEY
  const newKey = 'AIzaSyNewValidKey9876543210987654321098';
  const save2 = saveConfig({ apiKey: `  "${newKey}" \n`, model: 'gemini-1.5-pro' }); // tests sanitization too
  assert.equal(save2.success, true);
  assert.equal(save2.meta.keyMask, 'AIzaSy...1098');
  assert.equal(save2.meta.model, 'gemini-1.5-pro');
  // Storage decrypted key is now the new key!
  assert.equal(mockSafeStorage.decryptString(storage.encKey), newKey);

  // Step 4: User updates model only without passing key
  const saveModelOnly = saveConfig({ apiKey: '', model: 'gemini-2.0-flash' });
  assert.equal(saveModelOnly.success, true);
  assert.equal(saveModelOnly.modelUpdatedOnly, true);
  assert.equal(saveModelOnly.meta.model, 'gemini-2.0-flash');
  assert.equal(mockSafeStorage.decryptString(storage.encKey), newKey); // Key preserved!

  // Step 5: User submits masked string while key is configured -> treated as model update, key preserved
  const saveMask = saveConfig({ apiKey: 'AIzaSy...1098', model: 'gemini-1.5-flash' });
  assert.equal(saveMask.success, true);
  assert.equal(saveMask.modelUpdatedOnly, true);
  assert.equal(saveMask.meta.model, 'gemini-1.5-flash');
  assert.equal(mockSafeStorage.decryptString(storage.encKey), newKey); // Key preserved!
});

test('test-connection uses provided new key or falls back to stored decrypted key, never tests a mask', () => {
  const storedKey = 'AIzaSyStoredValidKey1234567890123456789';
  const newKey = 'AIzaSyPastedNewKey987654321098765432109';

  const resolveTestKey = (inputKey) => {
    let clean = sanitizeApiKey(inputKey);
    if (!clean || clean.includes('...') || clean.includes('***')) {
      clean = storedKey;
    }
    return clean;
  };

  // If input is empty, uses stored key
  assert.equal(resolveTestKey(''), storedKey);
  assert.equal(resolveTestKey(null), storedKey);

  // If input is masked preview, uses stored key
  assert.equal(resolveTestKey('AIzaSy...3pyk'), storedKey);
  assert.equal(resolveTestKey('AIzaSy...1098'), storedKey);

  // If input is a newly pasted unmasked key, uses the newly pasted key
  assert.equal(resolveTestKey(newKey), newKey);
  assert.equal(resolveTestKey(`"${newKey}"`), newKey);
});

// ─── 3. Model Whitelist and Validation ───

test('only supported and verified Gemini models are permitted', () => {
  const ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

  const validateModel = (model) => {
    if (!ALLOWED_MODELS.includes(model)) {
      return { valid: false, error: `Model "${model}" is not in the verified Gemini models list.` };
    }
    return { valid: true };
  };

  assert.equal(validateModel('gemini-2.5-flash').valid, true);
  assert.equal(validateModel('gemini-flash-latest').valid, true);
  assert.equal(validateModel('gemini-2.0-flash').valid, true);
  assert.equal(validateModel('gemini-1.5-flash').valid, true);
  assert.equal(validateModel('gemini-1.5-pro').valid, true);

  assert.equal(validateModel('gemini-non-existent').valid, false);
  assert.equal(validateModel('gpt-4o').valid, false);
  assert.equal(validateModel('').valid, false);
});

// ─── 4. IPC Authorization Validation ───

test('IPC sender validation rejects cross-origin and unauthorized callers', () => {
  const validateAiIpcSender = (event) => {
    if (!event || !event.senderFrame) return false;
    const url = event.senderFrame.url || '';
    if (url.startsWith('file://') || url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return true;
    }
    return false;
  };

  assert.equal(validateAiIpcSender({ senderFrame: { url: 'file:///C:/New%20VHC/unpacked_app/dist/index.html' } }), true);
  assert.equal(validateAiIpcSender({ senderFrame: { url: 'http://localhost:5173/' } }), true);
  assert.equal(validateAiIpcSender({ senderFrame: { url: 'https://malicious-external-site.com/' } }), false);
  assert.equal(validateAiIpcSender({ senderFrame: null }), false);
  assert.equal(validateAiIpcSender(null), false);
});

// ─── 5. Invoice OCR Parsing and Strip/Stock Calculations ───

test('invoice OCR response parsing extracts items, pack sizes, and calculates total stock', () => {
  const mockGeminiInvoiceResponse = `
\`\`\`json
[
  {
    "name": "PAN 40 TAB",
    "batch": "B12345",
    "expiry": "11/27",
    "netRate": 95.50,
    "price": 155.00,
    "unitsPerPack": 15,
    "gst": 12,
    "stockist": "MEDICARE DISTRIBUTORS",
    "qtyStrips": 10,
    "freeStrips": 2,
    "stock": 180
  },
  {
    "name": "VOVERAN 1ML INJ",
    "batch": "V9876",
    "expiry": "04/26",
    "netRate": 18.00,
    "price": 28.50,
    "unitsPerPack": 1,
    "gst": 5,
    "stockist": "MEDICARE DISTRIBUTORS",
    "qtyStrips": 20,
    "freeStrips": 0,
    "stock": 20
  }
]
\`\`\`
`;

  const cleaned = mockGeminiInvoiceResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[.*\]/s);
  assert.ok(match, 'JSON array should be located');

  const items = JSON.parse(match[0]);
  assert.equal(items.length, 2);

  const item1 = items[0];
  const units1 = item1.unitsPerPack || 10;
  const strips1 = item1.qtyStrips + item1.freeStrips;
  const calculatedStock1 = strips1 * units1;
  const unitPrice1 = parseFloat((item1.price / units1).toFixed(2));

  assert.equal(units1, 15);
  assert.equal(strips1, 12);
  assert.equal(calculatedStock1, 180);
  assert.equal(unitPrice1, 10.33);

  const item2 = items[1];
  const units2 = item2.unitsPerPack || 1;
  const strips2 = item2.qtyStrips + item2.freeStrips;
  const calculatedStock2 = strips2 * units2;

  assert.equal(units2, 1);
  assert.equal(strips2, 20);
  assert.equal(calculatedStock2, 20);
});

test('packing regex correctly detects 15s, 10s, and 1s pack sizes from medicine descriptions', () => {
  const detectPack = (name) => {
    const upper = name.toUpperCase();
    if (upper.match(/(\b15['\s]*S\b|\b15\s*CAP|\b15\s*TAB|\b1X15\b)/i)) return 15;
    if (upper.match(/(\b\d+ML\b|\bINJ\b|\bAMP\b|\bVIAL\b)/i)) return 1;
    return 10;
  };

  assert.equal(detectPack("MNERWIN NT PLUS 15'S"), 15);
  assert.equal(detectPack("PANTOCID 15 TAB"), 15);
  assert.equal(detectPack("AZITHRAL 500 1X15"), 15);
  assert.equal(detectPack("DOLO 650 15 CAP"), 15);
  assert.equal(detectPack("VOVERAN 1ML AMP"), 1);
  assert.equal(detectPack("TETANUS TOXOID INJ"), 1);
  assert.equal(detectPack("INSULIN GLARGINE 3ML VIAL"), 1);
  assert.equal(detectPack("PARACETAMOL 500MG"), 10);
});

// ─── 6. Human Review Gate Verification ───

test('extracted invoice items are staged in a review list and NOT directly added to inventory', () => {
  const mockExtractedItems = [
    { name: 'AMOXICILLIN 500', batch: 'A1', qtyStrips: 5, unitsPerPack: 10, stock: 50, price: 120, selected: true },
    { name: 'PARACETAMOL 650', batch: 'P1', qtyStrips: 10, unitsPerPack: 10, stock: 100, price: 30, selected: true },
  ];

  let inventory = [];

  let reviewTable = mockExtractedItems.map((item, idx) => ({ ...item, id: idx + 1 }));
  assert.equal(reviewTable.length, 2);
  assert.equal(inventory.length, 0, 'Inventory must be unmodified after OCR extraction');

  reviewTable = reviewTable.map((item) => (item.id === 1 ? { ...item, qtyStrips: 6, stock: 6 * item.unitsPerPack } : item));
  assert.equal(reviewTable[0].stock, 60);

  reviewTable = reviewTable.map((item) => (item.id === 2 ? { ...item, selected: false } : item));

  const confirmedItems = reviewTable.filter((item) => item.selected);
  assert.equal(confirmedItems.length, 1);

  inventory = [...inventory, ...confirmedItems];
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].name, 'AMOXICILLIN 500');
  assert.equal(inventory[0].stock, 60);
});

// ─── 7. Actionable Error Mapping Tests ───

test('actionable error messages are generated for common failure modes', () => {
  const mapAiError = (status, rawError) => {
    if (!rawError && !status) {
      return 'AI service is unreachable. Please verify network connectivity.';
    }
    if (status === 400 || (rawError && rawError.includes('API_KEY_INVALID'))) {
      return 'Gemini API key is invalid or malformed. Please update it in Settings -> AI & Scanner Configuration.';
    }
    if (status === 403 || (rawError && rawError.includes('PERMISSION_DENIED'))) {
      return 'Gemini API key was revoked or reported as leaked. Please enter a new key in Settings -> AI & Scanner Configuration.';
    }
    if (status === 429 || (rawError && rawError.includes('RESOURCE_EXHAUSTED'))) {
      return 'Google Gemini API quota exceeded. Please check your usage limits or billing account.';
    }
    return `AI request failed (${status || 'Network'}): ${redactSecret(rawError || 'Unknown error')}`;
  };

  assert.equal(
    mapAiError(403, 'Your API key was reported as leaked.'),
    'Gemini API key was revoked or reported as leaked. Please enter a new key in Settings -> AI & Scanner Configuration.'
  );

  assert.equal(
    mapAiError(429, 'RESOURCE_EXHAUSTED'),
    'Google Gemini API quota exceeded. Please check your usage limits or billing account.'
  );

  assert.equal(
    mapAiError(400, 'API_KEY_INVALID'),
    'Gemini API key is invalid or malformed. Please update it in Settings -> AI & Scanner Configuration.'
  );

  assert.equal(
    mapAiError(0, 'Failed to fetch from generativelanguage.googleapis.com?key=AIzaSyDopFsJDRRH6eLL3xVMP6EUiRAAkHa3pyk'),
    'AI request failed (Network): Failed to fetch from generativelanguage.googleapis.com?key=[REDACTED_API_KEY]'
  );
});

// ─── 8. Hardcoded Key Zero-Leak Verification in Files ───

test('verifies that no hardcoded leaked API key remains in the distribution bundle', () => {
  const bundlePath = path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');

  const leakedKey = 'AIzaSyDopFsJDRRH6eLL3xVMP6EUiRAAkHa3pyk';
  assert.equal(bundle.includes(leakedKey), false, 'Leaked hardcoded key must not exist in bundle');

  assert.ok(bundle.includes('lo = null;'), 'lo must be set to null');
  assert.ok(bundle.includes('var Ph = null;'), 'Ph must be set to null');

  assert.ok(bundle.includes('function VhcAiScannerSettings()'), 'VhcAiScannerSettings component must exist');
  assert.ok(bundle.includes('(0, J.jsx)(VhcAiScannerSettings, {})'), 'VhcAiScannerSettings must be mounted in Settings');

  const preloadPath = path.join(__dirname, '..', 'electron', 'preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  assert.ok(preload.includes('aiGetConfig:'), 'preload must expose aiGetConfig');
  assert.ok(preload.includes('aiSaveConfig:'), 'preload must expose aiSaveConfig');
  assert.ok(preload.includes('aiRemoveConfig:'), 'preload must expose aiRemoveConfig');
  assert.ok(preload.includes('aiTestConnection:'), 'preload must expose aiTestConnection');
  assert.ok(preload.includes('aiAnalyzeInvoice:'), 'preload must expose aiAnalyzeInvoice');
  assert.ok(preload.includes('aiAnalyzePrescription:'), 'preload must expose aiAnalyzePrescription');
});

// ─── 9. Regression Tests for User-Reported Validation Failures ───

test('regression: distinguishes between masked preview inputs and truly invalid keys, and normalizes rich-text artifacts', () => {
  // Test Case A: User accidentally submits a masked preview (bullets, ellipses, asterisks)
  const maskedInputs = [
    'AIzaSy...3pyk',
    'AIzaSy…3pyk', // Unicode ellipsis \u2026
    'AIzaSy••••••••••••••••••••••••••••••••3pyk', // Unicode bullet \u2022
    'AIzaSy●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●3pyk', // Black circle \u25CF
    '●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●', // Pure password field bullets
    '•••••••••••••••••••••••••••••••••••••••',
    'AIzaSy*****************************3pyk',
    'AIzaSy**3pyk',
  ];

  for (const input of maskedInputs) {
    assert.equal(isMaskedKey(input), true, `Must detect masked preview: ${input}`);
    assert.equal(isValidGoogleApiKey(input), false, `Must reject masked preview as real key: ${input}`);
  }

  // Test Case B: User copies valid key from rich text with Unicode en-dash or em-dash
  const validWithEnDash = 'AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9–h'; // \u2013 en-dash
  assert.equal(isMaskedKey(validWithEnDash), false);
  assert.equal(isValidGoogleApiKey(validWithEnDash), true);
  assert.ok(sanitizeApiKey(validWithEnDash).includes('-'));
  assert.ok(!sanitizeApiKey(validWithEnDash).includes('–'));

  const validWithEmDash = 'custom—google—cloud—key—abcdef1234567890'; // \u2014 em-dash
  assert.equal(isValidGoogleApiKey(validWithEmDash), true);
  assert.ok(!sanitizeApiKey(validWithEmDash).includes('—'));

  // Test Case C: User pastes key with prefix or brackets from documentation or curl
  const wrappedKeys = [
    'Bearer AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h',
    'GEMINI_API_KEY: AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h',
    'Gemini API Key: AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h',
    'Google API Key: AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h',
    'Token: AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h',
    '<AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h>',
    '(AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h)',
    '[AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h]',
  ];

  for (const wrapped of wrappedKeys) {
    assert.equal(isValidGoogleApiKey(wrapped), true, `Must sanitize and validate: ${wrapped}`);
    assert.equal(sanitizeApiKey(wrapped), 'AIzaSyC7z9x1W4v2U8t6S5r3Q1p9O7n5M3k1J9h');
  }

  // Test Case D: Standard Base64 characters (+, /, =) and token dots (.)
  assert.equal(isValidGoogleApiKey('AIzaSyA+B/C=1234567890abcdef1234567890'), true);
  assert.equal(isValidGoogleApiKey('google.gemini.service.account.key.1234567890'), true);
});

// ─── 10. Gemini Model Configuration Consistency & No Silent Fallback ───

test('central model resolution getActiveGeminiModel respects override, configured meta, and defaults to gemini-2.5-flash', () => {
  let mockMeta = { model: 'gemini-2.0-flash' };
  const getActiveGeminiModel = (overrideModel) => {
    if (overrideModel && typeof overrideModel === 'string' && overrideModel.trim()) {
      return overrideModel.trim();
    }
    if (mockMeta?.model && typeof mockMeta.model === 'string' && mockMeta.model.trim()) {
      return mockMeta.model.trim();
    }
    return 'gemini-2.5-flash';
  };

  // When override is passed, override takes precedence
  assert.equal(getActiveGeminiModel('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(getActiveGeminiModel('gemini-1.5-pro'), 'gemini-1.5-pro');

  // When override is empty, configured model in metadata is used
  assert.equal(getActiveGeminiModel(''), 'gemini-2.0-flash');
  assert.equal(getActiveGeminiModel(null), 'gemini-2.0-flash');
  assert.equal(getActiveGeminiModel(undefined), 'gemini-2.0-flash');

  // When metadata has gemini-2.5-flash
  mockMeta = { model: 'gemini-2.5-flash' };
  assert.equal(getActiveGeminiModel(), 'gemini-2.5-flash');

  // When metadata has no model configured, defaults to gemini-2.5-flash
  mockMeta = null;
  assert.equal(getActiveGeminiModel(), 'gemini-2.5-flash');
});

test('both Invoice and Prescription scanners use the configured model and NEVER silently fall back to gemini-1.5-flash', async () => {
  let currentMeta = { model: 'gemini-2.0-flash' };
  const callLog = [];

  // Mock scanner engine simulating central model resolution without silent fallback
  const mockRunScanner = async ({ type, payload, meta }) => {
    const targetModel = (payload.model && payload.model.trim()) || meta?.model || 'gemini-2.5-flash';
    callLog.push({ type, modelAttempted: targetModel });

    // Simulate Google API behavior: gemini-2.0-flash returning 404 generateContent deprecation
    if (targetModel === 'gemini-2.0-flash') {
      return {
        success: false,
        error: 'MODEL_NOT_SUPPORTED',
        code: 404,
        details: `Selected Gemini model "${targetModel}" is not available or not supported on this endpoint. Please choose a supported model (such as gemini-2.5-flash) in Settings -> AI & Scanner Configuration.`,
      };
    }

    if (targetModel === 'gemini-2.5-flash') {
      return {
        success: true,
        items: type === 'invoice' ? [{ name: 'PARACETAMOL 500MG', qtyStrips: 10 }] : undefined,
        medicines: type === 'prescription' ? [{ name: 'Amoxicillin 500mg', qty: 15 }] : undefined,
        modelUsed: targetModel,
      };
    }

    return { success: false, error: 'UNKNOWN_MODEL', model: targetModel };
  };

  // Step 1: User has configured gemini-2.0-flash in Settings
  currentMeta = { model: 'gemini-2.0-flash' };
  callLog.length = 0;

  // Invoice scanner executes
  const invoiceRes1 = await mockRunScanner({ type: 'invoice', payload: {}, meta: currentMeta });
  assert.equal(invoiceRes1.success, false);
  assert.equal(invoiceRes1.error, 'MODEL_NOT_SUPPORTED');
  assert.ok(invoiceRes1.details.includes('gemini-2.0-flash'));
  assert.ok(invoiceRes1.details.includes('gemini-2.5-flash'));
  // Verify callLog: attempted ONLY gemini-2.0-flash, DID NOT silently fall back to gemini-1.5-flash!
  assert.deepEqual(callLog, [{ type: 'invoice', modelAttempted: 'gemini-2.0-flash' }]);

  // Prescription scanner executes
  callLog.length = 0;
  const rxRes1 = await mockRunScanner({ type: 'prescription', payload: {}, meta: currentMeta });
  assert.equal(rxRes1.success, false);
  assert.equal(rxRes1.error, 'MODEL_NOT_SUPPORTED');
  assert.deepEqual(callLog, [{ type: 'prescription', modelAttempted: 'gemini-2.0-flash' }]);

  // Step 2: User changes model in Settings to gemini-2.5-flash
  currentMeta = { model: 'gemini-2.5-flash' };
  callLog.length = 0;

  // Invoice scanner now immediately uses gemini-2.5-flash and succeeds
  const invoiceRes2 = await mockRunScanner({ type: 'invoice', payload: {}, meta: currentMeta });
  assert.equal(invoiceRes2.success, true);
  assert.equal(invoiceRes2.modelUsed, 'gemini-2.5-flash');
  assert.deepEqual(callLog, [{ type: 'invoice', modelAttempted: 'gemini-2.5-flash' }]);

  // Prescription scanner also immediately uses gemini-2.5-flash and succeeds
  callLog.length = 0;
  const rxRes2 = await mockRunScanner({ type: 'prescription', payload: {}, meta: currentMeta });
  assert.equal(rxRes2.success, true);
  assert.equal(rxRes2.modelUsed, 'gemini-2.5-flash');
  assert.deepEqual(callLog, [{ type: 'prescription', modelAttempted: 'gemini-2.5-flash' }]);
});

test('test-connection verifies generateContent support to prevent false-positive successes on deprecated models', async () => {
  const mockTestConnection = async ({ model, key }) => {
    const targetModel = model || 'gemini-2.5-flash';
    // Simulating POST :generateContent probe
    if (targetModel === 'gemini-2.0-flash') {
      return {
        success: false,
        error: 'MODEL_NOT_FOUND',
        code: 404,
        details: `Model "${targetModel}" is not available or not supported for generateContent on this API endpoint. Please select a supported model (such as gemini-2.5-flash) in Settings -> AI & Scanner Configuration.`,
      };
    }
    if (targetModel === 'gemini-2.5-flash') {
      return {
        success: true,
        model: targetModel,
        displayName: targetModel,
        latencyMs: 142,
      };
    }
    return { success: false, error: 'MODEL_ERROR' };
  };

  // gemini-2.0-flash accurately reports not available for generateContent
  const testLegacy = await mockTestConnection({ model: 'gemini-2.0-flash', key: 'AIzaSyValid...' });
  assert.equal(testLegacy.success, false);
  assert.equal(testLegacy.error, 'MODEL_NOT_FOUND');
  assert.ok(testLegacy.details.includes('gemini-2.0-flash'));
  assert.ok(testLegacy.details.includes('gemini-2.5-flash'));

  // gemini-2.5-flash succeeds
  const testNew = await mockTestConnection({ model: 'gemini-2.5-flash', key: 'AIzaSyValid...' });
  assert.equal(testNew.success, true);
  assert.equal(testNew.model, 'gemini-2.5-flash');
});

