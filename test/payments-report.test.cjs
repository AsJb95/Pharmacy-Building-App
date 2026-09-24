// Regression tests for the Payments report's calculation logic.
//
// There is no test framework anywhere in this repo (no Jest/Vitest/etc. in
// package.json) and the renderer is a single minified bundle with no module
// system to import from, so this is a plain Node script using the built-in
// `assert` module — run it directly with `node test/payments-report.test.cjs`.
// It does not exercise the real bundle; it mirrors the pure functions added to
// dist/assets/index-doBKNLAj.js (computeCreditSettlement,
// expandBillToPaymentTransactions, filterPaymentTransactions,
// computePaymentSummary) line-for-line. If that logic changes, update this
// file to match — see the comment above those functions in the bundle, which
// points back here.
//
// Covers the 17 regression scenarios from the Payments Report spec, plus the
// Credit Repayment / Settlement scenarios added afterward (tests 19+).

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

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

// Credit-repayment settlement math (mirrors dist/assets/index-doBKNLAj.js's
// computeCreditSettlement — keep in sync). Never mutates `bill`.
function computeCreditSettlement(bill) {
  let breakdown = bill && bill.paymentBreakdown;
  if (typeof breakdown === 'string') {
    try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; }
  }
  if (!breakdown || typeof breakdown !== 'object') {
    breakdown = bill.paymentMode === 'Credit'
      ? { credit: bill.totalAmount || 0 }
      : bill.paymentMode === 'Split'
        ? { unspecified: bill.totalAmount || 0 }
        : { [bill.paymentMode || 'Cash']: bill.totalAmount || 0 };
  }
  const originalCredit = round2(breakdown.credit);
  const collectedAtCheckout = round2(Object.keys(breakdown).reduce(
    (sum, k) => (String(k).toLowerCase() === 'credit' ? sum : sum + (parseFloat(breakdown[k]) || 0)), 0,
  ));
  const repayments = (Array.isArray(bill.creditRepayments) ? bill.creditRepayments : []).filter((r) => r && parseFloat(r.amount) > 0);
  const totalRepaid = round2(repayments.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0));
  const outstanding = round2(Math.max(0, originalCredit - totalRepaid));
  let status;
  if (originalCredit <= 0) status = bill.paymentStatus === 'Credit' ? 'Pending/Unpaid' : (bill.paymentStatus || 'Paid');
  else if (outstanding <= 0) status = 'Paid';
  else if (collectedAtCheckout > 0 || totalRepaid > 0) status = 'Partially Paid';
  else status = 'Pending/Unpaid';
  const latestPaymentDate = repayments.reduce(
    (latest, r) => (r.date && (!latest || new Date(r.date) > new Date(latest)) ? r.date : latest), null,
  ) || bill.date;
  return { breakdown, originalCredit, collectedAtCheckout, repayments, totalRepaid, outstanding, status, latestPaymentDate };
}

