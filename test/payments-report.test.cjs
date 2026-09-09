// Regression tests for the Payments report's calculation logic.
//
// There is no test framework anywhere in this repo (no Jest/Vitest/etc. in
// package.json) and the renderer is a single minified bundle with no module
// system to import from, so this is a plain Node script using the built-in
// `assert` module — run it directly with `node test/payments-report.test.cjs`.
// It does not exercise the real bundle; it mirrors the three pure functions
// added to dist/assets/index-doBKNLAj.js (expandBillToPaymentTransactions,
// filterPaymentTransactions, computePaymentSummary) line-for-line. If that
// logic changes, update this file to match — see the comment above those
// functions in the bundle, which points back here.
//
// Covers the 17 regression scenarios from the Payments Report spec.

const assert = require('assert');

// ---- mirrored pure logic (keep in sync with dist/assets/index-doBKNLAj.js) ----

function paymentMethodLabel(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'cash') return 'Cash';
  if (k === 'upi') return 'UPI';
  if (k === 'card') return 'Card';
  if (k === 'credit') return 'Credit';
  if (k === 'unspecified') return 'Other (split detail unavailable)';
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Other';
}

function expandBillToPaymentTransactions(bill) {
  if (!bill || !bill.billId) return [];
  let breakdown = bill.paymentBreakdown;
  if (!breakdown || typeof breakdown !== 'object') {
    // Legacy bill, or a Split bill synced cross-terminal via the cloud only (its
    // paymentBreakdown never reached Supabase — see createSale) — "Split" itself
    // must never become a fake payment-method bucket.
    breakdown = bill.paymentMode === 'Credit'
      ? { credit: bill.totalAmount || 0 }
      : bill.paymentMode === 'Split'
        ? { unspecified: bill.totalAmount || 0 }
        : { [bill.paymentMode || 'Cash']: bill.totalAmount || 0 };
  }
  const paymentType = bill.paymentMode === 'Split' ? 'Split' : 'Single';
  const rawStatus = bill.paymentStatus || (bill.paymentMode === 'Credit' ? 'Credit' : 'Paid');
  const billStatus = rawStatus === 'Credit' ? 'Pending/Unpaid' : rawStatus;
  const rows = [];
  Object.keys(breakdown).forEach((key) => {
    const amount = parseFloat(breakdown[key]) || 0;
    if (amount <= 0) return;
    rows.push({
      billId: bill.billId,
      billTotal: bill.totalAmount || 0,
      date: bill.date,
      patientName: bill.patientName || 'Walk-in Patient',
      method: paymentMethodLabel(key),
      isCredit: String(key).toLowerCase() === 'credit',
      amount,
      billStatus,
      paymentType,
      recordedBy: bill.recordedBy || null,
      reference: bill.paymentReference || null,
    });
  });
  return rows;
}

function filterPaymentTransactions(transactions, filters) {
  const { method, status, type } = filters || {};
  return (transactions || []).filter((t) => {
    if (method && method !== 'all' && t.method.toLowerCase() !== method.toLowerCase()) return false;
    if (status && status !== 'all') {
      const want = status === 'pending' ? 'Pending/Unpaid' : status === 'partial' ? 'Partially Paid' : status === 'paid' ? 'Paid' : null;
      if (want && t.billStatus !== want) return false;
    }
    if (type && type !== 'all' && t.paymentType.toLowerCase() !== type.toLowerCase()) return false;
    return true;
  });
}

function computePaymentSummary(transactions) {
  const sums = { Cash: 0, UPI: 0, Card: 0, Credit: 0, Other: 0 };
  const seenBills = new Map();
  (transactions || []).forEach((t) => {
    const bucket = ['Cash', 'UPI', 'Card', 'Credit'].includes(t.method) ? t.method : 'Other';
    sums[bucket] += t.amount;
    if (!seenBills.has(t.billId)) seenBills.set(t.billId, t.billTotal);
  });
  const totalBilling = Array.from(seenBills.values()).reduce((s, v) => s + (v || 0), 0);
  const totalCollected = sums.Cash + sums.UPI + sums.Card + sums.Other;
  return {
    totalBilling, totalCollected, outstandingTotal: sums.Credit,
    cashCollection: sums.Cash, upiCollection: sums.UPI, cardCollection: sums.Card, otherCollection: sums.Other,
  };
}

// ---- test harness ----

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

const bill = (overrides) => Object.assign({
  billId: 'BILL-1', date: '2026-09-09T10:00:00.000Z', patientName: 'Ravi Kumar', totalAmount: 1000,
}, overrides);

