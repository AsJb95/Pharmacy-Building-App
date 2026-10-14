#!/usr/bin/env node
// v3.19.2: Reports must classify bill lines case-insensitively. Cloud sale_items store lowercase
// `medicine`; the old exact-case filters dropped every such line from the Reports receipt (and its
// PDF / print copy), from Product Sales, and the Medicines / Units Sold card was never computed.
// The receipt must also show the ORIGINAL bill date, not the time it was opened.
//
// Runs the REAL code extracted from the shipped bundle: the shared helpers, the Reports receipt
// mapping (bill -> receipt props), the receipt component itself (rendered with react-dom/server),
// the Product Sales aggregation, and the payment summary.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; }
}

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const slice = (from, to) => {
  const a = bundle.indexOf(from), b = bundle.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `bundle section not found: ${from}`);
  return bundle.slice(a, b);
};

// Shared helpers + payment summary (same extraction region as reports-bill-count.test.cjs).
// eslint-disable-next-line no-new-func
const R = new Function(`${slice('function paymentMethodLabel(', 'function paymentStatusColor(')}; return { vhcNormalizeCategory, vhcIsMedicineCategory, vhcIsCategory, vhcCountMedicineUnits, vhcReportUnitCount, vhcReceiptDate, expandBillToPaymentTransactions, computePaymentSummary };`)();

// The receipt component Dh, verbatim. Its PDF/print handlers are never invoked here; hr/Mr/nr are
// lucide icon components in the bundle, stubbed as empty SVGs.
const Icon = () => React.createElement('svg');
// eslint-disable-next-line no-new-func
const Dh = new Function('J', '_', 'Th', 'po', 'Q', 'vhcReceiptDate', 'hr', 'Mr', 'nr', `${slice('function Dh({', 'function Oh(')}; return Dh;`)(
  jsxRuntime, React, () => null, null, null, R.vhcReceiptDate, Icon, Icon, Icon);

// The Reports receipt mapping: the props object passed to <Dh> for a bill `u`, verbatim.
const mapSrc = slice('          cart: ((u.particulars || []).length', '          onClose: () => d(null),');
// eslint-disable-next-line no-new-func
const receiptPropsFor = new Function('vhcIsMedicineCategory', 'vhcIsCategory', 'u', `return {\n${mapSrc}};`)
  .bind(null, R.vhcIsMedicineCategory, R.vhcIsCategory);

// Product Sales aggregation (the productSalesReportData memo body), verbatim.
const psStart = bundle.indexOf('productSalesReportData = _.useMemo(');
const psBody = bundle.slice(psStart + 'productSalesReportData = _.useMemo('.length, bundle.indexOf(', [D, tabletFilter]),', psStart));
// eslint-disable-next-line no-new-func
const productSales = (D, tabletFilter = 'all') => new Function('vhcIsMedicineCategory', 'D', 'tabletFilter', `return (${psBody})();`)(R.vhcIsMedicineCategory, D, tabletFilter);

const renderReceipt = (bill) => renderToStaticMarkup(React.createElement(Dh, { isOpen: true, gstMode: bill.gstMode || 'regular', ...receiptPropsFor(bill) }));
const line = (category, drugName, quantity, rate) => ({ category, drugName, quantity, rate, total: Number(quantity) * rate, batchNo: 'B1', expiryDate: '12/27' });
const cloudBill = (id, iso, lines) => ({ billId: id, date: iso, patientName: 'Test Patient', paymentMode: 'Cash', totalAmount: lines.reduce((s, l) => s + l.total, 0), paymentBreakdown: { Cash: lines.reduce((s, l) => s + l.total, 0) }, particulars: lines });
const rowsIn = (html, name) => (html.match(new RegExp(`>${name}<`, 'g')) || []).length;

