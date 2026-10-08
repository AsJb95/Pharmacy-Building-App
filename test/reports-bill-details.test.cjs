#!/usr/bin/env node
// v3.19.0 Point 5: All Bills, Patient Name and Payments open ONE canonical Bill Details modal, and
// Return / Exchange eligibility depends only on the bill — never on which view opened it.
//
// Runs the REAL resolver / summary / opener code extracted from the shipped bundle against stubbed
// window APIs, then asserts the Reports component is wired to it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); return ['PASS', name]; }
    catch (e) { return ['FAIL', name + ' — ' + e.message]; }
  })());
}

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const a = bundle.indexOf('async function vhcResolveBillReturnSource(');
const b = bundle.indexOf('function BillDetailsModal(');
assert.ok(a > 0 && b > a, 'shared return helpers must exist in the bundle');
// eslint-disable-next-line no-new-func
const H = new Function('window', `${bundle.slice(a, b)}; return { vhcResolveBillReturnSource, vhcFetchReturnEligibility, vhcSummarizeReturnEligibility, vhcBillReturnsSummary };`);

// The Reports opener, extracted verbatim and bound to a fake bill list + setter.
const openerSrc = (() => {
  const i = bundle.indexOf('  let openBillDetails = (billOrId) => {');
  const j = bundle.indexOf('\n  };', i);
  return bundle.slice(i, j + 4);
})();
function makeOpener(n) {
  const selected = { value: undefined };
  // eslint-disable-next-line no-new-func
  const open = new Function('n', 'setSelectedPaymentBill', `${openerSrc}; return openBillDetails;`)(n, (v) => { selected.value = v; });
  return { open, selected };
}

const cloudBill = { billId: 'BILL-CLOUD-1', patientName: 'Asha', totalAmount: 120, paymentMode: 'Cash', particulars: [{ drugName: 'Amox', quantity: 2, total: 100 }, { drugName: '➕ Dressing', category: 'Custom', quantity: 1, total: 20 }] };
const localBill = { billId: 'BILL-LOCAL-1', patientName: 'Ravi', totalAmount: 50, paymentMode: 'UPI', particulars: [{ drugName: 'PCM', quantity: 5, total: 50 }] };
const bills = [cloudBill, localBill];

function fakeWindow({ localSales = {}, cloudRows = [], eligibility = {} }) {
  return {
    electronAPI: { getLocalSale: async (id) => localSales[id] || null },
    VHC_CLOUD: {
      getSalesHistory: () => cloudRows,
      fetchSalesHistory: async () => {},
      getSaleReturnEligibility: async (id) => eligibility[id] || { status: 'NOT_FOUND', lines: [] },
    },
  };
}
const cloudSale = { bill_id: 'BILL-CLOUD-1', sale_items: [{ id: 'L1', quantity: 2, total: 100, affects_stock: false }, { id: 'L2', quantity: 1, total: 20, affects_stock: false }] };
const okElig = { status: 'OK', lines: [{ sale_item_id: 'L1', status: 'RETURNABLE', returnable: true }, { sale_item_id: 'L2', status: 'NON_STOCK', returnable: false, reason: 'Custom line is not a stock item and is not returnable' }] };

// Resolve eligibility exactly as BillDetailsModal does.
async function eligibilityVia(win, bill) {
  const h = H(win);
  const src = await h.vhcResolveBillReturnSource(bill);
  return h.vhcSummarizeReturnEligibility(src.origin, src.origin === 'cloud' ? await h.vhcFetchReturnEligibility(src.billKey) : null);
}