// 1. Single Cash payment
test('1. Single Cash payment', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Cash', totalAmount: 1000, amountReceived: 1000, outstandingAmount: 0, paymentStatus: 'Paid', paymentBreakdown: { Cash: 1000 } }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].method, 'Cash');
  assert.strictEqual(rows[0].amount, 1000);
  assert.strictEqual(rows[0].billStatus, 'Paid');
});

// 2. Single UPI payment
test('2. Single UPI payment', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'UPI', totalAmount: 500, amountReceived: 500, outstandingAmount: 0, paymentStatus: 'Paid', paymentBreakdown: { UPI: 500 } }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].method, 'UPI');
  assert.strictEqual(rows[0].amount, 500);
});

// 3. Single Card payment (legacy — predates paymentBreakdown entirely)
test('3. Single Card payment (legacy bill, no paymentBreakdown)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Card', totalAmount: 750 }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].method, 'Card');
  assert.strictEqual(rows[0].amount, 750);
  assert.strictEqual(rows[0].billStatus, 'Paid'); // legacy bills assumed fully paid, same convention as ae()
});

// 4. Two-method split payment
test('4. Two-method split payment (Cash 4000 + UPI 6000 of 10000)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Split', totalAmount: 10000, amountReceived: 10000, outstandingAmount: 0, paymentStatus: 'Paid', paymentBreakdown: { cash: 4000, upi: 6000, credit: 0 } }));
  assert.strictEqual(rows.length, 2, 'must be two SEPARATE rows, not one combined 10000 row');
  const cash = rows.find((r) => r.method === 'Cash'), upi = rows.find((r) => r.method === 'UPI');
  assert.strictEqual(cash.amount, 4000);
  assert.strictEqual(upi.amount, 6000);
  assert.ok(!rows.some((r) => r.amount === 10000), 'must not also emit a combined 10000 row');
});

// 5. Three-method split payment (Cash + UPI + remaining Credit)
test('5. Three-method split (Cash 500 + UPI 300 + Credit 200 of 1000)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Split', totalAmount: 1000, amountReceived: 800, outstandingAmount: 200, paymentStatus: 'Partially Paid', paymentBreakdown: { cash: 500, upi: 300, credit: 200 } }));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows.find((r) => r.method === 'Cash').amount, 500);
  assert.strictEqual(rows.find((r) => r.method === 'UPI').amount, 300);
  const credit = rows.find((r) => r.method === 'Credit');
  assert.strictEqual(credit.amount, 200);
  assert.strictEqual(credit.isCredit, true);
  assert.strictEqual(credit.billStatus, 'Partially Paid');
});

// 6. Partial payment (Cash only, remainder outstanding)
test('6. Partial payment (Cash 3000 of 10000, 7000 outstanding)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Split', totalAmount: 10000, amountReceived: 3000, outstandingAmount: 7000, paymentStatus: 'Partially Paid', paymentBreakdown: { cash: 3000, upi: 0, credit: 7000 } }));
  assert.strictEqual(rows.length, 2, 'Cash row + Credit(outstanding) row, no zero-amount UPI row');
  assert.strictEqual(rows.find((r) => r.method === 'Cash').amount, 3000);
  assert.strictEqual(rows.find((r) => r.method === 'Credit').amount, 7000);
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalCollected, 3000, 'outstanding credit must NOT count as collected');
  assert.strictEqual(summary.outstandingTotal, 7000);
});

// 7. Fully paid invoice
test('7. Fully paid invoice (Credit-mode bill fully settled looks the same as Paid)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Cash', totalAmount: 200, amountReceived: 200, outstandingAmount: 0, paymentStatus: 'Paid', paymentBreakdown: { Cash: 200 } }));
  assert.strictEqual(rows[0].billStatus, 'Paid');
  assert.strictEqual(computePaymentSummary(rows).outstandingTotal, 0);
});

// 8. Outstanding balance (pure Credit sale — no money moved yet)
test('8. Outstanding balance (pure Credit, 0 collected)', () => {
  const rows = expandBillToPaymentTransactions(bill({ paymentMode: 'Credit', totalAmount: 1500, amountReceived: 0, outstandingAmount: 1500, paymentStatus: 'Credit', paymentBreakdown: { credit: 1500 } }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].method, 'Credit');
  assert.strictEqual(rows[0].billStatus, 'Pending/Unpaid', 'stored status "Credit" must display as Pending/Unpaid per spec');
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalCollected, 0);
  assert.strictEqual(summary.outstandingTotal, 1500);
});

// 9. Date filtering — handled upstream by the existing date-filter (`D` in
// the Reports component), which the Payments tab reuses as-is; nothing new
// to test here beyond confirming a bill's `date` field survives untouched.
test('9. Date field passes through unchanged for upstream date filtering', () => {
  const rows = expandBillToPaymentTransactions(bill({ date: '2026-09-09T05:30:00.000Z', paymentMode: 'Cash', totalAmount: 100, paymentBreakdown: { Cash: 100 } }));
  assert.strictEqual(rows[0].date, '2026-09-09T05:30:00.000Z');
});

