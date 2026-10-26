'use strict';
// Fractional stock in displayed quantities and values (no network, no database).
// A stock correction can leave a batch at e.g. 20.5 units. The inventory row, dashboard valuation, admin stock
// valuation, low-stock widgets/lists, expiry list and a medicine's batch total used parseInt(stock) and showed
// 20 units / Rs 200.00 instead of 20.5 units / Rs 205.00. The real expressions are extracted from the shipped
// bundle (dist/assets/index-doBKNLAj.js) and executed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8').replace(/\r\n/g, '\n');
const money = (v) => '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function rowCalc() {
  // let t = parseFloat(e.unitsPerPack || e.units_per_pack) || 10, n = ..., r = ..., i = (...stock...) * n;
  const m = src.match(/w\.map\(\(e\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*(let t =\s*parseFloat\(e\.unitsPerPack \|\| e\.units_per_pack\) \|\| 10,[\s\S]*?i = [^;]*;)/);
  assert.ok(m, 'inventory row calculation not found');
  return new Function('e', `${m[1]} return { value: i, strips: r };`);
}
function reducer(re, name) {
  const m = src.match(re);
  assert.ok(m, name + ' not found');
  return new Function(`return (${m[0]});`)();
}
const adminValuation = () => reducer(/\(acc, t\) => \{\s*let n = parseFloat\(t\.unitsPerPack \|\| t\.units_per_pack\) \|\| 10,[\s\S]*?return acc;\s*\}/, 'admin stock valuation');
const dashboardValuation = () => reducer(/\(e, t\) => \{\s*let n = parseFloat\(t\.unitsPerPack \|\| t\.units_per_pack\) \|\| 10,[\s\S]*?e\s*\);\s*\}/, 'dashboard valuation');

test('inventory row: 20.5 units x Rs 10 (MRP 100 / 10 per strip) displays Rs 205.00', () => {
  const f = rowCalc();
  const r = f({ stock: 20.5, mrp: 100, unitsPerPack: 10 });
  assert.equal(r.value, 205);
  assert.equal(money(r.value), '₹205.00');
  assert.equal(money(f({ stock: '20.5', mrp: '100', unitsPerPack: '10' }).value), '₹205.00', 'string values from storage');
});
test('inventory row: integer stock unchanged (20 units -> Rs 200.00; empty/invalid -> Rs 0.00)', () => {
  const f = rowCalc();
  assert.equal(money(f({ stock: 20, mrp: 100, unitsPerPack: 10 }).value), '₹200.00');
  assert.equal(money(f({ stock: '', mrp: 100, unitsPerPack: 10 }).value), '₹0.00');
  assert.equal(money(f({ stock: undefined, mrp: 100 }).value), '₹0.00');
});
for (const [name, get, init] of [['admin stock valuation', adminValuation, () => ({ totalSellingValue: 0, totalUnits: 0, totalStrips: 0 })],
  ['dashboard valuation', dashboardValuation, () => ({ totalSellingValue: 0, totalUnits: 0, totalStrips: 0 })]]) {
  test(`${name}: fractional units counted in full value and units`, () => {
    const fn = get();
    const tot = [{ stock: 20.5, mrp: 100, unitsPerPack: 10 }, { stock: 4, mrp: 50, unitsPerPack: 10 }].reduce(fn, init());
    assert.equal(tot.totalSellingValue, 225);
    assert.equal(tot.totalUnits, 24.5);
    assert.equal(Math.round(tot.totalStrips * 100) / 100, 2.45);
  });
  test(`${name}: integer stock gives the same totals as before`, () => {
    const fn = get();
    const tot = [{ stock: 20, mrp: 100, unitsPerPack: 10 }, { stock: '7', price: 70, units_per_pack: 7 }].reduce(fn, init());
    assert.equal(tot.totalSellingValue, 270);
    assert.equal(tot.totalUnits, 27);
  });
}
test('no displayed stock quantity or value uses parseInt any more (only the 4 known import/write paths remain)', () => {
  const sites = [...src.matchAll(/parseInt\(((?:[A-Za-z_$][\w$]*\.)+stock), 10\)/g)].map((m) => src.slice(0, m.index).split('\n').length);
  assert.equal(sites.length, 4, 'expected exactly the 4 import/write paths, found lines ' + sites.join(','));
  for (const line of sites) {
    const ctx = src.split('\n').slice(line - 12, line + 1).join('\n');
    assert.match(ctx, /qtyStrips|netRate: parseFloat/, 'remaining parseInt(stock) at line ' + line + ' is not an import/write mapping');
  }
  for (const expr of ['parseFloat(b.item.stock) || 0', 'qty: parseFloat(it.stock) || 0', 'qty: parseFloat(item.stock) || 0',
    'let stockVal = parseFloat(it.stock) || 0', 'e.filter((e) => (parseFloat(e.stock) || 0) < 50)', 'e.filter((e) => (parseFloat(e.stock) || 0) < 200)']) {
    assert.ok(src.includes(expr), 'missing: ' + expr);
  }
});
test('low-stock bands (thresholds 50 / 200) classify integer stock exactly as before and fractional stock sensibly', () => {
  const band = (s) => { const v = parseFloat(s) || 0; return v < 50 ? 'low' : v < 200 ? 'mid' : 'high'; };
  const old = (s) => { const v = parseInt(s, 10) || 0; return v < 50 ? 'low' : v < 200 ? 'mid' : 'high'; };
  for (const s of [0, 1, 49, 50, 199, 200, 1000, '', null, '12']) assert.equal(band(s), old(s), 'integer ' + s);
  assert.equal(band(49.5), 'low'); assert.equal(band(199.5), 'mid'); assert.equal(band(200.5), 'high');
});
