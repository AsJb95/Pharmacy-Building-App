#!/usr/bin/env node
// v3.19.1: the Reports "Total Bills / Patients Billed" figure must count DISTINCT bills, never
// payment rows. A Split bill expands into one payment row per method (and credit repayments add
// rows), so on 2026-10-09 production showed 65 payment rows for 63 sales.
//
// Runs the REAL report functions extracted from the shipped bundle (bill -> payment-row expansion,
// method/status/type filters, summary, and the Reports date filter), on synthetic bills.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; }
}

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const a = bundle.indexOf('function paymentMethodLabel(');
const b = bundle.indexOf('function paymentStatusColor(');
assert.ok(a > 0 && b > a, 'report helpers must exist in the bundle');
// eslint-disable-next-line no-new-func
const R = new Function(`${bundle.slice(a, b)}; return { expandBillToPaymentTransactions, filterPaymentTransactions, computePaymentSummary, vhcDistinctBillCount, vhcBusinessDate };`)();

// The Reports date/search filter (the `D = n.filter(...)` block of the Reports component), verbatim.
const dStart = bundle.indexOf('    D = n.filter((e) => {');
const dEnd = bundle.indexOf('\n    }),', dStart);
const dSrc = bundle.slice(dStart + '    D = n.filter('.length, dEnd + '\n    }'.length);
// eslint-disable-next-line no-new-func
const makeDateFilter = new Function('vhcBusinessDate', 'f', 'm', 'g', 'y', 'x', 'C', 'o', `return ${dSrc};`);
const dateFilter = (bills, { mode, day = '', month = '', year = '', from = '', to = '', search = '' }) =>
  bills.filter(makeDateFilter(R.vhcBusinessDate, mode, day, month, year, from, to, search));

// The Billing card's figure, exactly as ReportsSummaryCards computes it.
const cardStart = bundle.indexOf('function ReportsSummaryCards(');
const cardExpr = bundle.slice(cardStart, cardStart + 800).match(/\[`Total Bills \/ Patients Billed`, ([^\]]+)\]/)[1];
// eslint-disable-next-line no-new-func
const billingCard = new Function('summary', 'transactions', 'vhcDistinctBillCount', `return ${cardExpr};`);

// ── fixtures: IST business day 2026-10-09 (UTC 2026-10-08T18:30Z .. 2026-10-09T18:29Z) ─────────
const at = (iso) => new Date(iso).toISOString();
let seq = 0;
const bill = (mode, total, breakdown, iso) => ({ billId: `BILL-T${++seq}`, date: at(iso), patientName: `P${seq}`, paymentMode: mode, totalAmount: total, paymentBreakdown: breakdown, particulars: [{ drugName: 'Med', quantity: 1, total }] });
const day = [];
for (let i = 0; i < 61; i++) {
  const mode = i % 3 === 0 ? 'Cash' : i % 3 === 1 ? 'UPI' : 'Credit';
  const amt = 100 + i;
  day.push(bill(mode, amt, mode === 'Credit' ? { credit: amt } : { [mode]: amt }, `2026-10-09T0${i % 10}:15:00+05:30`));
}
day.push(bill('Split', 300, { cash: 200, upi: 100, credit: 0 }, '2026-10-09T11:00:00+05:30'));
day.push(bill('Split', 250, { cash: 50, upi: 200, credit: 0 }, '2026-10-09T12:00:00+05:30'));
const otherDays = [bill('Cash', 999, { Cash: 999 }, '2026-10-08T23:59:00+05:30'), bill('UPI', 555, { UPI: 555 }, '2026-10-10T00:01:00+05:30')];
const all = [...day, ...otherDays];
const rowsOf = (bills) => bills.flatMap((x) => R.expandBillToPaymentTransactions(x));
const summaryOf = (bills, filters) => R.computePaymentSummary(R.filterPaymentTransactions(rowsOf(bills), filters || {}));
const sum = (arr, k) => Math.round(arr.reduce((s, x) => s + (x[k] || 0), 0) * 100) / 100;