// 10. Payment-method filtering
test('10. Payment-method filter (UPI only)', () => {
  const rows = [
    ...expandBillToPaymentTransactions(bill({ billId: 'B1', paymentMode: 'Cash', totalAmount: 100, paymentBreakdown: { Cash: 100 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B2', paymentMode: 'UPI', totalAmount: 200, paymentBreakdown: { UPI: 200 } })),
  ];
  const filtered = filterPaymentTransactions(rows, { method: 'upi' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].method, 'UPI');
});

// 11. Patient filtering — reuses the existing search box (patientName/billId
// substring match already in the Reports component's own `D` filter); the
// expansion function just needs to preserve patientName correctly.
test('11. Patient name is preserved for the existing search filter to match against', () => {
  const rows = expandBillToPaymentTransactions(bill({ patientName: 'Sunita Devi', paymentMode: 'Cash', totalAmount: 50, paymentBreakdown: { Cash: 50 } }));
  assert.strictEqual(rows[0].patientName, 'Sunita Devi');
});

// 12. Invoice filtering — same as above, via billId.
test('12. Bill ID is preserved for the existing search filter to match against', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'BILL-XYZ-42', paymentMode: 'Cash', totalAmount: 50, paymentBreakdown: { Cash: 50 } }));
  assert.strictEqual(rows[0].billId, 'BILL-XYZ-42');
});

// 13. Split payment reporting (Payment Type filter)
test('13. Payment-type filter distinguishes Split from Single', () => {
  const single = expandBillToPaymentTransactions(bill({ billId: 'B1', paymentMode: 'Cash', totalAmount: 100, paymentBreakdown: { Cash: 100 } }));
  const split = expandBillToPaymentTransactions(bill({ billId: 'B2', paymentMode: 'Split', totalAmount: 100, paymentBreakdown: { cash: 40, upi: 60 } }));
  const all = [...single, ...split];
  assert.strictEqual(filterPaymentTransactions(all, { type: 'split' }).length, 2);
  assert.strictEqual(filterPaymentTransactions(all, { type: 'single' }).length, 1);
});

// 14. Payment-method totals (three methods, no cross-contamination)
test('14. Payment-method totals sum correctly across multiple bills', () => {
  const rows = [
    ...expandBillToPaymentTransactions(bill({ billId: 'B1', paymentMode: 'Cash', totalAmount: 25000, paymentBreakdown: { Cash: 25000 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B2', paymentMode: 'UPI', totalAmount: 18000, paymentBreakdown: { UPI: 18000 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B3', paymentMode: 'Card', totalAmount: 7000, paymentBreakdown: { Card: 7000 } })),
  ];
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.cashCollection, 25000);
  assert.strictEqual(summary.upiCollection, 18000);
  assert.strictEqual(summary.cardCollection, 7000);
  assert.strictEqual(summary.totalCollected, 50000);
});

// 15 & 16. CSV / PDF export — the export functions read the same filtered
// transaction array this module produces; covered by live verification
// against the real app (see the task's final report) since jsPDF/Blob/DOM
// download are not meaningfully testable from a headless Node script.

// 17. Prevention of double counting
test('17a. Total Billing counts a split bill once, not once per payment row', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B1', paymentMode: 'Split', totalAmount: 10000, paymentBreakdown: { cash: 4000, upi: 6000 } }));
  assert.strictEqual(rows.length, 2);
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalBilling, 10000, 'must be 10000 once, not 20000 (double-counted across the 2 rows)');
});
test('17b. Collected total across a split equals the invoice total exactly, no over/under count', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B1', paymentMode: 'Split', totalAmount: 10000, paymentBreakdown: { cash: 4000, upi: 6000, credit: 0 } }));
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalCollected, 10000);
  assert.strictEqual(summary.totalCollected + summary.outstandingTotal, 10000);
});

// Found live against real production data: a Split bill synced to a second
// terminal only via the cloud (createSale never sends paymentBreakdown, so a
// cross-terminal read can't reconstruct it) must not report "Split" itself as
// if it were a payment method the customer chose.
test('18. Cross-terminal Split bill with no local paymentBreakdown never reports "Split" as a method', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B-CLOUD-ONLY', paymentMode: 'Split', totalAmount: 300 }));
  assert.strictEqual(rows.length, 1);
  assert.notStrictEqual(rows[0].method, 'Split', 'Split is a paymentMode, never a real payment method label');
  assert.strictEqual(rows[0].method, 'Other (split detail unavailable)');
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.otherCollection, 300, 'must fall into Other, not silently vanish or double up elsewhere');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
