#!/usr/bin/env node
// v3.19.0 billing-tab state: Points 1 (no default / sticky payment mode), 2 (cash panel only for
// Cash), 3 (tab-scoped Custom Charge draft) and 6 (inline Split Payment).
//
// Runs the REAL helper functions extracted from the shipped renderer bundle, and models the
// component's tab updates exactly as the bundle performs them:
//   setTabs(prev => prev.map(t => t.id === activeTabId ? helper(t, ...) : t)).
// The second half asserts the bundle is wired to those helpers (and the old popup is gone).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; }
}

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const start = bundle.indexOf('const VHC_PAYMENT_MODES');
const end = bundle.indexOf('function vhcLoadInitialState(');
assert.ok(start > 0 && end > start, 'billing helpers must exist in the bundle');
// eslint-disable-next-line no-new-func
const H = new Function(`${bundle.slice(start, end)}; return { VHC_PAYMENT_MODES, vhcMakeEmptyTab, vhcGenTabId, vhcNormalizeTab, vhcTabSelectPaymentMode, vhcTabResetForNewBill, vhcTabAddCustomCharge, vhcParseMoney, vhcSplitPaymentState, vhcPaymentBlockReason, vhcBuildPaymentDetails };`)();

// Minimal model of the component's tab store, using the bundle's own helpers.
function store() {
  const first = H.vhcMakeEmptyTab('tab_A');
  const st = { tabs: [first], active: 'tab_A' };
  const onActive = (fn) => { st.tabs = st.tabs.map((t) => (t.id === st.active ? fn(t) : t)); };
  return {
    st,
    tab: (id) => st.tabs.find((t) => t.id === (id || st.active)),
    addTab(id) { st.tabs.push(H.vhcMakeEmptyTab(id)); st.active = id; },
    switchTo(id) { st.active = id; },
    selectMode(mode) { onActive((t) => H.vhcTabSelectPaymentMode(t, mode)); },
    set(field, value) { onActive((t) => ({ ...t, [field]: value })); },
    addCharge(id) { const r = H.vhcTabAddCustomCharge(this.tab(), id); if (!r.error) onActive((t) => H.vhcTabAddCustomCharge(t, id).tab); return r; },
    completeSale(lastBillId) { onActive((t) => ({ ...t, lastBillId })); onActive((t) => H.vhcTabResetForNewBill(t)); },
    block(total) { const t = this.tab(); return H.vhcPaymentBlockReason({ hasContent: true, mode: t.paymentMode, cashReceived: t.cashReceived, splitCash: t.splitCash, splitUpi: t.splitUpi, netTotal: total }); },
  };
}

