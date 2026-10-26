#!/usr/bin/env node
// v3.19.5 six-theme Appearance system: theme engine, legacy compatibility, no-flash bootstrap parity, CSS
// palettes + contrast, Settings preview cards (react-dom/server) and the sidebar Appearance shortcut.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const bundle = fs.readFileSync(path.join(root, 'dist/assets/index-doBKNLAj.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dist/assets/index-DiZjGBdb.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const IDS = ['system', 'modern-light', 'modern-dark', 'midnight', 'classic-light', 'high-contrast'];

const eStart = bundle.indexOf('var VHC_THEMES = [');
const eEnd = bundle.indexOf('function Lh() {');
assert.ok(eStart > 0 && eEnd > eStart);
const ENGINE = bundle.slice(eStart, eEnd);

function env({ stored = null, systemDark = false } = {}) {
  const store = new Map(stored == null ? [] : [['vhc_pos_theme', stored]]);
  const attrs = {};
  const events = [];
  let mqListener = null;
  const ctx = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) }, getElementById: () => null },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    console,
  };
  ctx.window = {
    matchMedia: () => ({ get matches() { return ctx.__dark; }, addEventListener: (_, fn) => (mqListener = fn) }),
    dispatchEvent: (e) => events.push(e),
    addEventListener() {}, removeEventListener() {},
  };
  ctx.__dark = systemDark;
  vm.createContext(ctx);
  vm.runInContext(ENGINE.replace(/function VhcThemePicker[\s\S]*$/, ''), ctx);
  return { ctx, store, attrs, events, flipSystem: (dark) => { ctx.__dark = dark; mqListener && mqListener(); } };
}

test('six themes in the required order with labels', () => {
  const { ctx } = env();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.VHC_THEMES.map((t) => t.id))), IDS);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.VHC_THEMES.map((t) => t.label))), ['System Default', 'Modern Light', 'Modern Dark', 'Midnight', 'Classic Light', 'High Contrast']);
});

test('legacy values keep the same look; unknown values fall back to Modern Light', () => {
  const { ctx } = env();
  assert.equal(ctx.vhcNormalizeThemeChoice('dark'), 'modern-dark');
  assert.equal(ctx.vhcNormalizeThemeChoice('light'), 'modern-light');
  assert.equal(ctx.vhcNormalizeThemeChoice(null), 'modern-light');
  assert.equal(ctx.vhcNormalizeThemeChoice('neon'), 'modern-light');
  assert.equal(env({ stored: 'dark' }).ctx.vhcReadTheme(), 'dark');
  assert.equal(env({ stored: 'light' }).ctx.vhcReadTheme(), 'light');
});

test('apply sets base + palette attributes, persists the choice and notifies listeners', () => {
  for (const [id, base, palette] of [['midnight', 'dark', 'midnight'], ['classic-light', 'light', 'classic-light'], ['high-contrast', 'light', 'high-contrast'], ['modern-dark', 'dark', 'modern-dark'], ['modern-light', 'light', 'modern-light']]) {
    const e = env();
    assert.equal(e.ctx.vhcApplyTheme(id), base);
    assert.equal(e.attrs['data-theme'], base);
    assert.equal(e.attrs['data-vhc-theme'], palette);
    assert.equal(e.store.get('vhc_pos_theme'), id);
    assert.equal(e.events.at(-1).detail.choice, id);
    assert.equal(e.ctx.vhcReadThemeChoice(), id, 'remembered (restart reads the same key)');
  }
});

test('System Default follows Windows and live-switches only while selected', () => {
  const e = env({ systemDark: true });
  e.ctx.vhcApplyTheme('system');
  assert.equal(e.store.get('vhc_pos_theme'), 'system');
  assert.equal(e.attrs['data-theme'], 'dark');
  assert.equal(e.attrs['data-vhc-theme'], 'modern-dark');
  e.flipSystem(false);
  assert.equal(e.attrs['data-theme'], 'light');
  assert.equal(e.attrs['data-vhc-theme'], 'modern-light');
  e.ctx.vhcApplyTheme('midnight');
  e.flipSystem(true);
  assert.equal(e.attrs['data-vhc-theme'], 'midnight', 'explicit choice is not overridden by Windows');
});

