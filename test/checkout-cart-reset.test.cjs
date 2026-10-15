#!/usr/bin/env node
// v3.19.4: after a successful LOCAL sale commit the bill must ALWAYS reset, even if a non-critical
// post-success step throws. Clinic incident: the bill was saved (visible in Reports) but the cart
// kept the billed item, because the reset ran last and the activity log write (full localStorage)
// threw before it. Runs the REAL helpers extracted from the shipped bundle, plus wiring checks on the
// real checkout function.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); console.log('  PASS  ' + name); passed++; } catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; } };

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const a = bundle.indexOf('const VHC_PAYMENT_MODES =');
const b = bundle.indexOf('function vhcTabAddCustomCharge(', a);
assert.ok(a > 0 && b > a, 'tab helpers present');
// eslint-disable-next-line no-new-func
const H = new Function('console', `${bundle.slice(a, b)}; return { vhcMakeEmptyTab, vhcTabResetForNewBill, vhcFinishCommittedCheckout, vhcResetCompletedTabs, vhcTabSelectPaymentMode };`)({ error() {}, warn() {}, log() {} });

// The real checkout function body (oe), for wiring assertions.
const oeStart = bundle.indexOf('    oe = async () => {');
const oeEnd = bundle.indexOf('\n    W = () => {', oeStart);
assert.ok(oeStart > 0 && oeEnd > oeStart, 'checkout function present');
const oe = bundle.slice(oeStart, oeEnd);

// ── a small faithful model of one checkout: local store (idempotent by bill id, like SQLite
// createLocalSale) + the tab + the REAL post-commit helper and REAL tab reset ──────────────────────
function makeCounter() {
  const store = new Map();            // bill_id -> sale
  let tab = { ...H.vhcMakeEmptyTab('tab_1'), cart: [{ id: 'b1', name: 'PARA 650', qty: 10 }], patientName: 'P', selectedPatient: { name: 'P' },
    doctorName: 'Dr', paymentMode: 'Cash', cashReceived: '100', splitCash: '', splitUpi: '', discountAmount: '5', discountPercent: '2',
    customCharges: [{ id: 'c', label: 'Fee', amount: 20 }], injectionItems: [{ medicineName: 'Inj' }], procedureItems: [{ procedureName: 'Pr' }],
    customChargeLabel: 'x', customChargeAmount: '3' };
  let inFlight = false;
  const queued = [];
  const persisted = { tabs: null };
  function checkout({ failLocal = false, throwing = [], cloudDown = false } = {}) {
    if (inFlight) return 'IN_FLIGHT';
    if (!tab.cart.length) return 'EMPTY';
    inFlight = true;
    const billId = tab.checkoutAttemptId || `BILL-${store.size + 1}`;
    tab = { ...tab, checkoutAttemptId: billId };
    if (failLocal) { inFlight = false; return 'LOCAL_FAILED'; }       // returns BEFORE any reset
    if (!store.has(billId)) store.set(billId, { billId, lines: tab.cart.map((l) => ({ ...l })) });
    const step = (label, fn) => [label, () => { if (throwing.includes(label)) throw new Error(`${label} broke`); fn(); }];
    const failures = H.vhcFinishCommittedCheckout(billId, [
      step('cloud sync dispatch', () => { if (cloudDown) throw new TypeError('Failed to fetch'); queued.push(billId); }),
      step('reprint reference', () => { tab = { ...tab, lastBillId: billId, lastBillSnapshot: { billId, cart: tab.cart } }; }),
      step('inventory repaint', () => {}),
      step('activity log', () => {}),
      step('success toast', () => {}),
    ], () => { tab = H.vhcTabResetForNewBill(tab); persisted.tabs = JSON.parse(JSON.stringify({ tabs: [tab], activeTabId: tab.id })); inFlight = false; });
    return { billId, failures };
  }
  return { store, queued, persisted, checkout, get tab() { return tab; }, set tab(t) { tab = t; } };
}
const isCleanBill = (t) => {
  const fresh = H.vhcMakeEmptyTab(t.id);
  for (const k of Object.keys(fresh)) {
    if (k === 'id' || k === 'lastBillId' || k === 'lastBillSnapshot') continue;
    assert.deepStrictEqual(t[k], fresh[k], `field ${k} must be reset`);
  }
  return true;
};

