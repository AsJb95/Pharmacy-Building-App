#!/usr/bin/env node
// v3.19.5 regression: (1) ModernDashboard must call react-router's useNavigate (Ze), never the
// <Link> component (mn) as a function — `(0, mn)()` crashed the dashboard after login.
// (2) Admin access must depend ONLY on the password configured in Settings: no built-in, default,
// fallback or master password in any shipped file, and none accepted when none is configured.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const bundle = read('dist/assets/index-doBKNLAj.js');
const audit = read('dist/assets/vhc-audit-engine.js');
// The removed built-in literal, assembled so this (unshipped) test file never contains it verbatim.
const REMOVED_BUILTIN = ['vhc', '8099'].join('@');

function topLevelFunction(src, name) {
  // Top-level declarations only (column 0): minified names such as Qe/Ze are reused in nested scopes.
  const m = new RegExp(`(^|\\n)function ${name}\\(`).exec(src);
  assert.ok(m, `top-level function ${name} not found`);
  const start = m.index + m[1].length;
  const next = src.slice(start + 1).search(/\r?\n(function |var |let |const )/);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
}

test('Ze is react-router useNavigate and mn is the Link component', () => {
  assert.match(topLevelFunction(bundle, 'Qe'), /useNavigate\(\) may be used only in the context of a <Router> component/);
  assert.match(topLevelFunction(bundle, 'Ze'), /return e \? vt\(\) : Qe\(\)/);
  assert.match(bundle, /mn\.displayName = `Link`;/);
});

test('ModernDashboard uses useNavigate (Ze) and never calls Link as a function', () => {
  const dash = topLevelFunction(bundle, 'ModernDashboard');
  assert.doesNotMatch(dash, /\(0, mn\)\(/);
  assert.match(dash, /navigate = Ze\(\)/);
  assert.equal((bundle.match(/\(0, mn\)\(/g) || []).length, 0, 'no call of Link as a function anywhere');
  assert.match(bundle, /path: `\/`, element: \(0, J\.jsx\)\(ModernDashboard, \{\}\)/);
});

test('dashboard greeting is role-aware, not hard-coded Admin', () => {
  const dash = topLevelFunction(bundle, 'ModernDashboard');
  assert.doesNotMatch(dash, /greeting \+ `, Admin`/);
  assert.match(dash, /window\.VHC_CLOUD\.isPlatformAdmin\(\)/);
  assert.match(dash, /isAdmin \? `Platform Admin` : `Clinic Admin`/);
  assert.match(dash, /greeting \+ \(dashRole \? `, \$\{dashRole\}` : ``\)/);
});

test('dashboard KPI icons are glyphs (not colour codes), bill rows are styled, item count is pluralised', () => {
  const dash = topLevelFunction(bundle, 'ModernDashboard');
  const css = read('dist/assets/index-DiZjGBdb.css');
  assert.doesNotMatch(dash, /`#[0-9a-f]{6}`, `#[0-9a-f]{6}`\)/, 'no hex passed in the icon slot');
  assert.equal((dash.match(/card\(`[^`]+`, [^\n]*?, `[^`]+`, `[^#`][^`]*`, `#[0-9a-f]{6}`\)/g) || []).length, 4);
  assert.match(dash, /item\$\{n === 1 \? `` : `s`\}/);
  assert.match(css, /\.dashboard-bill-row\{display:grid;/);
  assert.match(read('cloud-src/vhc-cloud-sync.js'), /pointer-events:none;/);
  assert.match(read('dist/assets/vhc-cloud-sync.js'), /pointer-events:none;/);
});

test('dashboard shows no revenue/payment/profit panels', () => {
  const dash = topLevelFunction(bundle, 'ModernDashboard');
  for (const banned of [/Revenue/i, /Profit/i, /Payment Summary/i, /Collection/i]) assert.doesNotMatch(dash, banned);
  for (const required of ['Recent Bills', 'Expiring Soon', 'Quick Actions', 'Stock Alerts']) assert.ok(dash.includes(required), required);
});

test('no built-in admin password or fallback in any shipped file', () => {
  const shipped = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(r); }
      else if (/\.(js|cjs|mjs|html|json)$/.test(ent.name) && !/\.selftest\.js$/.test(ent.name)) shipped.push(r);
    }
  };
  ['dist', 'electron', 'public', 'telegram-bot'].forEach(walk);
  assert.ok(shipped.length > 10);
  for (const rel of shipped) {
    const src = read(rel);
    assert.ok(!src.includes(REMOVED_BUILTIN), `${rel} still contains the removed built-in password`);
    assert.doesNotMatch(src, /adminPassword\s*\|\|/, `${rel} has an adminPassword fallback`);
  }
});