test('index.html bootstrap paints exactly what the engine resolves (no flash, every stored value)', () => {
  const script = /<script>([\s\S]*?Theme bootstrap[\s\S]*?)<\/script>/.exec(html)[1];
  for (const stored of [null, 'light', 'dark', 'garbage', ...IDS]) {
    for (const systemDark of [false, true]) {
      const attrs = {};
      const ctx = { localStorage: { getItem: () => stored }, document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } }, window: { matchMedia: () => ({ matches: systemDark }) } };
      vm.runInNewContext(script, ctx);
      const r = env({ stored, systemDark }).ctx.vhcResolveTheme(stored);
      assert.equal(attrs['data-theme'], r.base, `base for ${stored}/${systemDark}`);
      assert.equal(attrs['data-vhc-theme'], r.id, `palette for ${stored}/${systemDark}`);
    }
  }
});

function vars(id) {
  const m = new RegExp(`:root\\[data-vhc-theme="${id}"\\]\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `palette rule for ${id}`);
  return Object.fromEntries(m[1].split(';').filter(Boolean).map((d) => d.split(':').map((x) => x.trim())));
}
function lum(hex) {
  let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('new palettes override the core variables with readable contrast (HC >= 7:1)', () => {
  for (const id of ['midnight', 'classic-light', 'high-contrast']) {
    const v = vars(id);
    for (const k of ['--bg-color', '--surface', '--text-primary', '--text-secondary', '--border', '--accent']) assert.ok(v[k], `${id} ${k}`);
    assert.ok(contrast(v['--text-primary'], v['--surface']) >= 7, `${id} body text`);
    assert.ok(contrast(v['--text-secondary'], v['--surface']) >= 4.5, `${id} secondary text`);
    assert.ok(contrast('#ffffff', v['--accent']) >= 4.5 || contrast(v['--accent'], v['--surface']) >= 3, `${id} accent`);
  }
  const hc = vars('high-contrast');
  assert.ok(contrast(hc['--text-muted'], hc['--surface']) >= 7);
  assert.match(css, /:root\[data-vhc-theme="high-contrast"\] \*:focus-visible\{outline:3px solid/);
  assert.ok(css.lastIndexOf('data-vhc-theme') > css.lastIndexOf(':root[data-theme="dark"]{'), 'theme rules come after base rules');
  assert.ok(css.includes(':root[data-vhc-theme="classic-light"] body,:root[data-vhc-theme="high-contrast"] body{background-color:var(--bg-color)'), 'page background follows light palettes');
});

test('Settings shows six preview cards with exactly one active (react-dom/server)', () => {
  const React = require(path.join(root, 'node_modules/react'));
  const jsx = require(path.join(root, 'node_modules/react/jsx-runtime'));
  const { renderToStaticMarkup } = require(path.join(root, 'node_modules/react-dom/server.node.js'));
  const store = new Map([['vhc_pos_theme', 'classic-light']]);
  const ctx = { _: React, J: jsx, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, document: { documentElement: { setAttribute() {} } }, CustomEvent: class {}, console };
  vm.createContext(ctx);
  vm.runInContext(ENGINE + '\nthis.Picker = VhcThemePicker;', ctx);
  const out = renderToStaticMarkup(React.createElement(ctx.Picker));
  assert.equal((out.match(/class="vhc-theme-card( is-active)?"/g) || []).length, 6);
  assert.equal((out.match(/aria-checked="true"/g) || []).length, 1);
  assert.match(out, /data-theme-id="classic-light"[^>]*class="vhc-theme-card is-active"|class="vhc-theme-card is-active"[^>]*data-theme-id="classic-light"/);
  for (const l of ['System Default', 'Modern Light', 'Modern Dark', 'Midnight', 'Classic Light', 'High Contrast', 'Currently active']) assert.ok(out.includes(l), l);
  assert.match(bundle, /\(0, J\.jsx\)\(VhcThemePicker, \{\}\)/);
  assert.match(bundle, /className: `glass-panel mb-4 vhc-settings-appearance`,\r?\n\s+id: `vhc-appearance`,/);
  assert.doesNotMatch(bundle, /onClick: \(\) => setThemeMode\(`(light|dark)`\)/, 'old two tiles removed');
});

test('sidebar: Dark Mode toggle replaced by an Appearance shortcut to Settings', () => {
  assert.doesNotMatch(bundle, /onClick: \(\) => toggleTheme\(\)/);
  assert.doesNotMatch(bundle, /tt-track/);
  const sc = bundle.slice(bundle.indexOf('vhc-appearance-shortcut'), bundle.indexOf('vhc-appearance-shortcut') + 900);
  assert.match(sc, /window\.location\.hash = `#\/settings`/);
  assert.match(sc, /getElementById\(`vhc-appearance`\)/);
  assert.match(sc, /vhcThemeLabel\(themeChoice\)/);
  assert.match(bundle, /let \[themeMode, , toggleTheme, themeChoice\] = vhcUseTheme\(\),/);
});
