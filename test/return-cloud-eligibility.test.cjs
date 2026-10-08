#!/usr/bin/env node
// Cloud-origin Return screen line classification (v3.18.3).
//
// Production cloud bills are stored record-only: every sale_items row has affects_stock = false
// and no stock_batch_id, because stock was deducted through separate BILL stock movements. The
// Return screen used to drop such lines, so a historical bill showed "No locally available sold
// items". It must now show EVERY cloud line and enable only those the server's
// get_sale_return_eligibility marks returnable — while the LOCAL return path stays exactly as it was.
//
// Runs the real vhcCloudReturnLines extracted from the shipped bundle. Synthetic fixtures only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; }
}

const bundlePath = path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');
const start = bundle.indexOf('function vhcCloudReturnLines(');
assert.ok(start >= 0, 'vhcCloudReturnLines must exist in the bundle');
const end = bundle.indexOf('\n}', start);
// eslint-disable-next-line no-new-func
const vhcCloudReturnLines = new Function(`${bundle.slice(start, end + 2)}; return vhcCloudReturnLines;`)();

// A record-only cloud bill exactly as Cloud Sync caches it (affects_stock false, no batch id).
const cloudLines = [
  { id: 'L1', drug_name: 'Amoxicillin 500', batch_no: 'AMX1', quantity: 10, total: 100, affects_stock: false, stock_batch_id: null },
  { id: 'L2', drug_name: 'Paracetamol 650', batch_no: 'PCM9', quantity: 5, total: 25, affects_stock: false, stock_batch_id: null },
  { id: 'L3', drug_name: 'Ankle brace', category: 'Custom', batch_no: 'N/A', quantity: 1, total: 450, affects_stock: false, stock_batch_id: null },
  { id: 'L4', drug_name: 'Old batch syrup', batch_no: 'OLD1', quantity: 2, total: 80, affects_stock: false, stock_batch_id: null },
  { id: 'L5', drug_name: 'Cetirizine', batch_no: 'CTZ', quantity: 4, total: 12, affects_stock: false, stock_batch_id: null },
];
const ok = (over) => ({ status: 'OK', bill_id: 'BILL-1', lines: over });
const el = (id, status, extra = {}) => ({ sale_item_id: id, status, returnable: status === 'RETURNABLE', already_returned: 0, remaining: 0, reason: null, ...extra });
const eligibility = ok([
  el('L1', 'RETURNABLE', { remaining: 10 }),
  el('L2', 'RETURNABLE', { already_returned: 2, remaining: 3 }),
  el('L3', 'NON_STOCK', { reason: 'Custom line is not a stock item and is not returnable', remaining: 1 }),
  el('L4', 'BATCH_GONE', { reason: 'The original stock batch no longer exists', remaining: 2 }),
  el('L5', 'RETURNABLE', { already_returned: 4, remaining: 0, returnable: false }),
]);

console.log('Cloud-origin Return lines');
check('E1 record-only cloud lines are all shown (none hidden for affects_stock=false / no stock_batch_id)', () => {
  const r = vhcCloudReturnLines(cloudLines, eligibility);
  assert.deepStrictEqual(r.map((l) => l.id), ['L1', 'L2', 'L3', 'L4', 'L5']);
});
check('E2 a RETURNABLE line is enabled up to the server-reported remaining quantity', () => {
  const l = vhcCloudReturnLines(cloudLines, eligibility).find((x) => x.id === 'L1');
  assert.strictEqual(l.returnable, true); assert.strictEqual(l.remaining, 10); assert.strictEqual(l.returnReason, null);
});
check('E3 a partially returned line shows already-returned and only the remainder', () => {
  const l = vhcCloudReturnLines(cloudLines, eligibility).find((x) => x.id === 'L2');
  assert.strictEqual(l.returnable, true); assert.strictEqual(l.alreadyReturned, 2); assert.strictEqual(l.remaining, 3);
});
check('E4 a non-stock (Custom/Injection/Procedure) line is shown, disabled, with the server reason', () => {
  const l = vhcCloudReturnLines(cloudLines, eligibility).find((x) => x.id === 'L3');
  assert.strictEqual(l.returnable, false); assert.strictEqual(l.remaining, 0); assert.match(l.returnReason, /not a stock item/);
});
check('E5 an unreconstructable line (batch gone) is shown, disabled, with the server reason', () => {
  const l = vhcCloudReturnLines(cloudLines, eligibility).find((x) => x.id === 'L4');
  assert.strictEqual(l.returnable, false); assert.match(l.returnReason, /no longer exists/); assert.strictEqual(l.returnStatus, 'BATCH_GONE');
});
check('E6 a fully returned line says so and is disabled', () => {
  const l = vhcCloudReturnLines(cloudLines, eligibility).find((x) => x.id === 'L5');
  assert.strictEqual(l.returnable, false); assert.strictEqual(l.returnReason, 'Already fully returned.');
});
check('E7 while eligibility is loading every line is visible but disabled', () => {
  const r = vhcCloudReturnLines(cloudLines, null);
  assert.strictEqual(r.length, 5); assert.ok(r.every((l) => !l.returnable && /Checking/.test(l.returnReason)));
});
for (const [status, re] of [['RPC_MISSING', /not enabled/], ['NOT_FOUND', /no longer exists in the cloud/], ['PAYMENT_STATE_UNKNOWN', /refund vs credit/], ['ERROR', /Could not check/]]) {
  check(`E8 bill-level ${status} disables every line with a clear reason`, () => {
    const r = vhcCloudReturnLines(cloudLines, { status, lines: status === 'PAYMENT_STATE_UNKNOWN' ? eligibility.lines.map((l) => ({ ...l, returnable: false })) : [], error: 'boom' });
    assert.strictEqual(r.length, 5); assert.ok(r.every((l) => !l.returnable && l.remaining === 0 && re.test(l.returnReason)));
  });
}
check('E9 a line the server does not know is disabled, never guessed returnable', () => {
  const r = vhcCloudReturnLines([...cloudLines, { id: 'LX', drug_name: 'Ghost', quantity: 1, total: 1 }], eligibility).find((l) => l.id === 'LX');
  assert.strictEqual(r.returnable, false); assert.match(r.returnReason, /not found on the cloud bill/);
});
check('E10 server ids are matched as strings and zero-quantity lines are dropped', () => {
  const r = vhcCloudReturnLines([{ id: 7, drug_name: 'N', quantity: 1, total: 1 }, { id: 'Z', quantity: 0 }], ok([el('7', 'RETURNABLE', { remaining: 1 })]));
  assert.deepStrictEqual(r.map((l) => [l.id, l.returnable]), [['7', true]]);
});