console.log('Distinct bill count');
check('61 normal + 2 two-way Split bills => 63 bills from 65 payment rows', () => {
  const rows = rowsOf(day);
  assert.strictEqual(rows.length, 65, 'payment rows');
  const s = R.computePaymentSummary(rows);
  assert.strictEqual(s.billCount, 63);
  assert.strictEqual(billingCard(s, rows, R.vhcDistinctBillCount), 63, 'Billing card shows 63');
});
check('Billing card fallback (summary without billCount) also counts distinct bills, not rows', () => {
  const rows = rowsOf(day);
  assert.strictEqual(billingCard({}, rows, R.vhcDistinctBillCount), 63);
  assert.notStrictEqual(billingCard({}, rows, R.vhcDistinctBillCount), rows.length);
});
check('one bill with one payment row = 1 bill', () => {
  const rows = rowsOf([bill('Cash', 10, { Cash: 10 }, '2026-10-09T10:00:00+05:30')]);
  assert.strictEqual(rows.length, 1); assert.strictEqual(R.computePaymentSummary(rows).billCount, 1);
});
check('two-way Split = 1 bill; three-way split (cash+upi+card) = 1 bill', () => {
  const two = rowsOf([bill('Split', 30, { cash: 10, upi: 20, credit: 0 }, '2026-10-09T10:00:00+05:30')]);
  const three = rowsOf([bill('Split', 60, { cash: 10, upi: 20, card: 30 }, '2026-10-09T10:00:00+05:30')]);
  assert.strictEqual(two.length, 2); assert.strictEqual(R.computePaymentSummary(two).billCount, 1);
  assert.strictEqual(three.length, 3); assert.strictEqual(R.computePaymentSummary(three).billCount, 1);
});
check('credit bill + repayment rows still = 1 bill', () => {
  const c = bill('Credit', 100, { credit: 100 }, '2026-10-09T10:00:00+05:30');
  c.creditRepayments = [{ id: 'r1', amount: 40, method: 'Cash', date: at('2026-10-09T15:00:00+05:30') }];
  const rows = rowsOf([c]);
  assert.ok(rows.length >= 2, 'credit + repayment rows'); assert.strictEqual(R.computePaymentSummary(rows).billCount, 1);
});
check('rows with no billId are not counted as bills', () => {
  assert.strictEqual(R.vhcDistinctBillCount([{ billId: 'A' }, { billId: ' A ' }, { billId: '' }, { billId: null }, {}]), 1);
});

console.log('Split rows + totals preserved');
check('Split bills still expand into separate Cash and UPI rows with their own amounts', () => {
  const rows = rowsOf(day.slice(61));
  assert.deepStrictEqual(rows.map((r) => [r.billId, r.method, r.amount, r.paymentType]), [
    [day[61].billId, 'Cash', 200, 'Split'], [day[61].billId, 'UPI', 100, 'Split'],
    [day[62].billId, 'Cash', 50, 'Split'], [day[62].billId, 'UPI', 200, 'Split']]);
});
check('payment totals unchanged: per-method sums of rows; Total Billing counts each bill once', () => {
  const rows = rowsOf(day), s = R.computePaymentSummary(rows);
  const by = (m) => sum(rows.filter((r) => r.method === m), 'amount');
  assert.strictEqual(Math.round(s.cashCollection * 100) / 100, by('Cash'));
  assert.strictEqual(Math.round(s.upiCollection * 100) / 100, by('UPI'));
  assert.strictEqual(Math.round(s.outstandingTotal * 100) / 100, by('Credit'));
  assert.strictEqual(Math.round(s.totalBilling * 100) / 100, sum(day, 'totalAmount'), 'Split bill totals counted once each');
  assert.strictEqual(Math.round(s.totalCollected * 100) / 100, Math.round((s.cashCollection + s.upiCollection + s.cardCollection + s.otherCollection) * 100) / 100);
  assert.deepStrictEqual(Object.keys(s).sort(), ['billCount', 'cardCollection', 'cashCollection', 'otherCollection', 'outstandingTotal', 'totalBilling', 'totalCollected', 'upiCollection'].sort());
});