console.log('PAYMENT MODE (Point 1)');
check('1 a new bill (first tab) has NO payment mode selected', () => {
  assert.strictEqual(H.vhcMakeEmptyTab('x').paymentMode, null);
});
check('2 a new tab has no payment mode, even when the current tab has one', () => {
  const s = store(); s.selectMode('Cash'); s.addTab('tab_B');
  assert.strictEqual(s.tab('tab_B').paymentMode, null);
  assert.strictEqual(s.tab('tab_A').paymentMode, 'Cash');
});
check('3a Cash on Tab A does not affect Tab B', () => {
  const s = store(); s.addTab('tab_B'); s.switchTo('tab_A'); s.selectMode('Cash');
  assert.strictEqual(s.tab('tab_B').paymentMode, null);
});
check('3b UPI on Tab B does not affect Tab A; each tab restores only its own mode', () => {
  const s = store(); s.selectMode('Cash'); s.addTab('tab_B'); s.selectMode('UPI');
  s.switchTo('tab_A'); assert.strictEqual(s.tab().paymentMode, 'Cash');
  s.switchTo('tab_B'); assert.strictEqual(s.tab().paymentMode, 'UPI');
});
check('4 completed bill -> the next bill on that tab starts with NO payment mode', () => {
  const s = store(); s.selectMode('Credit'); s.completeSale('BILL-1');
  assert.strictEqual(s.tab().paymentMode, null);
  assert.strictEqual(s.tab().lastBillId, 'BILL-1', 'reprint reference of the previous sale is kept');
  assert.deepStrictEqual(s.tab().cart, []);
});
check('5 Complete Payment is blocked with mode NONE ("Select payment mode")', () => {
  const s = store();
  assert.strictEqual(s.block(100), 'Select payment mode');
  assert.strictEqual(H.vhcPaymentBlockReason({ hasContent: true, mode: 'Card', netTotal: 1 }), 'Select payment mode', 'a legacy/unknown mode is NONE');
  assert.strictEqual(H.vhcPaymentBlockReason({ hasContent: false, mode: 'Cash', netTotal: 1 }), 'Cart is empty.');
  for (const m of ['Cash', 'UPI', 'Credit']) { s.selectMode(m); assert.strictEqual(s.block(100), null, m); }
});
check('5b a restored tab keeps only its own explicit mode; legacy/unknown modes become NONE', () => {
  assert.strictEqual(H.vhcNormalizeTab({ id: 'a', paymentMode: 'UPI' }).paymentMode, 'UPI');
  assert.strictEqual(H.vhcNormalizeTab({ id: 'a', paymentMode: 'Card' }).paymentMode, null);
  assert.strictEqual(H.vhcNormalizeTab({ id: 'a' }).paymentMode, null);
  const n = H.vhcNormalizeTab({ id: 'a' });
  for (const k of ['cashReceived', 'splitCash', 'splitUpi', 'customChargeLabel', 'customChargeAmount']) assert.strictEqual(n[k], '', k);
});

console.log('CASH PANEL (Point 2)');
check('6 a new bill has no cash values (panel hidden: mode is not Cash)', () => {
  const t = H.vhcMakeEmptyTab('x'); assert.strictEqual(t.cashReceived, ''); assert.notStrictEqual(t.paymentMode, 'Cash');
});
check('7 selecting Cash keeps the Cash Received figure for this tab', () => {
  const s = store(); s.selectMode('Cash'); s.set('cashReceived', '500'); s.selectMode('Cash');
  assert.strictEqual(s.tab().cashReceived, '500');
});
for (const [n, mode] of [['8', 'UPI'], ['9', 'Credit'], ['10', 'Split']]) {
  check(`${n} switching Cash -> ${mode} clears Cash Received (no stale Change to Return)`, () => {
    const s = store(); s.selectMode('Cash'); s.set('cashReceived', '500'); s.selectMode(mode);
    assert.strictEqual(s.tab().paymentMode, mode); assert.strictEqual(s.tab().cashReceived, '');
    s.selectMode('Cash'); assert.strictEqual(s.tab().cashReceived, '', 'returning to Cash starts clean');
  });
}
check('11 Cash Received is per tab and never leaks to another tab or the next bill', () => {
  const s = store(); s.selectMode('Cash'); s.set('cashReceived', '200'); s.addTab('tab_B'); s.selectMode('Cash');
  assert.strictEqual(s.tab('tab_B').cashReceived, '');
  s.switchTo('tab_A'); s.completeSale('BILL-2'); assert.strictEqual(s.tab('tab_A').cashReceived, '');
});
check('11b existing short-cash validation is unchanged (blocks below total, allows blank/exact/over)', () => {
  const s = store(); s.selectMode('Cash');
  assert.strictEqual(s.block(100), null, 'blank cash received is allowed as before');
  s.set('cashReceived', '99.99'); assert.match(s.block(100), /less than the bill total/);
  s.set('cashReceived', '100'); assert.strictEqual(s.block(100), null);
  s.set('cashReceived', '500'); assert.strictEqual(s.block(100), null);
});