console.log('Bundle wiring');
check('W1 the LOCAL line expression is unchanged (still filters non-stock lines, no eligibility call)', () => {
  assert.ok(bundle.includes("lines = origin === `cloud` ? vhcCloudReturnLines(rawLines, eligibility) : rawLines.map((line) => ({ ...line, id: line.id || line.sale_item_id || line.server_id, drug_name: line.drug_name || line.name || line.item_name || `Item`, quantity: Number(line.quantity ?? line.qty ?? 0), total: Number(line.total ?? line.amount ?? line.line_total ?? 0), affects_stock: line.affects_stock === false || line.affects_stock === 0 ? 0 : 1 })).filter((line) => line.affects_stock !== 0 && line.quantity > 0)"));
  assert.ok(bundle.includes('let result = await window.electronAPI.createLocalSaleReturn({ id: `RET-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, billId: bill.billId, items: lines });'));
});
check('W2 eligibility is fetched only for cloud-origin bills', () => {
  assert.ok(bundle.includes('(0, _.useEffect)(() => { if (origin !== `cloud`) return;'));
  assert.ok(bundle.includes('window.VHC_CLOUD.getSaleReturnEligibility(billKey)'));
});
check('W3 cloud submit refuses non-returnable or over-remaining selections before any call', () => {
  assert.ok(bundle.includes('returnLinesById = new Map(lines.map((line) => [String(line.id), line]))'), 'display lines are indexed in render scope');
  assert.ok(bundle.includes('if (origin === `cloud` && selected.some(([id]) => { let line = returnLinesById.get(String(id)); return !line || !line.returnable || Number(quantities[id]) > Number(line.remaining); }))'));
  // Regression (found in v3.19.0 GUI QA): inside submit() a local `lines` (the RPC payload) shadows the
  // display lines, so the guard must never look lines up through `lines.find` there.
  const sub = bundle.slice(bundle.indexOf('let submit = async () => {'), bundle.indexOf('let submit = async () => {') + 1500);
  assert.ok(!/selected\.some\(\(\[id\]\) => \{ let line = lines\.find/.test(sub), 'guard must not read the shadowed payload lines');
});
check('W4 non-returnable rows render their reason and a disabled input', () => {
  assert.ok(bundle.includes('disabled: line.returnable === false, title: line.returnReason || undefined'));
  assert.ok(bundle.includes('line.returnReason ? (0, J.jsx)(`div`'));
});
check('W5 both cloud-sync copies define and export getSaleReturnEligibility (RPC_MISSING aware)', () => {
  for (const f of [path.join(__dirname, '..', 'cloud-src', 'vhc-cloud-sync.js'), path.join(__dirname, '..', 'dist', 'assets', 'vhc-cloud-sync.js')]) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(/async function getSaleReturnEligibility\(billId\)/.test(s), f);
    assert.ok(/rpc\(['"]get_sale_return_eligibility['"], \{ p_bill_id: billId \}\)/.test(s), f);
    assert.ok(/\n\s+getSaleReturnEligibility,/.test(s), f + ' export');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
