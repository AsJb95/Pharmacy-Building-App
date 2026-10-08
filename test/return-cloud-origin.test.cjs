#!/usr/bin/env node
// Focused fixtures for the Return/Exchange execution path origin split (v3.18.3).
//
// Covers two things that must stay true together:
//   1. The EXISTING local-origin return path is untouched: partial-return limits,
//      stock restored exactly once, duplicate/idempotency protection, refund/credit audit.
//   2. A cloud/history-only bill (no local sale row) is REJECTED with zero mutation —
//      no stock movement, no stock change, no return/refund/credit rows. It must never be
//      half-executed, and the renderer must not route it into the local path at all.
//
// Everything runs against a throwaway temp SQLite file. No production contact, no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const Database = require('better-sqlite3');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhc-return-origin-'));
const dbPath = path.join(tmpDir, 'returns.db');

function raw(fn) {
  const h = new Database(dbPath, { readonly: true });
  try { return fn(h); } finally { h.close(); }
}
function qty(batchNo) {
  return raw((h) => h.prepare('SELECT qty FROM stock_batches WHERE batch_no = ?').get(batchNo).qty);
}
function counts() {
  return raw((h) => {
    const one = (sql) => { try { return h.prepare(sql).get().c; } catch { return 0; } };
    return {
      returns: one('SELECT COUNT(*) c FROM sale_returns'),
      returnItems: one('SELECT COUNT(*) c FROM sale_return_items'),
      refunds: one('SELECT COUNT(*) c FROM sale_refunds'),
      credits: one('SELECT COUNT(*) c FROM sale_return_credits'),
      movements: one('SELECT COUNT(*) c FROM stock_movements'),
      stockSum: (() => { try { return h.prepare('SELECT COALESCE(SUM(qty),0) c FROM stock_batches').get().c; } catch { return 0; } })(),
    };
  });
}
const cartItem = (o = {}) => ({
  name: 'Amoxicillin 500mg', category: 'Medicine', batch: 'AMX-1', expiry: '2027-01-01',
  mrp: 100, unitsPerPack: 10, gst: 12, stockist: 'Test Stockist', qty: 3, stock: 50, ...o,
});

// ── Renderer-side origin detection + submit gate (mirrors SaleReturnModal in the bundle) ──
function resolveOrigin({ local, cloudRows, bill }) {
  const billKey = String(bill.billId || bill.bill_id || bill.id || '');
  if (local && Array.isArray(local.sale_items) && local.sale_items.length) return 'local';
  const matchesBill = (r) => r && String(r.bill_id || r.billId || r.id || r.server_id || '') === billKey;
  const cloud = (cloudRows || []).find(matchesBill) || null;
  const resolvedCloud = cloud && Array.isArray(cloud.sale_items) && cloud.sale_items.length ? cloud : null;
  const resolvedLocal = local && Array.isArray(local.sale_items) && local.sale_items.length ? local : null;
  return resolvedCloud ? 'cloud' : resolvedLocal ? 'local' : 'unresolved';
}
// Returns whether the local execution IPC would be invoked.
function submitWouldExecuteLocally(origin) { return origin === 'local'; }

// Mirrors SaleReturnModal.submit()'s routing after the cloud RPC was wired in: a local-origin
// bill still goes to the local IPC, a cloud-origin bill goes to create_sale_return, and an
// unresolved bill goes nowhere. `attempt` is the component's cloudAttemptRef.
async function routeSubmit({ origin, bill, lines, attempt, localIpc, cloudRpc, hasCloud = true }) {
  const notes = [];
  const notify = (m, kind) => notes.push({ kind, m });
  if (origin !== 'local' && origin !== 'cloud') {
    notify('unresolved', 'error');
    return { calledLocal: false, calledCloud: false, notes, attempt };
  }
  if (origin === 'cloud') {
    const cloudBillId = String(bill.billId || bill.bill_id || bill.id || '');
    if (!hasCloud) { notify('cloud-unavailable', 'error'); return { calledLocal: false, calledCloud: false, notes, attempt }; }
    const sig = JSON.stringify(lines);
    if (!attempt || attempt.sig !== sig) attempt = { sig, id: 'uuid-' + (routeSubmit._n = (routeSubmit._n || 0) + 1) };
    let res;
    try { res = await cloudRpc({ returnId: attempt.id, billId: cloudBillId, items: lines, reason: 'Sale return stock restoration' }); }
    catch (e) { notify('rpc-threw:' + e.message, 'error'); return { calledLocal: false, calledCloud: true, notes, attempt }; }
    if (!res || res.status === 'RPC_MISSING') { notify('rpc-missing', 'error'); return { calledLocal: false, calledCloud: true, notes, attempt }; }
    attempt = null;
    notify(res.status === 'ALREADY_APPLIED' ? 'already' : 'applied', 'success');
    return { calledLocal: false, calledCloud: true, notes, attempt, res };
  }
  const result = await localIpc({ billId: bill.billId, items: lines });
  if (!result || !result.success) { notify('local-failed', 'error'); return { calledLocal: true, calledCloud: false, notes, attempt }; }
  notify('applied', 'success');
  return { calledLocal: true, calledCloud: false, notes, attempt };
}