console.log('CUSTOM CHARGE (Point 3)');
check('12 a Custom Charge draft in Tab A is invisible in Tab B; each tab keeps only its own draft', () => {
  const s = store(); s.set('customChargeLabel', 'Dressing A'); s.set('customChargeAmount', '50');
  s.addTab('tab_B'); assert.strictEqual(s.tab().customChargeLabel, ''); assert.strictEqual(s.tab().customChargeAmount, '');
  s.set('customChargeLabel', 'Nebulizer B'); s.set('customChargeAmount', '80');
  s.switchTo('tab_A'); assert.strictEqual(s.tab().customChargeLabel, 'Dressing A'); assert.strictEqual(s.tab().customChargeAmount, '50');
  s.switchTo('tab_B'); assert.strictEqual(s.tab().customChargeLabel, 'Nebulizer B');
});
check('13 another new tab starts with blank Custom Charge fields', () => {
  const s = store(); s.set('customChargeLabel', 'X'); s.addTab('tab_C');
  assert.strictEqual(s.tab().customChargeLabel, ''); assert.strictEqual(s.tab().customChargeAmount, '');
});
check('14 "+" clears the draft only after a successful add; a failed add keeps it', () => {
  const s = store(); s.set('customChargeLabel', 'Dressing'); s.set('customChargeAmount', '0');
  let r = s.addCharge('CHG-1'); assert.strictEqual(r.error, 'Please enter a valid amount.');
  assert.strictEqual(s.tab().customChargeLabel, 'Dressing'); assert.strictEqual(s.tab().customCharges.length, 0);
  s.set('customChargeLabel', '  '); s.set('customChargeAmount', '40'); r = s.addCharge('CHG-2'); assert.strictEqual(r.error, 'Please enter a charge label.');
  assert.strictEqual(s.tab().customChargeAmount, '40');
  s.set('customChargeLabel', ' Dressing '); r = s.addCharge('CHG-3');
  assert.strictEqual(r.error, null); assert.strictEqual(s.tab().customChargeLabel, ''); assert.strictEqual(s.tab().customChargeAmount, '');
});
check('15 the added cart line remains, and charges already in the cart are untouched by later drafts', () => {
  const s = store(); s.set('customChargeLabel', 'Dressing'); s.set('customChargeAmount', '40'); s.addCharge('CHG-1');
  s.set('customChargeLabel', 'Draft only'); s.set('customChargeAmount', '9');
  assert.deepStrictEqual(s.tab().customCharges, [{ id: 'CHG-1', label: 'Dressing', amount: 40 }]);
  s.addTab('tab_B'); assert.deepStrictEqual(s.tab('tab_B').customCharges, []);
  assert.strictEqual(s.tab('tab_A').customCharges.length, 1);
});

