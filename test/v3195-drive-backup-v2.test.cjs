#!/usr/bin/env node
// v3.19.5 Google Drive Backup v2: scheduling, retention, integrity, encryption wiring, restore safety and the
// Settings panel. Runs the REAL renderer code (extracted from the shipped bundle) against a fake Google Drive
// and the REAL electron/vhc-backup-crypto.cjs; the panel is rendered with react-dom/server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const bundle = fs.readFileSync(path.join(root, 'dist/assets/index-doBKNLAj.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8');
const bk = require(path.join(root, 'electron/vhc-backup-crypto.cjs'));

const start = bundle.indexOf('var VHC_BACKUP_V2_FOLDER_NAME');
const end = bundle.indexOf('// v3.19.5 SECURITY: the admin password is ONLY');
assert.ok(start > 0 && end > start, 'v2 block present before the admin helpers');
const BLOCK = bundle.slice(start, end);

function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function makeDrive({ corruptMd5 = false } = {}) {
  const files = new Map();
  let n = 0;
  const calls = [];
  const md5 = (s) => crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    calls.push(`${method} ${url.split('?')[0]}`);
    const u = new URL(url);
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = /boundary=(.*)$/.exec(init.headers['Content-Type'])[1];
      const parts = init.body.split(`--${boundary}`).filter((p) => p.includes('\r\n\r\n'));
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1]);
      const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const id = 'f' + ++n;
      const f = { id, name: meta.name, parents: meta.parents, appProperties: meta.appProperties, content, size: String(Buffer.byteLength(content)), createdTime: new Date(Date.now() + n).toISOString(), md5Checksum: corruptMd5 ? '0'.repeat(32) : md5(content) };
      files.set(id, f);
      return res(200, f);
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(init.body); const id = 'dir' + ++n;
      files.set(id, { id, ...body, folder: true, createdTime: new Date().toISOString() });
      return res(200, { id });
    }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q');
      let list = [...files.values()].filter((f) => !f.trashed);
      if (q.includes("vhcBackupRoot")) list = list.filter((f) => f.folder && f.appProperties && f.appProperties.vhcBackupRoot === '1');
      else { const parent = /'([^']+)' in parents/.exec(q)[1]; list = list.filter((f) => !f.folder && f.parents.includes(parent) && f.appProperties && f.appProperties.vhcBackup === '2'); }
      return res(200, { files: list.map(({ content, ...rest }) => rest) });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'DELETE') { files.delete(m[1]); return res(204, null); }
    if (m && method === 'GET') {
      const f = files.get(m[1]);
      if (!f) return res(404, { error: { message: 'not found' } });
      return u.searchParams.get('alt') === 'media' ? res(200, f.content) : res(200, { id: f.id, trashed: false });
    }
    return res(400, { error: { message: 'unexpected ' + method + ' ' + url } });
  }
  return { fetch, files, calls };
}