console.log('Receipt rows by category (real mapping + real receipt component)');
for (const cat of ['medicine', 'Medicine', 'MEDICINE', 'tablet', 'Medicine/Tablet', ' medicine ', undefined, '', 'Synthetic', 'syrup', 'General Stock']) {
  check(`category ${JSON.stringify(cat)} renders a receipt row with Item / Qty / Rate / Total`, () => {
    const html = renderReceipt(cloudBill('BILL-C1', '2026-10-03T07:35:55Z', [line(cat, 'Paracetamol 500', '2.000', 12.5)]));
    assert.strictEqual(rowsIn(html, 'Paracetamol 500'), 1, 'one item row');
    assert.ok(html.includes('>2<!-- --> u<') || html.includes('>2 u<'), 'qty 2 shown');
    assert.ok(html.includes('>12.50<'), 'rate shown');
    assert.ok(html.includes('>25.00<'), 'line total shown');
  });
}
check('injection / procedure / custom lines are not rendered as medicine rows (any case)', () => {
  const html = renderReceipt(cloudBill('BILL-C2', '2026-10-03T07:35:55Z', [line('INJECTION', 'Inj A', 1, 50), line('procedure', 'Proc B', 1, 80), line('custom', 'Fee C', 1, 30), line('medicine', 'Med D', 1, 10)]));
  assert.strictEqual(rowsIn(html, 'Med D'), 1);
  assert.strictEqual(rowsIn(html, 'Inj A'), 0);
});
check('multi-item historical/cloud bill renders every medicine row', () => {
  const lines = [line('medicine', 'Amox 250', '3.000', 8), line('medicine', 'Cetirizine', '1.000', 4.5), line('Medicine', 'ORS', '2.000', 21), line('tablet', 'Vit C', '10.000', 1.2)];
  const html = renderReceipt(cloudBill('BILL-C3', '2026-10-02T20:36:16Z', lines));
  for (const l of lines) assert.strictEqual(rowsIn(html, l.drugName), 1, l.drugName);
});
check('packaged-QA case: medicine x2 + free-text category line x1 => both rows, net 21.00', () => {
  const html = renderReceipt(cloudBill('BILL-Q1', '2026-10-14T13:50:18Z', [line('medicine', 'TEST-VHC UI Inventory Item', '2.000', 10), line('Synthetic', 'TEST-VHC STOCK RECON 20260929', '1.000', 1)]));
  assert.strictEqual(rowsIn(html, 'TEST-VHC UI Inventory Item'), 1);
  assert.strictEqual(rowsIn(html, 'TEST-VHC STOCK RECON 20260929'), 1);
  assert.ok(html.includes('>20.00<') && html.includes('>1.00<'));
});
check('cloud bill keyed by sale_items (not particulars) also renders lowercase rows', () => {
  const u = { billId: 'BILL-C4', created_at: '2026-10-02T20:36:16Z', paymentMode: 'Cash', totalAmount: 10, sale_items: [{ category: 'medicine', drug_name: 'From Cloud', quantity: '1.000', rate: 10, total: 10 }] };
  assert.strictEqual(rowsIn(renderReceipt(u), 'From Cloud'), 1);
});

console.log('Receipt date');
check('receipt date equals the original bill date (local `date` field)', () => {
  const iso = '2026-10-03T07:35:55Z', d = new Date(iso);
  const html = renderReceipt(cloudBill('BILL-D1', iso, [line('medicine', 'X', 1, 1)]));
  assert.ok(html.includes(d.toLocaleDateString('en-IN')), 'original date');
  assert.ok(html.includes(d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })), 'original time');
});
check('cloud created_at / sale_date are used when `date` is absent', () => {
  const iso = '2026-09-30T11:05:00Z';
  assert.strictEqual(receiptPropsFor({ billId: 'X', created_at: iso, particulars: [] }).billDate, iso);
  assert.strictEqual(receiptPropsFor({ billId: 'X', sale_date: iso, particulars: [] }).billDate, iso);
});
check('"now" only as fallback when no valid bill date exists', () => {
  const t0 = Date.now();
  assert.ok(R.vhcReceiptDate(null).getTime() >= t0 - 5);
  assert.ok(R.vhcReceiptDate('not-a-date').getTime() >= t0 - 5);
  assert.strictEqual(R.vhcReceiptDate('2026-10-03T07:35:55Z').toISOString(), '2026-10-03T07:35:55.000Z');
});
check('receipt no longer reads the open time directly', () => {
  const dh = slice('function Dh({', 'function Oh(');
  assert.ok(!/new Date\(\)\.toLocale(Date|Time)String/.test(dh), 'no new Date() for the printed date');
  assert.ok(dh.includes('receiptDate.toLocaleDateString(`en-IN`)'));
});