console.log('Date filters (the Reports D filter, verbatim)');
check('Today (Date Wise 2026-10-09, IST business day) => 63 bills / 65 rows; neighbours excluded', () => {
  const today = dateFilter(all, { mode: 'date', day: '2026-10-09' });
  assert.strictEqual(today.length, 63);
  const rows = rowsOf(today); assert.strictEqual(rows.length, 65);
  assert.strictEqual(R.computePaymentSummary(rows).billCount, 63);
});
check('custom range 2026-10-08..2026-10-09 => 64 bills; 2026-10-09..2026-10-10 => 64; whole range => 65', () => {
  const cnt = (from, to) => R.computePaymentSummary(rowsOf(dateFilter(all, { mode: 'custom', from, to }))).billCount;
  assert.strictEqual(cnt('2026-10-08', '2026-10-09'), 64);
  assert.strictEqual(cnt('2026-10-09', '2026-10-10'), 64);
  assert.strictEqual(cnt('2026-10-08', '2026-10-10'), 65);
  assert.strictEqual(R.computePaymentSummary(rowsOf(dateFilter(all, { mode: 'custom', from: '2026-10-08', to: '2026-10-10' }))).billCount, 65);
});
check('All Dates => every bill counted once (65 bills from 67 rows)', () => {
  const rows = rowsOf(dateFilter(all, { mode: 'all' }));
  assert.strictEqual(rows.length, 67); assert.strictEqual(R.computePaymentSummary(rows).billCount, 65);
});

console.log('Payment-method / status / type filters');
check('method=Cash counts distinct bills that have a Cash row (Split bills once each)', () => {
  const cashRows = R.filterPaymentTransactions(rowsOf(day), { method: 'cash' });
  const cashBills = new Set(day.filter((x) => x.paymentMode === 'Cash' || x.paymentMode === 'Split').map((x) => x.billId)).size;
  assert.strictEqual(R.computePaymentSummary(cashRows).billCount, cashBills);
  assert.strictEqual(cashRows.length, cashBills, 'one Cash row per such bill');
});
check('method=UPI and method=Credit counts', () => {
  assert.strictEqual(summaryOf(day, { method: 'upi' }).billCount, day.filter((x) => x.paymentMode === 'UPI' || x.paymentMode === 'Split').length);
  assert.strictEqual(summaryOf(day, { method: 'credit' }).billCount, day.filter((x) => x.paymentMode === 'Credit').length);
});
check('type=split => 2 bills from 4 rows; type=single => 61 bills', () => {
  const split = R.filterPaymentTransactions(rowsOf(day), { type: 'split' });
  assert.strictEqual(split.length, 4); assert.strictEqual(R.computePaymentSummary(split).billCount, 2);
  assert.strictEqual(summaryOf(day, { type: 'single' }).billCount, 61);
});
check('filtered totals unchanged by the fix (method filter sums only that method)', () => {
  const s = summaryOf(day, { method: 'upi' });
  assert.strictEqual(Math.round(s.upiCollection * 100) / 100, sum(R.filterPaymentTransactions(rowsOf(day), { method: 'upi' }), 'amount'));
  assert.strictEqual(s.cashCollection, 0);
});

console.log('Wiring');
check('the Billing card no longer falls back to raw transactions.length', () => {
  assert.ok(!/summary\.billCount \?\? transactions\.length/.test(bundle));
  assert.ok(bundle.includes('[`Total Bills / Patients Billed`, summary.billCount ?? vhcDistinctBillCount(transactions)]'));
  assert.ok(bundle.includes('billCount: vhcDistinctBillCount(transactions),'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