(async () => {
  const dbmod = await import(pathToFileURL(path.join(__dirname, '..', 'electron', 'database.js')).href);
  const { initDatabase, createLocalSale, createLocalSaleReturn, getLocalSaleByBillId, closeDatabase } = dbmod;
  initDatabase(dbPath);

  // ── Fixture 1: a real local-origin Cash sale ──
  const localBill = 'BILL-LOCAL-ORIGIN-1';
  const made = createLocalSale({
    billId: localBill, patientSnapshot: { name: 'Alice', contact: '9000000001' },
    paymentMode: 'Cash', subtotal: 30, totalTax: 0, totalAmount: 30, gstMode: 'regular',
    discount: 0, discountPercent: 0,
    paymentDetails: { breakdown: { Cash: 30 }, amountReceived: 30, outstandingAmount: 0, status: 'Paid' },
    items: [cartItem()], extraParticulars: [],
  });
  assert.strictEqual(made.success, true, 'fixture sale must commit: ' + JSON.stringify(made));
  const localSale = getLocalSaleByBillId(localBill);
  const soldLine = localSale.sale_items.find((l) => l.affects_stock === 1);
  const unit = Number(soldLine.total) / Number(soldLine.quantity);

  console.log('=== 1. Local-origin return execution (existing path, must be preserved) ===');
  check('L1 fixture sale deducted stock (50 - 3 = 47)', () => assert.strictEqual(qty('AMX-1'), 47));

  const r1 = 'RET-LOCAL-1';
  let res1;
  check('L2 partial return of 1 of 3 succeeds', () => {
    res1 = createLocalSaleReturn({ id: r1, billId: localBill, items: [{ saleItemId: soldLine.id, quantity: 1 }] });
    assert.strictEqual(res1.success, true, JSON.stringify(res1));
    assert.strictEqual(res1.duplicate, false);
  });
  check('L3 stock restored exactly once (47 + 1 = 48)', () => assert.strictEqual(qty('AMX-1'), 48));
  check('L4 refund audit row written for a Cash bill (amount = unit x 1, method Cash)', () => {
    const ref = raw((h) => h.prepare('SELECT * FROM sale_refunds WHERE return_id = ?').get(r1));
    assert.ok(ref, 'a refund row must exist');
    assert.strictEqual(ref.method, 'Cash');
    assert.ok(Math.abs(ref.amount - unit) < 0.005, 'refund ' + ref.amount + ' should equal unit ' + unit);
  });
  check('L5 return + return-item audit rows bind to the original bill identity', () => {
    const hdr = raw((h) => h.prepare('SELECT * FROM sale_returns WHERE id = ?').get(r1));
    assert.strictEqual(hdr.bill_id, localBill);
    assert.strictEqual(hdr.sale_id, localSale.id);
    assert.strictEqual(hdr.status, 'COMPLETED');
    const li = raw((h) => h.prepare('SELECT * FROM sale_return_items WHERE return_id = ?').all(r1));
    assert.strictEqual(li.length, 1);
    assert.strictEqual(li[0].sale_item_id, soldLine.id);
    assert.strictEqual(li[0].quantity, 1);
    assert.ok(li[0].restoration_movement_id, 'restoration movement must be linked');
  });
  check('L6 a RETURN stock movement was recorded for the restoration', () => {
    const mv = raw((h) => h.prepare("SELECT * FROM stock_movements WHERE type = 'RETURN' AND bill_id = ?").all(localBill));
    assert.strictEqual(mv.length, 1);
    assert.strictEqual(mv[0].qty, 1);
    assert.strictEqual(mv[0].closing, 48);
  });

  check('L7 DUPLICATE protection: replaying the same return id is a no-op (stock stays 48)', () => {
    const before = counts();
    const dup = createLocalSaleReturn({ id: r1, billId: localBill, items: [{ saleItemId: soldLine.id, quantity: 1 }] });
    assert.strictEqual(dup.success, true);
    assert.strictEqual(dup.duplicate, true, 'must be flagged duplicate, not re-applied');
    assert.strictEqual(qty('AMX-1'), 48, 'stock must NOT be restored twice');
    assert.deepStrictEqual(counts(), before, 'no new audit rows on a duplicate');
  });

  check('L8 PARTIAL-RETURN protection: 1 already returned + 3 more > 3 sold is rejected, nothing changes', () => {
    const before = counts();
    const over = createLocalSaleReturn({ id: 'RET-LOCAL-OVER', billId: localBill, items: [{ saleItemId: soldLine.id, quantity: 3 }] });
    assert.strictEqual(over.success, false);
    assert.strictEqual(over.rejected, true);
    assert.ok(/exceeds sold quantity/i.test(over.error), over.error);
    assert.strictEqual(qty('AMX-1'), 48, 'rejected return must not restore stock');
    assert.deepStrictEqual(counts(), before, 'rejected return must write no audit rows');
  });

  check('L9 returning the remaining 2 succeeds and lands exactly on the sold quantity (stock 50)', () => {
    const rest = createLocalSaleReturn({ id: 'RET-LOCAL-2', billId: localBill, items: [{ saleItemId: soldLine.id, quantity: 2 }] });
    assert.strictEqual(rest.success, true, JSON.stringify(rest));
    assert.strictEqual(qty('AMX-1'), 50);
  });
  check('L10 a further return beyond the fully-returned quantity is rejected', () => {
    const before = counts();
    const extra = createLocalSaleReturn({ id: 'RET-LOCAL-3', billId: localBill, items: [{ saleItemId: soldLine.id, quantity: 1 }] });
    assert.strictEqual(extra.success, false);
    assert.strictEqual(qty('AMX-1'), 50);
    assert.deepStrictEqual(counts(), before);
  });

  console.log('=== 2. Credit-bill return adjusts credit instead of refunding cash ===');
  const creditBill = 'BILL-LOCAL-CREDIT-1';
  const madeCredit = createLocalSale({
    billId: creditBill, patientSnapshot: { name: 'Bob', contact: '9000000002' },
    paymentMode: 'Credit', subtotal: 20, totalTax: 0, totalAmount: 20, gstMode: 'regular',
    discount: 0, discountPercent: 0,
    paymentDetails: { breakdown: { credit: 20 }, amountReceived: 0, outstandingAmount: 20, status: 'Credit' },
    items: [cartItem({ batch: 'AMX-2', qty: 2, stock: 20 })], extraParticulars: [],
  });
  assert.strictEqual(madeCredit.success, true, JSON.stringify(madeCredit));
  const creditSale = getLocalSaleByBillId(creditBill);
  const creditLine = creditSale.sale_items.find((l) => l.affects_stock === 1);
  check('C1 credit-bill return records a return credit and no cash refund', () => {
    const res = createLocalSaleReturn({ id: 'RET-CREDIT-1', billId: creditBill, items: [{ saleItemId: creditLine.id, quantity: 1 }] });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.ok(res.return.creditApplied > 0, 'credit should absorb the return value');
    assert.strictEqual(res.return.refundAmount, 0, 'no cash refund while credit is outstanding');
    const cr = raw((h) => h.prepare('SELECT * FROM sale_return_credits WHERE return_id = ?').get('RET-CREDIT-1'));
    assert.ok(cr, 'a credit audit row must exist');
    const ref = raw((h) => h.prepare('SELECT * FROM sale_refunds WHERE return_id = ?').get('RET-CREDIT-1'));
    assert.ok(!ref, 'no refund row should exist for a fully-credit-absorbed return');
  });
  check('C2 credit-bill return still restored stock exactly once', () => assert.strictEqual(qty('AMX-2'), 19));

  console.log('=== 3. Cloud / history-only bill: rejected with ZERO mutation ===');
  const cloudBill = 'BILL-1791268086115'; // the known history-only bill from manual QA
  check('H1 no local sale row exists for the history-only bill', () => {
    assert.strictEqual(getLocalSaleByBillId(cloudBill), null);
  });
  check('H2 local execution refuses a history-only bill and mutates NOTHING', () => {
    const before = counts();
    const res = createLocalSaleReturn({ id: 'RET-CLOUD-1', billId: cloudBill, items: [{ saleItemId: 'cloud-uuid-item-a', quantity: 1 }] });
    assert.strictEqual(res.success, false, 'must not report success');
    assert.strictEqual(res.rejected, true);
    assert.ok(/Completed local sale not found/i.test(res.error), res.error);
    assert.deepStrictEqual(counts(), before, 'no stock, movement, return, refund or credit change');
  });
  check('H3 replaying the refused history-only return stays a clean no-op', () => {
    const before = counts();
    const res = createLocalSaleReturn({ id: 'RET-CLOUD-1', billId: cloudBill, items: [{ saleItemId: 'cloud-uuid-item-a', quantity: 1 }] });
    assert.strictEqual(res.success, false);
    assert.deepStrictEqual(counts(), before);
  });

  console.log('=== 4. Renderer origin detection + submit gate ===');
  check('R1 a bill with local sale_items is detected as local-origin and DOES execute locally', () => {
    const origin = resolveOrigin({ bill: { billId: localBill }, local: { id: 1, sale_items: [{ id: 'si-1', quantity: 3, total: 30, affects_stock: 1 }] }, cloudRows: [] });
    assert.strictEqual(origin, 'local');
    assert.strictEqual(submitWouldExecuteLocally(origin), true);
  });
  check('R2 a history-only cloud bill is detected as cloud-origin and does NOT reach the local path', () => {
    const origin = resolveOrigin({
      bill: { billId: cloudBill }, local: { sale_items: [] },
      cloudRows: [{ id: 'uuid-sale-999', bill_id: cloudBill, sale_items: [{ id: 'cloud-uuid-item-a', quantity: 3, total: 45, affects_stock: true }] }],
    });
    assert.strictEqual(origin, 'cloud');
    assert.strictEqual(submitWouldExecuteLocally(origin), false, 'cloud bill must be blocked before any local write');
  });
  check('R3 an unresolvable bill (particulars-only display fallback) also does NOT execute', () => {
    const origin = resolveOrigin({ bill: { billId: 'BILL-NODATA', particulars: [{ drugName: 'X', quantity: 1, total: 5 }] }, local: { sale_items: [] }, cloudRows: [] });
    assert.strictEqual(origin, 'unresolved');
    assert.strictEqual(submitWouldExecuteLocally(origin), false);
  });
  check('R4 a locally-billed sale is still local-origin even when the cloud also has the row', () => {
    const origin = resolveOrigin({
      bill: { billId: localBill },
      local: { id: 1, sale_items: [{ id: 'si-1', quantity: 3, total: 30, affects_stock: 1 }] },
      cloudRows: [{ id: 'uuid-x', bill_id: localBill, sale_items: [{ id: 'cloud-1', quantity: 3, total: 30, affects_stock: true }] }],
    });
    assert.strictEqual(origin, 'local', 'local must win so the existing path is used unchanged');
    assert.strictEqual(submitWouldExecuteLocally(origin), true);
  });

  console.log('=== 5. Confirm-path routing after the cloud RPC was wired ===');
  const lines1 = [{ saleItemId: 'cloud-uuid-item-a', quantity: 1 }];
  const mk = () => { const calls = []; return [calls, async (p) => { calls.push(p); return { status: 'APPLIED', refund_amount: 10, credit_amount: 0 }; }]; };

  await (async () => {
    const [rpcCalls, rpc] = mk();
    const ipcCalls = [];
    const r = await routeSubmit({ origin: 'local', bill: { billId: localBill }, lines: lines1, attempt: null,
      localIpc: async (p) => { ipcCalls.push(p); return { success: true }; }, cloudRpc: rpc });
    check('W1 a local-origin bill still goes to the local IPC and never to the RPC', () => {
      assert.strictEqual(r.calledLocal, true); assert.strictEqual(r.calledCloud, false);
      assert.strictEqual(ipcCalls.length, 1); assert.strictEqual(rpcCalls.length, 0);
    });
  })();

  await (async () => {
    const [rpcCalls, rpc] = mk();
    const ipcCalls = [];
    const r = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: lines1, attempt: null,
      localIpc: async (p) => { ipcCalls.push(p); return { success: true }; }, cloudRpc: rpc });
    check('W2 a cloud-origin bill goes to create_sale_return and never to the local IPC', () => {
      assert.strictEqual(r.calledCloud, true); assert.strictEqual(r.calledLocal, false);
      assert.strictEqual(ipcCalls.length, 0); assert.strictEqual(rpcCalls.length, 1);
      assert.strictEqual(rpcCalls[0].billId, cloudBill);
      assert.deepStrictEqual(rpcCalls[0].items, lines1);
      assert.ok(rpcCalls[0].returnId, 'a return id must be supplied as the idempotency key');
    });
  })();

  await (async () => {
    // A transient failure must reuse the SAME return id, so the retry replays rather than
    // creating a second return; changing the selection must mint a NEW id.
    const seen = [];
    let fail = true;
    const rpc = async (p) => { seen.push(p.returnId); if (fail) { fail = false; throw new Error('network'); } return { status: 'ALREADY_APPLIED', refund_amount: 10, credit_amount: 0 }; };
    let attempt = null;
    let r = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: lines1, attempt, localIpc: async () => ({ success: true }), cloudRpc: rpc });
    attempt = r.attempt;
    r = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: lines1, attempt, localIpc: async () => ({ success: true }), cloudRpc: rpc });
    check('W3 a retry of the same selection reuses the return id (idempotent replay)', () => {
      assert.strictEqual(seen.length, 2);
      assert.strictEqual(seen[0], seen[1], 'retry must reuse the id so the RPC can replay it');
      assert.strictEqual(r.notes[0].m, 'already');
      assert.strictEqual(r.attempt, null, 'a settled attempt must be cleared');
    });
    const r2 = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: [{ saleItemId: 'cloud-uuid-item-a', quantity: 2 }], attempt: { sig: JSON.stringify(lines1), id: seen[0] }, localIpc: async () => ({ success: true }), cloudRpc: rpc });
    check('W4 changing the selection mints a NEW return id (not a blocked replay)', () => {
      assert.notStrictEqual(seen[2], seen[0]);
      assert.strictEqual(r2.calledCloud, true);
    });
  })();

  await (async () => {
    const ipcCalls = [];
    const r = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: lines1, attempt: null,
      localIpc: async (p) => { ipcCalls.push(p); return { success: true }; },
      cloudRpc: async () => ({ status: 'RPC_MISSING', error: 'Could not find the function' }) });
    check('W5 an un-migrated database falls back to a clean refusal and writes nothing', () => {
      assert.strictEqual(r.notes[0].kind, 'error');
      assert.strictEqual(r.notes[0].m, 'rpc-missing');
      assert.strictEqual(ipcCalls.length, 0, 'must NOT fall back to the local path');
    });
  })();

  await (async () => {
    const ipcCalls = [];
    const r = await routeSubmit({ origin: 'cloud', bill: { billId: cloudBill }, lines: lines1, attempt: null, hasCloud: false,
      localIpc: async (p) => { ipcCalls.push(p); return { success: true }; }, cloudRpc: async () => ({ status: 'APPLIED' }) });
    check('W6 with Cloud Sync unavailable nothing is attempted at all', () => {
      assert.strictEqual(r.calledCloud, false); assert.strictEqual(r.calledLocal, false);
      assert.strictEqual(ipcCalls.length, 0);
    });
  })();

  await (async () => {
    const ipcCalls = [];
    const [rpcCalls, rpc] = mk();
    const r = await routeSubmit({ origin: 'unresolved', bill: { billId: 'BILL-NODATA' }, lines: lines1, attempt: null,
      localIpc: async (p) => { ipcCalls.push(p); return { success: true }; }, cloudRpc: rpc });
    check('W7 an unresolved bill reaches neither execution path', () => {
      assert.strictEqual(ipcCalls.length, 0); assert.strictEqual(rpcCalls.length, 0);
      assert.strictEqual(r.notes[0].kind, 'error');
    });
  })();

  check('W8 the shipped bundle routes cloud origin to create_sale_return and keeps the local IPC', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
    assert.ok(bundle.includes('window.VHC_CLOUD.createSaleReturn'), 'renderer must call createSaleReturn');
    assert.ok(bundle.includes('createLocalSaleReturn'), 'local IPC path must still exist');
    assert.ok(bundle.includes('RPC_MISSING'), 'renderer must handle an un-migrated database');
    assert.ok(bundle.includes('cloudAttemptRef'), 'renderer must keep a retry-stable return id');
    const cloud = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-cloud-sync.js'), 'utf8');
    assert.ok(/async function createSaleReturn/.test(cloud), 'cloud bundle must define createSaleReturn');
    assert.ok(/supabase\.rpc\("create_sale_return", \{ payload \}\)/.test(cloud), 'must call the RPC by name');
    assert.ok(/assertCloudWritesAllowed\("createSaleReturn"\)/.test(cloud), 'must honour the cloud-write policy gate');
    const src = fs.readFileSync(path.join(__dirname, '..', 'cloud-src', 'vhc-cloud-sync.js'), 'utf8');
    assert.ok(/async function createSaleReturn/.test(src), 'cloud-src source must match the bundle');
  });

  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + (failed === 0 ? 'ALL RETURN-ORIGIN TESTS PASSED (' + passed + ')' : failed + ' FAILED / ' + passed + ' passed'));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.stack); process.exit(1); });