function makeEnv({ key = bk.generateRecoveryKey(), drive = makeDrive(), pendingOps = [], storage = {}, signedIn = true } = {}) {
  const logs = [];
  const electronAPI = {
    googleOAuthRefresh: async () => (signedIn ? { success: true, accessToken: 'tok', expiresIn: 3600 } : { success: false, error: 'Not signed in' }),
    backupKeyStatus: async () => ({ configured: !!key, keyId: key ? bk.keyIdFor(key) : null, storageAvailable: true }),
    backupEncrypt: async (plaintext, kind, counts) => {
      const out = bk.encryptBackup({ plaintext, recoveryKey: key, meta: { kind, counts, appVersion: '3.19.5', deviceLabel: 'QA-PC' } });
      return { success: true, envelopeText: out.envelopeText, header: out.header, envelopeMd5: out.envelopeMd5 };
    },
    getUnsyncedFinancialSyncOperations: async () => pendingOps,
    getSalesHistory: async () => [{ billId: 'SQL-1', total: 50 }],
  };
  const localStorage = makeStorage({ pos_settings: JSON.stringify({ storeName: 'TEST PHARMACY', adminPassword: 'x' }), vhc_pos_sales_history: JSON.stringify([{ billId: 'LEG-1', total: 10 }]), ...storage });
  const window = {
    electronAPI,
    VHC_CLOUD: { getAllPatients: () => [{ name: 'Test Patient' }], getInventory: () => [{ name: 'Paracetamol', batch: 'B1', stock: 9 }] },
    dispatchEvent: () => true,
  };
  const ctx = {
    window, localStorage, fetch: drive.fetch, navigator: { onLine: true }, console: { warn() {}, error() {}, log() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, URL, Date, JSON, Promise, Math, Number, String, Array, Object, Error, isNaN, encodeURIComponent,
    // Real merge of legacy + SQLite bills is covered by its own tests; here it is the same contract.
    loadLocalSalesHistoryForUI: async () => [...JSON.parse(localStorage.getItem('vhc_pos_sales_history') || '[]'), ...(await electronAPI.getSalesHistory())],
  };
  vm.createContext(ctx);
  vm.runInContext(BLOCK.replace(/function VhcDriveBackupV2Panel[\s\S]*$/, ''), ctx);
  return { ctx, drive, key, logs, addLog: (a, b) => logs.push([a, b]) };
}

test('daily schedule: once per local day, 30 min back-off after a failure, can be switched off', () => {
  const { ctx } = makeEnv();
  const now = new Date('2026-10-18T10:00:00+05:30').getTime();
  assert.equal(ctx.vhcBackupDailyDue({}, now, undefined), true);
  assert.equal(ctx.vhcBackupDailyDue({ lastSuccessAt: new Date(now - 3600e3).toISOString() }, now), false);
  assert.equal(ctx.vhcBackupDailyDue({ lastSuccessAt: new Date(now - 26 * 3600e3).toISOString() }, now), true);
  assert.equal(ctx.vhcBackupDailyDue({ lastAttemptAt: new Date(now - 10 * 60e3).toISOString() }, now), false);
  assert.equal(ctx.vhcBackupDailyDue({ lastAttemptAt: new Date(now - 31 * 60e3).toISOString() }, now), true);
  assert.equal(ctx.vhcBackupDailyDue({}, now, false), false);
});

test('retention keeps newest 7 daily + 10 manual and never touches non-v2 files', () => {
  const { ctx } = makeEnv();
  const mk = (id, kind, i, v = '2') => ({ id, appProperties: { vhcBackup: v, kind, createdAt: new Date(2026, 0, i).toISOString() } });
  const files = [];
  for (let i = 1; i <= 10; i++) files.push(mk('d' + i, 'daily', i));
  for (let i = 1; i <= 12; i++) files.push(mk('m' + i, 'manual', i));
  files.push({ id: 'legacy', name: 'VHC_POS_Backup_x.json' }, mk('other', 'daily', 0, '1'));
  const del = JSON.parse(JSON.stringify(ctx.vhcBackupRetentionDeletes(files).map((f) => f.id).sort())); // vm realm -> plain array
  assert.deepEqual(del, ['d1', 'd2', 'd3', 'm1', 'm2'].sort());
});

test('Back Up Now: snapshot includes SQLite bills, file is encrypted, Drive checksum verified, status recorded', async () => {
  const env = makeEnv();
  const r = await env.ctx.vhcRunBackupV2({ kind: 'manual', addLog: env.addLog });
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.counts }, { bills: 2, inventory: 1, patients: 1 });
  const uploaded = [...env.drive.files.values()].filter((f) => !f.folder);
  assert.equal(uploaded.length, 1);
  assert.ok(!uploaded[0].content.includes('TEST PHARMACY') && !uploaded[0].content.includes('Paracetamol'), 'Drive receives ciphertext only');
  assert.equal(uploaded[0].appProperties.vhcBackup, '2');
  const dec = bk.decryptBackup({ envelopeText: uploaded[0].content, recoveryKey: env.key });
  assert.equal(dec.ok, true);
  const snap = JSON.parse(dec.plaintext);
  assert.deepEqual(snap.salesHistory.map((b) => b.billId), ['LEG-1', 'SQL-1']);
  const folder = [...env.drive.files.values()].find((f) => f.folder);
  assert.equal(folder.name, 'VHC Pharmacy POS Backups');
  const status = JSON.parse(env.ctx.localStorage.getItem('vhc_gdrive_backup_v2_status'));
  assert.equal(status.lastSuccessKind, 'manual');
  assert.equal(status.lastError, null);
  assert.equal(env.logs[0][0], 'BACKUP_GDRIVE_V2_CREATED');
  assert.equal(env.ctx.localStorage.getItem('vhc_gdrive_backup_v2_lock'), null, 'lock released');
});

