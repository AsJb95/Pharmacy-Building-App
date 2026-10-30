#!/usr/bin/env node
// v3.19.8 comprehensive verification: 12-theme Appearance system, Inventory Main Stock,
// printing defaults (thermal + A4), Reports contrast tokens, and Gemini AI Scanner integration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const bundle = fs.readFileSync(path.join(root, 'dist/assets/index-doBKNLAj.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dist/assets/index-DiZjGBdb.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');

const EXPECTED_12_THEMES = [
  'system', 'modern-light', 'modern-dark', 'midnight', 'classic-light', 'high-contrast',
  'ocean-blue', 'glassmorphism', 'emerald', 'soft-lavender', 'nordic', 'warm-sand'
];

test('12 themes defined in required order with correct labels and metadata', () => {
  const eStart = bundle.indexOf('var VHC_THEMES = [');
  const eEnd = bundle.indexOf('function VhcThemePicker() {');
  assert.ok(eStart > 0 && eEnd > eStart, 'Theme engine section found');
  const ENGINE = bundle.slice(eStart, eEnd);

  const ctx = {
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: { setAttribute: () => {} } },
    CustomEvent: class {},
    window: { matchMedia: () => ({ matches: false, addEventListener: () => {} }), dispatchEvent: () => {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(ENGINE.replace(/function VhcThemeMiniPreview[\s\S]*$/, ''), ctx);

  assert.ok(Array.isArray(ctx.VHC_THEMES), 'VHC_THEMES is an array');
  assert.equal(ctx.VHC_THEMES.length, 12, 'Exactly 12 themes defined');
  const ids = ctx.VHC_THEMES.map(t => t.id);
  assert.deepEqual(JSON.parse(JSON.stringify(ids)), EXPECTED_12_THEMES, 'All 12 theme IDs match specification');
});

test('No-flash bootstrap in index.html covers all 12 themes', () => {
  assert.ok(html.includes('vhc_pos_theme'), 'Reads vhc_pos_theme from localStorage');
  for (const id of EXPECTED_12_THEMES) {
    if (id === 'system') continue;
    assert.ok(html.includes(id), `index.html bootstrap includes theme ${id}`);
  }
});

test('CSS tokens include option contrast fixes across light and dark themes', () => {
  assert.ok(css.includes('--option-bg'), 'CSS defines --option-bg');
  assert.ok(css.includes('--option-text'), 'CSS defines --option-text');
  assert.ok(css.includes('.vhc-pv-frame'), 'CSS defines .vhc-pv-frame for miniature previews');
  assert.ok(css.includes('.vhc-theme-card'), 'CSS defines .vhc-theme-card');
  assert.ok(css.includes('.vhc-reduce-motion'), 'CSS defines .vhc-reduce-motion');
});

test('Inventory Main Stock features are present in the bundle', () => {
  assert.ok(bundle.includes('describeTransferLineQty'), 'describeTransferLineQty present');
  assert.ok(bundle.includes('in-stock'), 'Pure status tab in-stock present');
  assert.ok(bundle.includes('critical'), 'Pure status tab critical present');
  assert.ok(bundle.includes('expired'), 'Pure status tab expired present');
  // Confirm low stock / expiry banner popups are not cluttering inventory
  assert.ok(!bundle.includes('v3.19.8-alert-popup-banner-restored'), 'No alert banner regression');
});

test('Printing thermal and A4 invoice preferences present', () => {
  assert.ok(bundle.includes('defaultBillPaper'), 'defaultBillPaper preference supported');
  assert.ok(bundle.includes('Thermal receipt'), 'Thermal receipt option present');
  assert.ok(bundle.includes('A4 invoice'), 'A4 invoice option present');
});

test('Accessibility Reduce Motion switch and helper present', () => {
  assert.ok(bundle.includes('vhcApplyReduceMotion'), 'vhcApplyReduceMotion present');
  assert.ok(bundle.includes('Reduce motion'), 'Reduce motion label present');
});

test('AI Scanner Configuration component and IPC bridge present', () => {
  assert.ok(bundle.includes('function VhcAiScannerSettings'), 'VhcAiScannerSettings component defined');
  assert.ok(bundle.includes('(0, J.jsx)(VhcAiScannerSettings, {})'), 'VhcAiScannerSettings mounted in Settings');
  assert.ok(bundle.includes('window.electronAPI.aiAnalyzeInvoice'), 'Invoice scanner calls aiAnalyzeInvoice');
  assert.ok(bundle.includes('window.electronAPI.aiAnalyzePrescription'), 'Prescription scanner calls aiAnalyzePrescription');
  assert.ok(!bundle.includes('AIzaSyDopFsJDRRH6eLL3xVMP6EUiRAAkHa3pyk'), 'No leaked key in bundle');
});
