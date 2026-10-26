#!/usr/bin/env node
// v3.19.5: VHC-owned Google OAuth client (runtime-loaded, never hard-coded, NHC client refused, PKCE, drive.file
// least privilege, DPAPI-only tokens, RECONNECT_REQUIRED on expiry/revocation) and the legacy Apps Script channel
// (no hard-coded endpoint, no admin password in transit, restores keep the admin password).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('electron/main.js');
const bundle = read('dist/assets/index-doBKNLAj.js');
const engine = read('dist/assets/auto-sync-engine.js');
const NHC_CLIENT = ['193589136107', 'ijhf2q3mdrsbuaobvb7jg33vb8ooc3cv'].join('-');
const LEGACY_SCRIPT = ['AKfycbyQNSa8FMSV4RXwegDKFrUO', '6JfLLkA40N91mHR9dsd7vA9CsxYZ6KTfUrRnVLDiSpvZw'].join('-');

function shippedFiles() {
  const out = [];
  const walk = (rel) => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(r); } else if (/\.(js|cjs|mjs|html|json)$/.test(e.name)) out.push(r); } };
  ['dist', 'electron', 'public', 'telegram-bot', 'cloud-src'].forEach(walk);
  return out.concat(['package.json']);
}

test('no NHC OAuth client, no client secret and no legacy Apps Script URL in any shipped/source file', () => {
  for (const rel of shippedFiles()) {
    const s = read(rel);
    assert.ok(!s.includes(NHC_CLIENT), `${rel} contains the NHC OAuth client id`);
    assert.ok(!/GOCSPX-[A-Za-z0-9_-]{10,}/.test(s), `${rel} contains a Google client secret`);
    assert.ok(!s.includes(LEGACY_SCRIPT), `${rel} contains the hard-coded Apps Script endpoint`);
  }
  assert.doesNotMatch(main, /const GOOGLE_OAUTH_CLIENT_(ID|SECRET) = '/);
});

test('OAuth client JSON and tokens are git-ignored and never tracked', () => {
  const gi = read('.gitignore');
  assert.match(gi, /^config\/client_secret_\*\.json$/m);
  assert.match(gi, /^gdrive_oauth_token\*$/m);
  let tracked = '';
  try { tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }); } catch (e) { return; }
  assert.doesNotMatch(tracked, /client_secret|google-oauth-client|gdrive_oauth_token/);
});

test('installer bundles the local client file as a resource (not in the asar, not in Git)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.build.extraResources, [{ from: 'config', to: '.', filter: ['client_secret_vhc.json'] }]);
  assert.ok(!pkg.build.files.some((f) => /config/.test(f)), 'config/ is not packed into app.asar');
});

function oauthSandbox() {
  const start = main.indexOf('function parseGoogleOAuthClient(');
  const end = main.indexOf('let googleOAuthClientCache');
  const ctx = { FOREIGN_OAUTH_CLIENT_PREFIXES: ['193589136107-'] };
  vm.createContext(ctx);
  vm.runInContext(main.slice(start, end) + '\nthis.parse = parseGoogleOAuthClient;', ctx);
  return ctx.parse;
}

test('client file parsing: Google "installed" JSON accepted, NHC client and malformed files refused', () => {
  const parse = oauthSandbox();
  const ok = parse(JSON.stringify({ installed: { client_id: '931583938862-abc123def.apps.googleusercontent.com', client_secret: 'x-secret', redirect_uris: ['http://localhost'] } }));
  assert.equal(ok.clientId, '931583938862-abc123def.apps.googleusercontent.com');
  assert.equal(parse(JSON.stringify({ installed: { client_id: NHC_CLIENT + '.apps.googleusercontent.com', client_secret: 's' } })).error, 'FOREIGN_OAUTH_CLIENT');
  assert.equal(parse(JSON.stringify({ installed: { client_id: 'not-a-client', client_secret: 's' } })).error, 'GOOGLE_OAUTH_CLIENT_INVALID');
  assert.equal(parse(JSON.stringify({ installed: { client_id: '1-a.apps.googleusercontent.com' } })).error, 'GOOGLE_OAUTH_CLIENT_INVALID');
  assert.throws(() => parse('{not json'));
});