test('a second backup reuses the same Drive folder (new PC finds it by appProperties)', async () => {
  const env = makeEnv();
  await env.ctx.vhcRunBackupV2({ kind: 'daily' });
  env.ctx.localStorage.removeItem('vhc_gdrive_backup_v2_folder');
  await env.ctx.vhcRunBackupV2({ kind: 'manual' });
  assert.equal([...env.drive.files.values()].filter((f) => f.folder).length, 1);
  assert.equal([...env.drive.files.values()].filter((f) => !f.folder).length, 2);
});

test('Drive checksum mismatch discards the upload and records the failure', async () => {
  const env = makeEnv({ drive: makeDrive({ corruptMd5: true }) });
  await assert.rejects(env.ctx.vhcRunBackupV2({ kind: 'manual', addLog: env.addLog }), /INTEGRITY_MISMATCH/);
  assert.equal([...env.drive.files.values()].filter((f) => !f.folder).length, 0, 'bad upload deleted');
  assert.equal(JSON.parse(env.ctx.localStorage.getItem('vhc_gdrive_backup_v2_status')).lastError, 'INTEGRITY_MISMATCH');
});

test('no key / not signed in / offline / concurrent run are refused safely', async () => {
  await assert.rejects(makeEnv({ key: null }).ctx.vhcRunBackupV2({ kind: 'daily' }), /NO_KEY/);
  await assert.rejects(makeEnv({ signedIn: false }).ctx.vhcRunBackupV2({ kind: 'daily' }), /NOT_SIGNED_IN/);
  const off = makeEnv(); off.ctx.navigator.onLine = false;
  await assert.rejects(off.ctx.vhcRunBackupV2({ kind: 'daily' }), /OFFLINE/);
  const busy = makeEnv({ storage: { vhc_gdrive_backup_v2_lock: String(Date.now()) } });
  await assert.rejects(busy.ctx.vhcRunBackupV2({ kind: 'daily' }), /BUSY/);
  const env = makeEnv();
  const p1 = env.ctx.vhcRunBackupV2({ kind: 'daily' });
  await assert.rejects(env.ctx.vhcRunBackupV2({ kind: 'daily' }), /BUSY/);
  await p1;
});

test('restore preflight blocks while any bill is waiting for cloud sync', async () => {
  const blocked = await makeEnv({ pendingOps: [{ billId: 'B9' }] }).ctx.vhcRestorePreflight();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.pending, 1);
  assert.match(blocked.message, /blocked until they finish syncing/);
  assert.equal((await makeEnv().ctx.vhcRestorePreflight()).ok, true);
});

test('restore inventory is cloud-authoritative: backup stock never overwrites a non-empty cloud', () => {
  const { ctx } = makeEnv();
  const backup = [{ name: 'A', stock: 100 }];
  assert.equal(ctx.vhcRestoreInventoryDecision([{ name: 'A', stock: 40 }], backup).action, 'keep-cloud');
  assert.equal(ctx.vhcRestoreInventoryDecision(null, backup).action, 'keep-cloud');
  assert.equal(ctx.vhcRestoreInventoryDecision([], backup).action, 'ask-load-into-empty-cloud');
  assert.equal(ctx.vhcRestoreInventoryDecision([{ name: 'A' }], []).action, 'none');
});