console.log('SPLIT PAYMENT (Point 6)');
check('17 Split selected -> inline Cash/UPI values belong to this tab', () => {
  const s = store(); s.selectMode('Split'); s.set('splitCash', '60'); s.set('splitUpi', '40');
  assert.strictEqual(s.block(100), null);
});
check('18 split is valid only when Cash + UPI equals the Net Total (to the paisa)', () => {
  const v = (c, u, t) => H.vhcSplitPaymentState(c, u, t);
  assert.strictEqual(v('60', '40', 100).valid, true);
  assert.strictEqual(v('0', '314.47', 314.468).valid, true, 'rounded Net Total as displayed');
  assert.strictEqual(v('60.004', '40', 100).valid, true, 'sub-paisa input rounds to 60.00');
  assert.match(v('60.005', '40', 100).error, /exceeds the Net Total ₹100\.00 by ₹0\.01/, 'rounds half-up to 60.01');
  assert.match(v('60', '30', 100).error, /short of the Net Total/);
  assert.match(v('60', '50', 100).error, /exceeds the Net Total/);
});
check('19 invalid split blocks payment: missing, negative, NaN, non-numeric, wrong total', () => {
  const b = (c, u) => H.vhcPaymentBlockReason({ hasContent: true, mode: 'Split', splitCash: c, splitUpi: u, netTotal: 100 });
  assert.match(b('', '100'), /Enter both/);
  assert.match(b('100', ''), /Enter both/);
  assert.match(b('-10', '110'), /cannot be negative/);
  assert.match(b('abc', '100'), /valid numbers/);
  assert.match(b('1e2', '0'), /valid numbers/);
  assert.match(b('NaN', '0'), /valid numbers/);
  assert.match(b('10', '10'), /short/);
  assert.strictEqual(b('100', '0'), null);
});
check('20 switching away from Split hides and resets the split amounts', () => {
  const s = store(); s.selectMode('Split'); s.set('splitCash', '60'); s.set('splitUpi', '40');
  for (const m of ['Cash', 'UPI', 'Credit']) {
    s.selectMode('Split'); s.set('splitCash', '60'); s.set('splitUpi', '40'); s.selectMode(m);
    assert.strictEqual(s.tab().splitCash, ''); assert.strictEqual(s.tab().splitUpi, '');
  }
  s.selectMode('Split'); assert.strictEqual(s.tab().splitCash, '', 'coming back to Split starts empty');
});
check('21 split values never leak across tabs or into the next bill', () => {
  const s = store(); s.selectMode('Split'); s.set('splitCash', '60'); s.set('splitUpi', '40');
  s.addTab('tab_B'); s.selectMode('Split'); assert.strictEqual(s.tab().splitCash, ''); assert.strictEqual(s.tab().splitUpi, '');
  s.switchTo('tab_A'); assert.strictEqual(s.tab().splitCash, '60', 'Tab A keeps its own in-progress split');
  s.completeSale('BILL-3'); assert.strictEqual(s.tab().splitCash, ''); assert.strictEqual(s.tab().paymentMode, null);
});
check('21b saved Split breakdown keeps the {cash, upi, credit} shape (reports compatible), fully paid', () => {
  const st = H.vhcSplitPaymentState('60', '40.5', 100.5);
  assert.deepStrictEqual(H.vhcBuildPaymentDetails('Split', 100.5, st), { breakdown: { cash: 60, upi: 40.5, credit: 0 }, amountReceived: 100.5, outstandingAmount: 0, status: 'Paid' });
  assert.deepStrictEqual(H.vhcBuildPaymentDetails('Credit', 80, null), { breakdown: { credit: 80 }, amountReceived: 0, outstandingAmount: 80, status: 'Credit' });
  assert.deepStrictEqual(H.vhcBuildPaymentDetails('UPI', 80, null), { breakdown: { UPI: 80 }, amountReceived: 80, outstandingAmount: 0, status: 'Paid' });
});
check('21c a v3.18.x restored tab with the old popup split object is migrated, not lost', () => {
  const n = H.vhcNormalizeTab({ id: 'a', paymentMode: 'Split', splitPayment: { cash: 70, upi: 30, credit: 0 } });
  assert.strictEqual(n.splitCash, '70'); assert.strictEqual(n.splitUpi, '30'); assert.ok(!('splitPayment' in n));
  const m = H.vhcNormalizeTab({ id: 'a', paymentMode: 'UPI', splitPayment: { cash: 70, upi: 30 }, cashReceived: '5' });
  assert.strictEqual(m.splitCash, ''); assert.strictEqual(m.cashReceived, '');
});