check('22/23/24 All Bills, Patient Name and Payments open the SAME bill object for one bill', async () => {
  // All Bills / Patient Name rows pass the bill row object; Payments passes the bill id.
  const allBillsRow = { ...cloudBill }; // a row copy, as a filtered/grouped view may hold
  const r1 = makeOpener(bills); r1.open(allBillsRow);
  const r2 = makeOpener(bills); r2.open(cloudBill);
  const r3 = makeOpener(bills); r3.open('BILL-CLOUD-1');
  assert.strictEqual(r1.selected.value, cloudBill, 'All Bills resolves to the canonical list object');
  assert.strictEqual(r2.selected.value, cloudBill, 'Patient Name resolves to the canonical list object');
  assert.strictEqual(r3.selected.value, cloudBill, 'Payments resolves to the canonical list object');
  const r4 = makeOpener(bills); r4.open('BILL-NOT-THERE'); assert.strictEqual(r4.selected.value, null, 'unknown id opens nothing (as before)');
});
check('25 Return / Exchange eligibility is identical for the same bill from all three routes', async () => {
  const win = fakeWindow({ cloudRows: [cloudSale], eligibility: { 'BILL-CLOUD-1': okElig } });
  const results = [];
  for (const route of [cloudBill, { ...cloudBill }, 'BILL-CLOUD-1']) {
    const o = makeOpener(bills); o.open(route);
    results.push(await eligibilityVia(win, o.selected.value));
  }
  assert.deepStrictEqual(results[0], results[1]); assert.deepStrictEqual(results[1], results[2]);
  assert.deepStrictEqual(results[0], { returnable: true, label: '1 of 2 item lines can be returned.', reason: null });
});
check('E1 a local (this-computer) bill is returnable through the local path', async () => {
  const win = fakeWindow({ localSales: { 'BILL-LOCAL-1': { sale_items: [{ id: 'x', affects_stock: 1, quantity: 5 }] } } });
  const r = await eligibilityVia(win, localBill);
  assert.strictEqual(r.returnable, true); assert.match(r.label, /recorded on this computer/);
});
check('E2 the same non-returnable reason is shown whatever view opened the bill', async () => {
  const cases = [
    [{ status: 'RPC_MISSING', lines: [] }, /not enabled on this database yet/],
    [{ status: 'NOT_FOUND', lines: [] }, /no longer exists in the cloud/],
    [{ status: 'PAYMENT_STATE_UNKNOWN', reason: 'The split payment breakdown was not recorded for this bill', lines: [] }, /split payment breakdown was not recorded/],
    [{ status: 'ERROR', error: 'boom', lines: [] }, /Could not check.*boom/],
    [{ status: 'OK', lines: [{ status: 'BATCH_GONE', returnable: false, reason: 'The original stock batch no longer exists' }, { status: 'NON_STOCK', returnable: false, reason: 'Custom line is not a stock item and is not returnable' }] }, /No item on this bill can be returned: The original stock batch no longer exists; Custom line/],
    [{ status: 'OK', lines: [{ status: 'RETURNABLE', returnable: false }, { status: 'NON_STOCK', returnable: false, reason: 'x' }] }, /already been returned/],
  ];
  for (const [el, re] of cases) {
    const win = fakeWindow({ cloudRows: [cloudSale], eligibility: { 'BILL-CLOUD-1': el } });
    const views = [];
    for (const route of [cloudBill, { ...cloudBill }, 'BILL-CLOUD-1']) { const o = makeOpener(bills); o.open(route); views.push(await eligibilityVia(win, o.selected.value)); }
    for (const v of views) { assert.strictEqual(v.returnable, false, el.status); assert.match(v.reason, re); }
    assert.deepStrictEqual(views[0], views[2]);
  }
});
check('E3 a bill found neither locally nor in Cloud Sync is not returnable (fail closed)', async () => {
  const r = await eligibilityVia(fakeWindow({}), { billId: 'BILL-GHOST', particulars: [{ drugName: 'x', quantity: 1, total: 1 }] });
  assert.strictEqual(r.returnable, false); assert.match(r.reason, /could not be found/);
});
check('E4 Cloud Sync unavailable -> RPC_MISSING-style refusal, never an exception', async () => {
  const win = { electronAPI: { getLocalSale: async () => null }, VHC_CLOUD: { getSalesHistory: () => [cloudSale] } };
  const r = await eligibilityVia(win, cloudBill);
  assert.strictEqual(r.returnable, false); assert.match(r.reason, /not enabled/);
});
check('E5 refund / credit info for the bill comes from its own return records only', async () => {
  const h = H({});
  const recs = [
    { bill_id: 'BILL-CLOUD-1', return_amount: 30, refund_amount: 30, credit_amount: 0 },
    { bill_id: 'BILL-CLOUD-1', return_amount: 20.005, refund_amount: 0, credit_amount: 20.005 },
    { bill_id: 'BILL-OTHER', return_amount: 999, refund_amount: 999, credit_amount: 0 },
  ];
  assert.deepStrictEqual(h.vhcBillReturnsSummary(cloudBill, recs), { count: 2, returned: 50.01, refunded: 30, credited: 20.01 });
  assert.deepStrictEqual(h.vhcBillReturnsSummary(localBill, recs), { count: 0, returned: 0, refunded: 0, credited: 0 });
});
check('E6 the Return screen and Bill Details share the same resolver (origin cannot diverge)', async () => {
  const win = fakeWindow({ localSales: { 'BILL-LOCAL-1': { sale_items: [{ id: 'x', quantity: 1 }] } }, cloudRows: [cloudSale] });
  const h = H(win);
  assert.strictEqual((await h.vhcResolveBillReturnSource(localBill)).origin, 'local');
  assert.strictEqual((await h.vhcResolveBillReturnSource(cloudBill)).origin, 'cloud');
  assert.ok(bundle.includes('let source = await vhcResolveBillReturnSource(bill); if (!cancelled) { setOrigin(source.origin); setSale(source.sale); }'), 'SaleReturnModal uses it');
  assert.ok(bundle.includes('let res = await vhcFetchReturnEligibility(billKey); if (!cancelled) setEligibility(res);'), 'SaleReturnModal fetches eligibility the same way');
});