console.log('Preview / PDF / print parity');
check('PDF and print both capture the SAME rendered receipt element as the preview', () => {
  const dh = slice('function Dh({', 'function Oh(');
  const uses = dh.match(/document\.getElementById\(printableIdProp\)/g) || [];
  assert.ok(uses.length >= 2, 'PDF (html2canvas) and print (iframe) read the preview element');
  const html = renderReceipt(cloudBill('BILL-P1', '2026-10-03T07:35:55Z', [line('medicine', 'Parity Med', 1, 10)]));
  assert.ok(html.includes('id="thermal-receipt-printable"'), 'printable element rendered');
  const printable = html.slice(html.indexOf('id="thermal-receipt-printable"'));
  assert.ok(printable.includes('>Parity Med<') && printable.includes(new Date('2026-10-03T07:35:55Z').toLocaleDateString('en-IN')), 'rows + date inside the captured element');
});

console.log('Medicines / Units Sold');
const day = [
  cloudBill('BILL-U1', '2026-10-14T13:20:00Z', [line('medicine', 'A', '1.000', 10)]),
  cloudBill('BILL-U2', '2026-10-14T13:21:00Z', [line('Medicine', 'A', 2, 10), line('Injection', 'Inj', 1, 50)]),
  cloudBill('BILL-U3', '2026-10-14T13:22:00Z', [line('MEDICINE', 'B', '3.000', 5), line('custom', 'Fee', 1, 20)]),
];
check('lowercase/mixed medicine rows are counted (1 + 2 + 3 = 6 units; injection/custom excluded)', () => {
  assert.strictEqual(R.vhcCountMedicineUnits(day), 6);
});
check('free-text product categories count as units; services never do', () => {
  const b = [cloudBill('BILL-U4', '2026-10-14T13:23:00Z', [line('Synthetic', 'S', '1.000', 1), line('syrup', 'Y', 2, 30), line('PROCEDURE', 'P', 1, 80), line('Injection', 'I', 1, 50)])];
  assert.strictEqual(R.vhcCountMedicineUnits(b), 3);
});
check('the card counts only bills behind the filtered payment rows', () => {
  const rows = day.flatMap((b) => R.expandBillToPaymentTransactions(b));
  assert.strictEqual(R.vhcReportUnitCount(day, rows), 6);
  assert.strictEqual(R.vhcReportUnitCount(day, rows.filter((r) => r.billId === 'BILL-U3')), 3);
  assert.strictEqual(R.vhcReportUnitCount(day, []), 0);
});
check('summary wiring: unitCount is part of the Reports summary', () => {
  assert.ok(bundle.includes('unitCount: vhcReportUnitCount(D, filteredPaymentTransactions)'));
  assert.ok(bundle.includes('[`Medicines / Units Sold`, summary.unitCount ?? 0]'));
});

console.log('Product Sales');
check('Product Sales includes lowercase medicine rows', () => {
  const ps = productSales(day);
  const a = ps.find((p) => p.productName === 'A'), b = ps.find((p) => p.productName === 'B');
  assert.ok(a && b, 'A and B listed');
  assert.strictEqual(a.saleCount, 3); assert.strictEqual(b.saleCount, 3);
  assert.ok(!ps.some((p) => p.productName === 'Inj' || p.productName === 'Fee'), 'non-medicine excluded');
  assert.strictEqual(ps.length, 2);
});

console.log('Financial totals unchanged');
check('payment summary is identical whether categories are lowercase or Title Case', () => {
  const title = day.map((b) => ({ ...b, particulars: b.particulars.map((p) => ({ ...p, category: p.category && p.category[0].toUpperCase() + p.category.slice(1).toLowerCase() })) }));
  const s1 = R.computePaymentSummary(day.flatMap((b) => R.expandBillToPaymentTransactions(b)));
  const s2 = R.computePaymentSummary(title.flatMap((b) => R.expandBillToPaymentTransactions(b)));
  assert.deepStrictEqual(s1, s2);
  assert.strictEqual(s1.totalBilling, day.reduce((s, b) => s + b.totalAmount, 0));
});
check('no exact-case category comparison remains in the bundle', () => {
  assert.ok(!/category (===|!==) [`"']/.test(bundle));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