test('client lookup order: env override, userData, data dir, packaged resource, dev config', () => {
  const fn = main.slice(main.indexOf('function googleOAuthClientCandidates()'), main.indexOf('function parseGoogleOAuthClient('));
  const order = ['VHC_GOOGLE_OAUTH_CLIENT_FILE', "'google-oauth-client.json')", "VHC_DATA_DIR, 'google-oauth-client.json'", "process.resourcesPath, 'client_secret_vhc.json'", "'config', 'client_secret_vhc.json'"].map((k) => fn.indexOf(k));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('sign-in: least-privilege scopes, PKCE S256, state check, DPAPI-only refresh token', () => {
  assert.match(main, /const GOOGLE_OAUTH_SCOPES = 'openid email https:\/\/www\.googleapis\.com\/auth\/drive\.file';/);
  assert.doesNotMatch(main, /auth\/drive[ ']/, 'full Drive scope removed');
  assert.match(main, /code_challenge_method: 'S256'/);
  assert.match(main, /code_verifier: codeVerifier/);
  assert.match(main, /reqUrl\.searchParams\.get\('state'\) === oauthState/);
  assert.match(main, /if \(!safeStorage\.isEncryptionAvailable\(\)\) return \{ success: false, error: 'TOKEN_STORAGE_UNAVAILABLE' \}/);
  assert.match(main, /fs\.writeFileSync\(getOAuthTokenFilePath\(\), safeStorage\.encryptString\(tokenJson\.refresh_token\)\)/);
  assert.doesNotMatch(main, /Buffer\.from\(tokenJson\.refresh_token/);
  assert.match(main, /drive\.file'\)\) \{\s*finish\(\{ success: false, error: 'Google Drive permission was not granted/);
});

test('expired / revoked / foreign-client / unreadable tokens -> cleared + RECONNECT_REQUIRED', () => {
  const refresh = main.slice(main.indexOf("ipcMain.handle('google-oauth-refresh'"), main.indexOf("ipcMain.handle('google-oauth-signout'"));
  assert.match(refresh, /\['invalid_grant', 'invalid_client', 'unauthorized_client'\]\.includes\(tokenJson\.error\)\) \{\s*clearGoogleOAuthTokens\(\);\s*return \{ success: false, error: 'RECONNECT_REQUIRED' \}/);
  assert.match(refresh, /meta\.client !== client\.fingerprint\) \{ clearGoogleOAuthTokens\(\); return \{ success: false, error: 'RECONNECT_REQUIRED' \}/);
  assert.match(refresh, /catch \(e\) \{\s*clearGoogleOAuthTokens\(\);\s*return \{ success: false, error: 'RECONNECT_REQUIRED' \}/);
  assert.match(bundle, /r\.error === `RECONNECT_REQUIRED`\) \{\s*try \{ window\.dispatchEvent\(new CustomEvent\(`vhc-gdrive-reconnect`\)\)/);
  assert.match(bundle, /window\.addEventListener\(`vhc-gdrive-reconnect`, onReconnect\)/);
  assert.match(bundle, /RECONNECT_REQUIRED: `The Google Drive connection has expired or was removed/);
});

function runEngine(settings) {
  const store = new Map([['pos_settings', JSON.stringify(settings)], ['vhc_pos_sales_history', '[{"billId":"B1"}]']]);
  const uploads = [], fetches = [], local = [];
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const window = {
    electronAPI: {
      saveGDriveBackup: async (json, name) => local.push(JSON.parse(json)),
      gdriveUpload: async (url, payload) => (uploads.push({ url, payload: JSON.parse(payload.fileContent) }), { success: true }),
      gdriveFetch: async (url) => (fetches.push(url), { success: true, files: [] }),
    },
    addEventListener() {},
  };
  const ctx = { window, localStorage, navigator: { onLine: true }, console: { warn() {}, log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, document: { getElementById: () => null }, alert() {} };
  vm.createContext(ctx);
  vm.runInContext(engine, ctx);
  return { api: window.VHCAutoSync, uploads, fetches, local, store };
}

test('legacy channel: nothing is sent when no Apps Script URL is configured; settings are not seeded', async () => {
  const e = runEngine({ storeName: 'TEST', adminPassword: 'QA-Pass' });
  assert.equal(await e.api.syncNow(), false);
  await e.api.checkForNewerCloudBackup();
  assert.equal(e.uploads.length, 0);
  assert.equal(e.fetches.length, 0);
  assert.equal(JSON.parse(e.store.get('pos_settings')).gDriveScriptUrl, undefined, 'no endpoint written into settings');
  assert.equal(e.local.length, 1, 'local snapshot for the Telegram bot is still written');
  assert.equal(e.local[0].settings.adminPassword, undefined, 'local snapshot has no admin password');
});

test('legacy channel: only an explicit, valid Apps Script URL is used, and the admin password never travels', async () => {
  const url = 'https://script.google.com/macros/s/QA_TEST_DEPLOYMENT_ID_123/exec';
  const e = runEngine({ storeName: 'TEST', adminPassword: 'QA-Pass', gDriveScriptUrl: url });
  assert.equal(await e.api.syncNow(), true);
  assert.equal(e.uploads.length, 1);
  assert.equal(e.uploads[0].url, url);
  assert.equal(e.uploads[0].payload.settings.storeName, 'TEST');
  assert.equal(e.uploads[0].payload.settings.adminPassword, undefined);
  assert.equal(JSON.parse(e.store.get('pos_settings')).adminPassword, 'QA-Pass', 'the live setting itself is untouched');
  for (const bad of ['https://evil.example.com/exec', 'http://script.google.com/macros/s/x/exec', 'javascript:alert(1)']) {
    const b = runEngine({ gDriveScriptUrl: bad });
    assert.equal(await b.api.syncNow(), false, bad);
    assert.equal(b.uploads.length, 0, bad);
  }
});

test('restores never remove this PC\'s admin password (bundle normalizer + legacy engine restore)', () => {
  const fn = bundle.slice(bundle.indexOf('function vhcKeepCurrentAdminPassword('), bundle.indexOf('\n}', bundle.indexOf('function vhcKeepCurrentAdminPassword(')) + 2);
  const store = new Map([['pos_settings', JSON.stringify({ adminPassword: 'Current#1' })]]);
  const ctx = { localStorage: { getItem: (k) => store.get(k) ?? null } };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.keep = vhcKeepCurrentAdminPassword;', ctx);
  assert.equal(ctx.keep({ storeName: 'X' }).adminPassword, 'Current#1');
  assert.equal(ctx.keep({ storeName: 'X', adminPassword: 'FromBackup' }).adminPassword, 'FromBackup');
  assert.equal(ctx.keep(null), null);
  assert.match(bundle, /settings = vhcKeepCurrentAdminPassword\(settings\);\r?\n  return \{ settings, patients, inventory, salesHistory, isLegacy \};/);
  assert.match(engine, /restoredSettings = \{ \.\.\.restoredSettings, adminPassword: cur\.adminPassword \}/);
});

test('encrypted Drive backups always use the app-owned folder under drive.file', () => {
  const ensure = bundle.slice(bundle.indexOf('async function vhcDriveEnsureBackupFolder('), bundle.indexOf('async function vhcDriveListBackupsV2('));
  assert.doesNotMatch(ensure, /vhcDriveFolderFromSettings\(settings\)/);
  assert.match(ensure, /appProperties has \{ key='vhcBackupRoot' and value='1' \}/);
});