console.log('Cart reset after a committed sale');
check('A. successful checkout -> cart empty and every current-order field reset', () => {
  const c = makeCounter(); const r = c.checkout();
  assert.strictEqual(c.store.size, 1); assert.deepStrictEqual(r.failures, []);
  assert.ok(isCleanBill(c.tab));
  assert.strictEqual(c.tab.lastBillId, r.billId, 'reprint reference kept');
});
for (const [id, label] of [['B', 'activity log'], ['C', 'reprint reference'], ['D', 'inventory repaint'], ['E', 'success toast']]) {
  check(`${id}. ${label} failure -> cart still empty, exactly one sale`, () => {
    const c = makeCounter(); const r = c.checkout({ throwing: [label] });
    assert.deepStrictEqual(r.failures, [label]);
    assert.strictEqual(c.store.size, 1);
    assert.ok(isCleanBill(c.tab));
  });
}
check('E2. every non-critical step failing at once -> cart still empty, one sale', () => {
  const c = makeCounter(); const r = c.checkout({ throwing: ['cloud sync dispatch', 'reprint reference', 'inventory repaint', 'activity log', 'success toast'] });
  assert.strictEqual(r.failures.length, 5); assert.strictEqual(c.store.size, 1); assert.ok(isCleanBill(c.tab));
});
check('F. cloud sync unavailable after local commit -> cart empty, one sale (stays queued in SQLite)', () => {
  const c = makeCounter(); c.checkout({ cloudDown: true });
  assert.strictEqual(c.store.size, 1); assert.ok(isCleanBill(c.tab));
});
check('G. repeated F8 / double click -> one sale, cart empty; a late repeat finds an empty cart', () => {
  const c = makeCounter();
  const first = c.checkout();
  assert.strictEqual(c.checkout(), 'EMPTY', 'second submit after completion has nothing to bill');
  assert.strictEqual(c.store.size, 1); assert.ok(isCleanBill(c.tab)); assert.ok(first.billId);
});
check('G2. a repeat that reuses the SAME attempt id (before the reset rendered) is idempotent', () => {
  const c = makeCounter();
  c.tab = { ...c.tab, checkoutAttemptId: 'BILL-FIXED' };
  c.checkout();
  c.tab = { ...c.tab, cart: [{ id: 'b1', qty: 10 }], checkoutAttemptId: 'BILL-FIXED' };   // stale closure replay
  c.checkout();
  assert.strictEqual(c.store.size, 1, 'same bill id -> no second sale'); assert.ok(isCleanBill(c.tab));
});
check('H. local sale commit fails -> cart remains populated and the attempt id is kept for retry', () => {
  const c = makeCounter();
  assert.strictEqual(c.checkout({ failLocal: true }), 'LOCAL_FAILED');
  assert.strictEqual(c.store.size, 0);
  assert.strictEqual(c.tab.cart.length, 1); assert.ok(c.tab.checkoutAttemptId);
  const retry = c.checkout();
  assert.strictEqual(c.store.size, 1); assert.ok(isCleanBill(c.tab)); assert.ok(retry.billId);
});
check('I. navigate away/back: the restored state is the RESET bill; a restored completed attempt is reset', () => {
  const c = makeCounter(); c.checkout();
  assert.strictEqual(c.persisted.tabs.tabs[0].cart.length, 0, 'persisted copy is the empty bill');
  // crash/full-storage case: an older saved copy still holds the cart + its committed attempt id
  const stale = { activeTabId: 'tab_1', tabs: [{ ...H.vhcMakeEmptyTab('tab_1'), cart: [{ id: 'b1', qty: 10 }], checkoutAttemptId: 'BILL-1' },
    { ...H.vhcMakeEmptyTab('tab_2'), cart: [{ id: 'b9', qty: 2 }], checkoutAttemptId: 'BILL-NOT-COMMITTED' }] };
  const restored = H.vhcResetCompletedTabs(stale, (id) => c.store.has(id));
  assert.ok(isCleanBill(restored.tabs[0]), 'billed cart does not rehydrate');
  assert.strictEqual(restored.tabs[1].cart.length, 1, 'an uncommitted draft is kept for retry');
  assert.strictEqual(H.vhcResetCompletedTabs(restored, () => false), restored, 'nothing to reset -> same state object');
});
check('J. next bill starts fully clean and gets a NEW bill id', () => {
  const c = makeCounter(); const first = c.checkout();
  c.tab = { ...c.tab, cart: [{ id: 'b2', name: 'Other', qty: 1 }], paymentMode: 'UPI' };
  assert.strictEqual(c.tab.cashReceived, ''); assert.deepStrictEqual(c.tab.customCharges, []); assert.strictEqual(c.tab.patientName, '');
  const second = c.checkout();
  assert.notStrictEqual(second.billId, first.billId); assert.strictEqual(c.store.size, 2);
  assert.deepStrictEqual(c.store.get(second.billId).lines.map((l) => l.id), ['b2'], 'no carry-over from the previous bill');
});
check('reset still runs if a step throws a non-Error value and failures are reported', () => {
  let reset = 0;
  const f = H.vhcFinishCommittedCheckout('BILL-X', [['weird', () => { throw 'string'; }], ['ok', () => {}]], () => { reset++; });
  assert.strictEqual(reset, 1); assert.deepStrictEqual(f, ['weird']);
});