console.log('BUNDLE WIRING');
const nh = bundle.slice(bundle.indexOf('function Nh() {'), bundle.indexOf('function Nh() {') + 200000);
check('16 the Split mini-popup is gone; Split shows inline fields', () => {
  assert.ok(!/splitPaymentPopupOpen|setSplitPaymentPopupOpen|`Apply`/.test(nh.slice(0, nh.indexOf('tabPendingClose &&'))), 'no popup state or Apply button');
  assert.ok(nh.includes('f === `Split` &&\n') || nh.includes('f === `Split` &&\r\n'), 'inline block is gated on Split');
  assert.ok(nh.includes('"data-vhc-split-inline": `1`'));
  assert.ok(nh.includes('onClick: () => p(`Split`),'));
});
check('W1 cash panel is rendered only when the selected mode is Cash', () => {
  const i = nh.indexOf('`Cash Received`');
  const gate = nh.lastIndexOf('f === `Cash` &&', i);
  assert.ok(i > 0 && gate > 0 && i - gate < 1200, 'Cash Received sits inside the f === Cash gate');
  assert.strictEqual((nh.match(/`Cash Received`/g) || []).length, 1, 'exactly one Cash Received section');
});
check('W1b cash section sits INSIDE the payment card: directly below Discount, above Net Total; no Bill Total', () => {
  const pay = nh.indexOf('children: `💳 Payment Mode`');
  const disc = nh.indexOf('children: `Discount`,', pay);
  const cash = nh.indexOf('"data-vhc-cash-panel": `1`,', pay);
  const net = nh.indexOf('(0, J.jsx)(`span`, { children: `Net Total` })', pay);
  assert.ok(pay > 0 && disc > pay && cash > disc && net > cash, JSON.stringify({ pay, disc, cash, net }));
  // nothing else renders between the Discount row and the cash section
  const between = nh.slice(disc, cash);
  assert.ok(!/Dynamic GST|Injections|Procedures|Custom Charges|Sub Total/.test(between), 'cash follows Discount directly');
  assert.ok(!nh.includes('`Bill Total`'), 'no duplicate Bill Total');
  assert.strictEqual((nh.match(/children: `Net Total`/g) || []).length, 1, 'Net Total shown once');
});
check('W2 bill-draft inputs are tab state, not component-wide useState', () => {
  for (const re of [/\[customChargeLabel, setCustomChargeLabel\] = \(0, _\.useState\)/, /\[cashReceived, setCashReceived\] = \(0, _\.useState\)/, /\[splitCashInput, setSplitCashInput\] = \(0, _\.useState\)/]) assert.doesNotMatch(nh, re);
  assert.ok(nh.includes('[customChargeLabel, setCustomChargeLabel] = [activeTab.customChargeLabel || ``, vhcField(`customChargeLabel`)]'));
  assert.ok(nh.includes('[cashReceived, setCashReceived] = [activeTab.cashReceived || ``, vhcField(`cashReceived`)]'));
  assert.ok(nh.includes('[splitCashInput, setSplitCashInput] = [activeTab.splitCash || ``, vhcField(`splitCash`)]'));
});
check('W3 payment mode selection and reset go through the tested helpers', () => {
  assert.ok(nh.includes('t.id === activeTabId ? vhcTabSelectPaymentMode(t, mode) : t'));
  assert.ok(nh.includes('t.id === activeTabId ? vhcTabResetForNewBill(t) : t'));
  assert.ok(nh.includes('vhcTabAddCustomCharge(activeTab, chargeId)'));
  assert.ok(bundle.includes('tabs: parsed.tabs.map(vhcNormalizeTab)'));
});
check('W4 Complete Payment is disabled by the same guard checkout enforces (zero mutation on NONE)', () => {
  assert.ok(nh.includes('disabled: !!paymentBlockReason,'));
  assert.ok(nh.includes('children: f ? [`F8 - Complete Payment (`, f, `)`] : [`Select payment mode`]'));
  const oe = nh.indexOf('oe = async () => {');
  const guard = nh.indexOf('if (paymentBlockReason) {', oe);
  const firstWrite = nh.indexOf('checkoutInFlight.current = true;', oe);
  assert.ok(oe > 0 && guard > oe && firstWrite > guard, 'the guard runs before any checkout work');
  assert.ok(nh.includes('paymentDetails = Object.assign(vhcBuildPaymentDetails(f, a, splitState), { recordedBy: recordedByEmail })'));
});
check('W5 F8 / Ctrl+P always use the current render (no stale payment mode)', () => {
  assert.ok(nh.includes('vhcCheckoutRef.current = { oe, directPrint };'));
  assert.ok(nh.includes("? (e.preventDefault(), vhcCheckoutRef.current.oe())"));
  assert.ok(nh.includes('(e.preventDefault(), vhcCheckoutRef.current.directPrint());'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