test('restore flow: preflight before AND after confirmation, legacy-only sales, inventory decision, no upload', () => {
  const panel = BLOCK.slice(BLOCK.indexOf('function VhcDriveBackupV2Panel'));
  const restore = panel.slice(panel.indexOf('let restoreFile = async'), panel.indexOf('let submitKey'));
  assert.equal((restore.match(/vhcRestorePreflight\(\)/g) || []).length, 2);
  assert.ok(restore.indexOf('vhcRestorePreflight()') < restore.indexOf('openBackup('), 'checked before download/decrypt');
  assert.match(restore, /vhcApplyRestoredSalesHistory\(norm\.salesHistory\)/);
  assert.match(restore, /vhcRestoreInventoryDecision\(cloudInv, norm\.inventory\)/);
  assert.doesNotMatch(restore, /createSale|applyBillStockMovement|reconcileStockMovement|adjustStockBulk|enqueue/i);
  assert.ok(restore.indexOf('restoreInventoryFromBackup') > restore.indexOf(`ask-load-into-empty-cloud`), 'cloud stock written only in the empty-cloud branch');
  assert.match(bundle, /keys: \[`vhc_pos_sales_history`\],\r?\n    applyLocal/);
  // patients are cloud-authoritative too (QA finding 2026-10-18): existing cloud patients are never rewritten
  assert.match(restore, /vhcRestoreInventoryDecision\(cloudPatients, norm\.patients\)/);
  const patBlock = restore.slice(restore.indexOf('let cloudPatients'), restore.indexOf('let cloudInv'));
  assert.ok(patBlock.indexOf('restorePatientsFromBackup') > patBlock.indexOf('ask-load-into-empty-cloud'), 'patients written only into an empty cloud');
  assert.equal((restore.match(/restorePatientsFromBackup/g) || []).length, 1);
  assert.match(restore, /Patients already in the shared cloud are kept exactly as they are/);
});

test('settings panel renders (react-dom/server) and is wired into the Drive tab; daily scheduler in the signed-in shell', () => {
  const React = require(path.join(root, 'node_modules/react'));
  const jsx = require(path.join(root, 'node_modules/react/jsx-runtime'));
  const { renderToStaticMarkup } = require(path.join(root, 'node_modules/react-dom/server.node.js'));
  const ctx = { _: React, J: jsx, window: { electronAPI: {}, addEventListener() {}, removeEventListener() {} }, localStorage: makeStorage(), console, Date, JSON, Number, String, Array, Object, Promise, URL };
  vm.createContext(ctx);
  vm.runInContext(BLOCK + '\nthis.Panel = VhcDriveBackupV2Panel;', ctx);
  const noop = () => {};
  const html = renderToStaticMarkup(React.createElement(ctx.Panel, { settings: {}, updateSettings: noop, toast: noop, confirmAsync: async () => false, addLog: noop, signedIn: false, inventoryFallback: [], beginRestore: () => true, endRestore: noop, onRestored: noop }));
  for (const text of ['Encrypted Daily Backup', 'Back Up Now', 'Automatic daily backup', 'Last successful backup', 'Never', 'Backup history', 'Sign in to Google Drive to see encrypted backups.']) assert.ok(html.includes(text), text);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Back Up Now</);
  assert.match(bundle, /\(0, J\.jsx\)\(VhcDriveBackupV2Panel, \{\r?\n\s+settings: e,/);
  const shell = bundle.slice(bundle.search(/\nfunction l_\(\)/), bundle.search(/\nfunction l_\(\)/) + 6000);
  assert.match(shell, /vhcBackupDailyDue\(vhcBackupReadStatus\(\), Date\.now\(\), settingsNow\.gdriveDailyBackupEnabled\)/);
  assert.match(shell, /vhcRunBackupV2\(\{ kind: `daily`/);
});

test('main process: key only in DPAPI (never plain text), self-check before upload, preload bridge', () => {
  assert.match(main, /function storeBackupKey[\s\S]{0,120}if \(!safeStorage\.isEncryptionAvailable\(\)\) throw new Error\('KEY_STORAGE_UNAVAILABLE'\)/);
  assert.match(main, /fs\.writeFileSync\(getBackupKeyFilePath\(\), safeStorage\.encryptString\(key\)\)/);
  assert.match(main, /Self-check before anything is uploaded/);
  assert.match(main, /if \(readStoredBackupKey\(\)\) return \{ success: false, error: 'KEY_EXISTS' \}/);
  for (const ch of ['key-status', 'create-key', 'reveal-key', 'import-key', 'encrypt', 'decrypt', 'read-header']) {
    assert.ok(main.includes(`ipcMain.handle('vhc-backup:${ch}'`), ch);
    assert.ok(preload.includes(`ipcRenderer.invoke('vhc-backup:${ch}'`), ch);
  }
});