// ── wiring ──────────────────────────────────────────────────────────────────────────────────
const reports = bundle.slice(bundle.indexOf('function a_() {'), bundle.indexOf('var o_ = `/telegram-api`;'));
check('W1 all three views route through openBillDetails', async () => {
  assert.ok(reports.includes('onSelectBill: (billId) => openBillDetails(billId),'), 'Payments');
  assert.strictEqual((reports.match(/onClick: \(\) => openBillDetails\(e\),/g) || []).length, 2, 'Patient Name + All Bills');
  assert.ok(!/onClick: \(\) => d\(e\),/.test(reports), 'no row opens the bare receipt any more');
});
check('W2 exactly one Bill Details implementation is rendered (old Payment-only popup removed)', async () => {
  assert.strictEqual((reports.match(/\(0, J\.jsx\)\(BillDetailsModal, \{/g) || []).length, 1);
  assert.ok(!reports.includes('`Payment Details`'), 'the Payments-only popup is gone');
  assert.strictEqual((bundle.match(/function BillDetailsModal\(/g) || []).length, 1);
});
check('W3 Bill Details exposes receipt, settle, and Return / Exchange gated by eligibility', async () => {
  const m = bundle.slice(bundle.indexOf('function BillDetailsModal('), bundle.indexOf('function SaleReturnModal('));
  for (const s of ['`Bill Details`', '`Patient`', '`Items`', '`Payments`', '`Returns, Refunds & Credit`', '`🧾 View Receipt`', '`💳 Record Payment / Settle Credit`', '`↩ Return / Exchange`', 'disabled: !returnInfo || !returnInfo.returnable,']) assert.ok(m.includes(s), s);
  assert.ok(reports.includes('onViewReceipt: () => d(selectedPaymentBill),'));
  assert.ok(reports.includes('onReturn: () => setReturnBill(selectedPaymentBill),'));
});
check('W4 the receipt preview renders above Bill Details', async () => {
  const det = reports.indexOf('(0, J.jsx)(BillDetailsModal, {');
  const rec = reports.indexOf('(0, J.jsx)(Dh, {');
  assert.ok(det > 0 && rec > det);
});

Promise.all(pending).then((rows) => {
  for (const [st, msg] of rows) { console.log(`  ${st}  ${msg}`); st === 'PASS' ? passed++ : failed++; }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