console.log('Wiring in the real checkout function');
check('success path uses vhcFinishCommittedCheckout with the reset in its reset callback', () => {
  assert.match(oe, /vhcFinishCommittedCheckout\(m, \[/);
  for (const label of ['cloud sync dispatch', 'reprint reference', 'inventory repaint', 'activity log', 'success toast']) assert.ok(oe.includes(`[\`${label}\``), label);
  assert.match(oe, /\], \(\) => \{\s*N\(checkoutTabId\);\s*checkoutInFlight\.current = false;\s*\}\);\s*return m;/);
  assert.doesNotMatch(oe, /return \(\s*re\(m\),/, 'the old comma-expression success path is gone');
});
check('H wiring: every local-commit failure returns BEFORE the post-commit reset', () => {
  const finishAt = oe.indexOf('vhcFinishCommittedCheckout(m, [');
  const createAt = oe.indexOf('window.electronAPI.createLocalSale({');
  assert.ok(createAt > 0 && finishAt > createAt);
  const between = oe.slice(createAt, finishAt).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok((between.match(/checkoutInFlight\.current = false;\s*return null;/g) || []).length >= 3, 'rejected, failed and thrown local commits all return null');
  assert.ok(!/\bN\(/.test(between), 'no reset before the commit succeeded');
});
check('exactly-once protections preserved (in-flight lock + stable attempt id persisted before save)', () => {
  assert.match(oe, /if \(checkoutInFlight\.current\) \{/);
  assert.match(oe, /let m = activeTab\.checkoutAttemptId \|\| `BILL-\$\{Date\.now\(\)\}`;/);
  assert.match(oe, /localStorage\.setItem\(`pos_billing_tabs`, JSON\.stringify\(attemptTabsState\)\)/);
});
check('persistence failure never leaves an older copy of the tabs or cart behind', () => {
  assert.match(bundle, /localStorage\.setItem\(`pos_billing_tabs`, JSON\.stringify\(tabsState\)\);\s*\} catch \{[\s\S]{0,260}localStorage\.removeItem\(`pos_billing_tabs`\)/);
  assert.match(bundle, /localStorage\.setItem\(`pos_active_cart`, JSON\.stringify\(o\)\);\s*\} catch \{\s*try \{ localStorage\.removeItem\(`pos_active_cart`\); \} catch \{\}/);
});
check('restart guard resets tabs whose attempt id is already a local sale', () => {
  assert.match(bundle, /window\.electronAPI\.getLocalSale\(id\)\)\.then\(\(sale\) => \(sale \? id : null\)\)/);
  assert.match(bundle, /setTabsState\(\(prev\) => vhcResetCompletedTabs\(prev, \(id\) => done\.has\(id\)\)\)/);
});
check('activity log can no longer throw into the caller', () => {
  assert.match(bundle, /try \{ localStorage\.setItem\(`pos_audit_logs`, JSON\.stringify\(n\)\); \} catch \(err\)/);
  assert.doesNotMatch(bundle, /\(s\(n\), localStorage\.setItem\(`pos_audit_logs`/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