function bundleAuthSandbox() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(topLevelFunction(bundle, 'vhcAdminPasswordConfigured') + '\n' + topLevelFunction(bundle, 'vhcVerifyAdminPassword') +
    '\nthis.configured = vhcAdminPasswordConfigured; this.verify = vhcVerifyAdminPassword;', ctx);
  return ctx;
}

test('bundle admin rule: only the configured password is accepted', () => {
  const { configured, verify } = bundleAuthSandbox();
  for (const settings of [{}, { adminPassword: '' }, { adminPassword: null }, null, undefined]) {
    assert.equal(configured(settings), false);
    for (const attempt of [REMOVED_BUILTIN, '', 'admin', undefined]) assert.equal(verify(settings, attempt), false);
  }
  const s = { adminPassword: 'Clinic#2026' };
  assert.equal(configured(s), true);
  assert.equal(verify(s, 'Clinic#2026'), true);
  assert.equal(verify(s, REMOVED_BUILTIN), false, 'removed built-in must not unlock a configured install');
  assert.equal(verify(s, 'clinic#2026'), false);
  assert.equal(verify(s, ''), false);
  const changed = { adminPassword: 'NewSecret9' };
  assert.equal(verify(changed, 'Clinic#2026'), false, 'old password stops working after change');
  assert.equal(verify(changed, 'NewSecret9'), true);
});

test('Backup & Restore modal and Settings unlock use the shared rule only', () => {
  const modal = topLevelFunction(bundle, 'AdminAuthModal');
  assert.match(modal, /vhcAdminPasswordConfigured\(authSettings\)/);
  assert.match(modal, /vhcVerifyAdminPassword\(authSettings, authPwd\)/);
  assert.doesNotMatch(modal, /authPwd ===/);
  const r = bundle.slice(bundle.indexOf('    R = () => {'), bundle.indexOf('    z = () => {'));
  assert.match(r, /vhcVerifyAdminPassword\(e, u\)/);
  assert.match(r, /Passwords do not match/);
  assert.doesNotMatch(r, /u ===/);
});

function auditSandbox(storageValue) {
  const fnNames = ['readConfiguredAdminPassword', 'isAdminPasswordConfigured', 'verifyAdminPin'];
  const ctx = { localStorage: { getItem: (k) => (k === 'pos_settings' ? storageValue : null) } };
  vm.createContext(ctx);
  vm.runInContext(fnNames.map((n) => topLevelFunction(audit, n)).join('\n') +
    '\nthis.verify = verifyAdminPin; this.configured = isAdminPasswordConfigured;', ctx);
  return ctx;
}

test('audit console / stock adjustment PIN: configured password only, fails closed', () => {
  for (const stored of [null, '{}', '{"adminPassword":""}', 'not-json{', '{"adminPassword":123}']) {
    const { verify, configured } = auditSandbox(stored);
    assert.equal(configured(), false, String(stored));
    assert.equal(verify(REMOVED_BUILTIN), false, `built-in accepted with pos_settings=${stored}`);
    assert.equal(verify(''), false);
  }
  const { verify, configured } = auditSandbox(JSON.stringify({ adminPassword: 'Clinic#2026', storeName: 'TEST' }));
  assert.equal(configured(), true);
  assert.equal(verify('Clinic#2026'), true);
  assert.equal(verify(REMOVED_BUILTIN), false);
  assert.equal(verify(undefined), false);
  assert.match(audit, /\n  isAdminPasswordConfigured,\n/);
});