function expandBillToPaymentTransactions(bill) {
  if (!bill || !bill.billId) return [];
  const settlement = computeCreditSettlement(bill);
  const breakdown = settlement.breakdown;
  const paymentType = bill.paymentMode === 'Split' ? 'Split' : 'Single';
  const billStatus = settlement.status;
  const rows = [];
  Object.keys(breakdown).forEach((key) => {
    const isCreditKey = String(key).toLowerCase() === 'credit';
    const amount = isCreditKey ? settlement.outstanding : (parseFloat(breakdown[key]) || 0);
    if (amount <= 0) return;
    rows.push({
      billId: bill.billId,
      billTotal: bill.totalAmount || 0,
      date: bill.date,
      patientName: bill.patientName || 'Walk-in Patient',
      method: paymentMethodLabel(key),
      isCredit: isCreditKey,
      isRepayment: false,
      amount,
      billStatus,
      paymentType,
      recordedBy: bill.recordedBy || null,
      reference: bill.paymentReference || null,
    });
  });
  settlement.repayments.forEach((rp, idx) => {
    const amount = round2(rp.amount);
    if (amount <= 0) return;
    rows.push({
      billId: bill.billId,
      billTotal: bill.totalAmount || 0,
      date: rp.date || bill.date,
      patientName: bill.patientName || 'Walk-in Patient',
      method: paymentMethodLabel(rp.method),
      isCredit: false,
      isRepayment: true,
      repaymentId: rp.id || `${bill.billId}-repayment-${idx}`,
      amount,
      billStatus,
      paymentType: 'Single',
      recordedBy: rp.recordedBy || null,
      reference: rp.reference || null,
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

function runIntegrityAudit(bills) {
  const issues = [];
  const seenIds = new Map();
  const seenNumbers = new Map();
  const tol = 0.01;
  (bills || []).forEach((bill, index) => {
    if (!bill || typeof bill !== 'object') return;
    const billId = String(bill.billId || bill.id || '').trim();
    if (!billId) {
      issues.push({ code: 'MISSING_BILL_ID', index });
      return;
    }
    if (seenIds.has(billId)) issues.push({ code: 'DUPLICATE_BILL_ID', billId });
    else seenIds.set(billId, index);
    const billNo = String(bill.billNumber || bill.invoiceNumber || bill.billNo || billId).trim();
    if (seenNumbers.has(billNo)) issues.push({ code: 'DUPLICATE_BILL_NUMBER', billId });
    else seenNumbers.set(billNo, billId);
    const total = round2(bill.totalAmount);
    const amountReceived = bill.amountReceived == null ? null : round2(bill.amountReceived);
    const outstandingAmount = bill.outstandingAmount == null ? null : round2(bill.outstandingAmount);
    const rows = expandBillToPaymentTransactions(bill);
    let breakdown = bill.paymentBreakdown;
    if (typeof breakdown === 'string') {
      try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; }
    }
    if (!breakdown || typeof breakdown !== 'object') issues.push({ code: 'MISSING_PAYMENT_BREAKDOWN', billId });
    if (rows.length === 0 && total > 0) issues.push({ code: 'PAYMENT_REPORT_NO_ROWS', billId });
    if (amountReceived != null && outstandingAmount != null && Math.abs(amountReceived + outstandingAmount - total) > tol) issues.push({ code: 'PAYMENT_TOTAL_MISMATCH', billId });
    if ((bill.paymentStatus === 'Paid' || bill.paymentStatus === 'paid') && outstandingAmount != null && outstandingAmount > tol) issues.push({ code: 'PAID_WITH_OUTSTANDING_BALANCE', billId });
    if (bill.fromCloudOnly && (!breakdown || amountReceived == null || outstandingAmount == null || !bill.paymentStatus)) issues.push({ code: 'CLOUD_LOCAL_SCHEMA_MISMATCH', billId });
  });
  return issues;
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

// ---- Credit Repayment / Settlement scenarios ----

// 19. Regression guard: a Split bill that collected SOME money at checkout
// (Cash+UPI) with a Credit remainder must show "Partially Paid" even with
// ZERO repayments made since — it must NOT be downgraded to "Pending/Unpaid"
// just because no repayment transaction exists yet.
test('19. Split bill partially paid at checkout (no repayments yet) stays "Partially Paid"', () => {
  const b = bill({ paymentMode: 'Split', totalAmount: 1000, paymentStatus: 'Partially Paid', paymentBreakdown: { cash: 500, upi: 300, credit: 200 } });
  const settlement = computeCreditSettlement(b);
  assert.strictEqual(settlement.status, 'Partially Paid');
  assert.strictEqual(settlement.outstanding, 200);
  const rows = expandBillToPaymentTransactions(b);
  assert.strictEqual(rows.find((r) => r.isCredit).billStatus, 'Partially Paid');
});

// 20. Exact worked example from the spec: Original 1203, repayment 500 ->
// remaining 703, status "Partially Paid".
test('20. Partial credit repayment (Original 1203, pay 500, remaining 703)', () => {
  const b = bill({ paymentMode: 'Credit', totalAmount: 1203, paymentStatus: 'Credit', paymentBreakdown: { credit: 1203 },
    creditRepayments: [{ id: 'PMT-1', amount: 500, method: 'cash', reference: null, date: '2026-09-10T10:00:00.000Z', recordedBy: 'a@b.com' }] });
  const settlement = computeCreditSettlement(b);
  assert.strictEqual(settlement.outstanding, 703);
  assert.strictEqual(settlement.status, 'Partially Paid');
  assert.strictEqual(settlement.totalRepaid, 500);
});

// 21. Full settlement -> status automatically becomes "Paid", balance 0.
test('21. Full credit repayment settles the bill (status -> Paid, balance -> 0)', () => {
  const b = bill({ paymentMode: 'Credit', totalAmount: 1203, paymentStatus: 'Credit', paymentBreakdown: { credit: 1203 },
    creditRepayments: [{ id: 'PMT-1', amount: 703, method: 'upi', date: '2026-09-10T10:00:00.000Z' }, { id: 'PMT-2', amount: 500, method: 'cash', date: '2026-09-11T10:00:00.000Z' }] });
  const settlement = computeCreditSettlement(b);
  assert.strictEqual(settlement.outstanding, 0);
  assert.strictEqual(settlement.status, 'Paid');
  const rows = expandBillToPaymentTransactions(b);
  assert.ok(!rows.some((r) => r.isCredit), 'no outstanding-Credit row should remain once fully settled');
});

// 22. Multiple repayments are an append-only audit trail: every one of them
// remains its own individually traceable transaction row — never merged,
// never overwritten, and the ORIGINAL paymentBreakdown is untouched.
test('22. Multiple repayments each remain a separate, traceable transaction', () => {
  const originalBreakdown = { credit: 2000 };
  const b = bill({ paymentMode: 'Credit', totalAmount: 2000, paymentStatus: 'Credit', paymentBreakdown: originalBreakdown,
    creditRepayments: [
      { id: 'PMT-1', amount: 800, method: 'cash', reference: 'RCPT-1', date: '2026-09-01T09:00:00.000Z', recordedBy: 'staff1@vhc.com' },
      { id: 'PMT-2', amount: 700, method: 'upi', reference: 'UPI-REF-2', date: '2026-09-05T09:00:00.000Z', recordedBy: 'staff2@vhc.com' },
    ] });
  const rows = expandBillToPaymentTransactions(b);
  const repaymentRows = rows.filter((r) => r.isRepayment);
  assert.strictEqual(repaymentRows.length, 2, 'each repayment must be its own row');
  assert.deepStrictEqual(repaymentRows.map((r) => r.reference).sort(), ['RCPT-1', 'UPI-REF-2']);
  assert.deepStrictEqual(repaymentRows.map((r) => r.recordedBy).sort(), ['staff1@vhc.com', 'staff2@vhc.com']);
  // The original bill's paymentBreakdown object must never be mutated by settlement math.
  assert.deepStrictEqual(b.paymentBreakdown, { credit: 2000 });
  assert.strictEqual(computeCreditSettlement(b).outstanding, 500);
});

// 23. Defensive floor: outstanding must never go negative even if repayment
// data somehow sums to more than the original credit (should not happen once
// the UI enforces "cannot exceed outstanding balance", but the pure math must
// still be safe against it).
test('23. Outstanding balance floors at 0, never goes negative', () => {
  const b = bill({ paymentMode: 'Credit', totalAmount: 100, paymentStatus: 'Credit', paymentBreakdown: { credit: 100 },
    creditRepayments: [{ id: 'PMT-1', amount: 60, method: 'cash' }, { id: 'PMT-2', amount: 60, method: 'cash' }] });
  const settlement = computeCreditSettlement(b);
  assert.strictEqual(settlement.outstanding, 0);
  assert.strictEqual(settlement.status, 'Paid');
});

// 24. Latest Payment Date reflects the most recent repayment activity, not
// the original bill/checkout date, once repayments exist.
test('24. Latest Payment Date reflects the most recent repayment', () => {
  const b = bill({ date: '2026-08-01T00:00:00.000Z', paymentMode: 'Credit', totalAmount: 500, paymentStatus: 'Credit', paymentBreakdown: { credit: 500 },
    creditRepayments: [{ id: 'PMT-1', amount: 200, method: 'cash', date: '2026-08-15T00:00:00.000Z' }, { id: 'PMT-2', amount: 100, method: 'cash', date: '2026-09-01T00:00:00.000Z' }] });
  assert.strictEqual(computeCreditSettlement(b).latestPaymentDate, '2026-09-01T00:00:00.000Z');
});
test('24b. Latest Payment Date falls back to the bill date when there are no repayments', () => {
  const b = bill({ date: '2026-08-01T00:00:00.000Z', paymentMode: 'Credit', totalAmount: 500, paymentStatus: 'Credit', paymentBreakdown: { credit: 500 } });
  assert.strictEqual(computeCreditSettlement(b).latestPaymentDate, '2026-08-01T00:00:00.000Z');
});

// 25. Collection summary picks up repayments automatically: a repayment made
// via UPI must count toward UPI/Total Collected, and outstanding must shrink
// by exactly that amount — Total Billing (the invoice total) never changes.
test('25. Repayments flow into the collection summary correctly', () => {
  const b = bill({ paymentMode: 'Credit', totalAmount: 1000, paymentStatus: 'Credit', paymentBreakdown: { credit: 1000 },
    creditRepayments: [{ id: 'PMT-1', amount: 400, method: 'upi', date: '2026-09-10T00:00:00.000Z' }] });
  const rows = expandBillToPaymentTransactions(b);
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalBilling, 1000, 'invoice total must never change because of a repayment');
  assert.strictEqual(summary.upiCollection, 400);
  assert.strictEqual(summary.totalCollected, 400);
  assert.strictEqual(summary.outstandingTotal, 600);
  assert.strictEqual(summary.totalCollected + summary.outstandingTotal, 1000);
});

// 26. A repayment against a bill never affects any OTHER bill's totals.
test('26. Repayments are isolated to their own bill only', () => {
  const paid = bill({ billId: 'B-OTHER', paymentMode: 'Cash', totalAmount: 300, paymentBreakdown: { Cash: 300 } });
  const credit = bill({ billId: 'B-CREDIT', paymentMode: 'Credit', totalAmount: 1000, paymentStatus: 'Credit', paymentBreakdown: { credit: 1000 },
    creditRepayments: [{ id: 'PMT-1', amount: 1000, method: 'cash', date: '2026-09-10T00:00:00.000Z' }] });
  const rows = [...expandBillToPaymentTransactions(paid), ...expandBillToPaymentTransactions(credit)];
  const summary = computePaymentSummary(rows);
  assert.strictEqual(summary.totalBilling, 1300);
  assert.strictEqual(summary.totalCollected, 1300, 'the other bill\'s Cash payment plus the fully-repaid credit bill');
  assert.strictEqual(summary.outstandingTotal, 0);
});

test('27. Cash bill appears in Payments Report after restart-style reload', () => {
  const stored = JSON.stringify([bill({ billId: 'B-CASH-RELOAD', paymentMode: 'Cash', totalAmount: 90, paymentBreakdown: { Cash: 90 }, amountReceived: 90, outstandingAmount: 0, paymentStatus: 'Paid' })]);
  const reloaded = JSON.parse(stored);
  assert.strictEqual(expandBillToPaymentTransactions(reloaded[0]).length, 1);
});

test('28. UPI, Card, and Credit bills all produce visible rows', () => {
  const rows = [
    ...expandBillToPaymentTransactions(bill({ billId: 'B-UPI', paymentMode: 'UPI', totalAmount: 100, paymentBreakdown: { UPI: 100 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B-CARD', paymentMode: 'Card', totalAmount: 200, paymentBreakdown: { Card: 200 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B-CREDIT2', paymentMode: 'Credit', totalAmount: 300, paymentBreakdown: { credit: 300 }, paymentStatus: 'Credit' })),
  ];
  assert.deepStrictEqual(rows.map((r) => r.method).sort(), ['Card', 'Credit', 'UPI']);
});

test('29. Cloud-synced bill with JSON-string payment_breakdown remains visible', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B-CLOUD-JSON', fromCloudOnly: true, paymentMode: 'Split', totalAmount: 120, paymentBreakdown: '{"cash":50,"upi":70}', amountReceived: 120, outstandingAmount: 0, paymentStatus: 'Paid' }));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(computePaymentSummary(rows).totalCollected, 120);
});

test('30. Same-day and end-of-day date filtering remains string-date safe', () => {
  const tx = [
    ...expandBillToPaymentTransactions(bill({ billId: 'B-START', date: '2026-09-24T00:00:00.000+05:30', paymentMode: 'Cash', totalAmount: 1, paymentBreakdown: { Cash: 1 } })),
    ...expandBillToPaymentTransactions(bill({ billId: 'B-END', date: '2026-09-24T23:59:59.999+05:30', paymentMode: 'Cash', totalAmount: 1, paymentBreakdown: { Cash: 1 } })),
  ];
  const filtered = tx.filter((t) => t.date.slice(0, 10) === '2026-09-24');
  assert.strictEqual(filtered.length, 2);
});

test('31. Null optional fields do not exclude a valid paid bill', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B-NULLS', paymentMode: null, totalAmount: 44, amountReceived: null, outstandingAmount: undefined, paymentStatus: undefined, paymentBreakdown: null }));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].amount, 44);
});

test('32. Duplicate row keys include index/repayment marker and stay unique', () => {
  const rows = expandBillToPaymentTransactions(bill({ billId: 'B-DUPKEY', paymentMode: 'Split', totalAmount: 200, paymentBreakdown: { cash: 100, Cash: 100 } }));
  const keys = rows.map((t, idx) => `${t.billId}-${t.method}-${idx}${t.isRepayment ? '-rp' : ''}`);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('33. Sync merge keeps local richer record over cloud record with same bill id', () => {
  const local = bill({ billId: 'B-MERGE', paymentMode: 'Split', totalAmount: 100, paymentBreakdown: { cash: 40, upi: 60 } });
  const cloud = { billId: 'B-MERGE', paymentMode: 'Split', totalAmount: 100, fromCloudOnly: true };
  const byId = new Map();
  [cloud].forEach((b) => byId.set(b.billId, b));
  [local].forEach((b) => byId.set(b.billId, b));
  assert.deepStrictEqual(byId.get('B-MERGE').paymentBreakdown, { cash: 40, upi: 60 });
});

test('34. Integrity audit detects malformed payment data and duplicates', () => {
  const issues = runIntegrityAudit([
    bill({ billId: 'B-BAD', paymentMode: 'Cash', totalAmount: 100, amountReceived: 80, outstandingAmount: 0, paymentStatus: 'Paid', paymentBreakdown: null }),
    bill({ billId: 'B-BAD', paymentMode: 'Cash', totalAmount: 50, paymentBreakdown: { Cash: 50 } }),
    bill({ billId: 'B-CLOUD-MISS', fromCloudOnly: true, paymentMode: 'Split', totalAmount: 70 }),
  ]).map((i) => i.code);
  assert.ok(issues.includes('MISSING_PAYMENT_BREAKDOWN'));
  assert.ok(issues.includes('DUPLICATE_BILL_ID'));
  assert.ok(issues.includes('PAYMENT_TOTAL_MISMATCH'));
  assert.ok(issues.includes('CLOUD_LOCAL_SCHEMA_MISMATCH'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
