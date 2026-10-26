#!/usr/bin/env node
'use strict';
// Stock-sync incident remediation — regression tests (no network, no real database server).
//  * Runs the REAL financial sync worker (dist/assets/vhc-audit-engine.js, vm sandbox) against the REAL local SQLite
//    layer (electron/database.js on a temp DB) and an in-memory cloud whose bulk RPC follows the SAME contract as
//    supabase/migrations/20261023000100_stock_sync_remediation.sql (proven on real PostgreSQL by
//    test/stock-sync-remediation.pg.mjs): validate every line first, any refused line -> nothing written.
//  * Executes the REAL cloud functions from BOTH cloud-src/vhc-cloud-sync.js and the shipped dist bundle.
//  * Executes the REAL inventory overlay block and review screen from dist/assets/index-doBKNLAj.js.
// Run under Electron's Node in the app repo (better-sqlite3 ABI):  set ELECTRON_RUN_AS_NODE=1 && electron test/stock-sync-remediation.test.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const ITEM = '11111111-1111-4111-8111-111111111111';
const LOC = '33333333-3333-4333-8333-333333333333';
const BATCH_A = '22222222-2222-4222-8222-00000000000a';
const BATCH_B = '22222222-2222-4222-8222-00000000000b';
const BATCH_NEW = '22222222-2222-4222-8222-00000000000c';
let seq = 0;
const uuid = () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++seq).padStart(12, '0')}`;

// ─── In-memory cloud: bulk RPC with the migration's all-or-nothing contract ─────────────────────────────
function makeCloud() {
  const sales = new Map();
  const movements = new Map();      // movement_key -> { bill_id, qty, batch }
  const batches = new Map();        // batch id -> { qty, batch_no }
  const deletedBills = new Set();
  const calls = { bulk: 0, legacy: 0, create: 0, find: 0 };
  const state = { mode: 'apply', admin: false };
  function bulk(payload) {
    calls.bulk += 1;
    if (state.mode === 'missing') return { status: 'RPC_MISSING' };
    if (state.mode === 'network') throw new TypeError('Failed to fetch');
    if (payload.allow_identity_fallback && !state.admin) return { status: 'NOT_PERMITTED', reason: 'only an admin may apply a deduction to the current batch' };
    if (deletedBills.has(payload.bill_id)) return { status: 'CONFLICT', conflict: 'CONFLICT_BILL_DELETED', applied: 0, lines: [] };
    const running = new Map();
    const lines = payload.movements.map((m) => {
      let id = m.stock_batch_id;
      let fallback = false;
      if (!batches.has(id)) {
        const same = payload.allow_identity_fallback
          ? [...batches.entries()].filter(([, b]) => String(b.batch_no).toLowerCase() === String(m.batch_no || '').toLowerCase()) : [];
        if (same.length !== 1) return { movement_key: m.movement_key, status: 'CONFLICT_BATCH_NOT_FOUND', stock_batch_id: m.stock_batch_id };
        id = same[0][0]; fallback = true;
      }
      const existing = movements.get(m.movement_key);
      if (existing) {
        const same = existing.bill_id === payload.bill_id && Math.abs(existing.qty - m.quantity_delta) < 0.0005;
        return { movement_key: m.movement_key, status: same ? 'ALREADY_APPLIED' : 'CONFLICT_MOVEMENT_MISMATCH', stock_batch_id: id, existing_bill_id: existing.bill_id };
      }
      const open = running.has(id) ? running.get(id) : batches.get(id).qty;
      if (open + m.quantity_delta < -0.0005) return { movement_key: m.movement_key, status: 'CONFLICT_INSUFFICIENT_STOCK', stock_batch_id: id, actual_opening: open, requested_qty: m.quantity_delta };
      running.set(id, open + m.quantity_delta);
      return { movement_key: m.movement_key, status: 'PENDING', stock_batch_id: id, opening: open, closing: open + m.quantity_delta, qty: m.quantity_delta, fallback };
    });
    const conflict = lines.map((l) => l.status).filter((s) => s.startsWith('CONFLICT_')).sort()[0];
    if (conflict) return { status: 'CONFLICT', conflict, applied: 0, lines };
    const pending = lines.filter((l) => l.status === 'PENDING');
    if (!pending.length) return { status: 'ALREADY_APPLIED', applied: 0, lines };
    for (const l of pending) {
      batches.get(l.stock_batch_id).qty = l.closing;
      movements.set(l.movement_key, { bill_id: payload.bill_id, qty: l.qty, batch: l.stock_batch_id });
      l.status = 'APPLIED';
    }
    const result = { status: 'APPLIED', applied: pending.length, lines };
    if (state.mode === 'lose-response') throw new TypeError('Failed to fetch'); // committed, reply lost
    return result;
  }
  const api = {
    async applyBillStockMovementsStrict(payload) { return bulk(JSON.parse(JSON.stringify(payload))); },
    async findStockMovementsByKeysStrict(keys) {
      return keys.filter((k) => movements.has(k)).map((k) => ({ movement_key: k, bill_id: movements.get(k).bill_id, qty: movements.get(k).qty }));
    },
    // older single-line contract (used only when the bulk RPC is missing)
    async applyBillStockMovementStrict(p) {
      calls.legacy += 1;
      if (movements.has(p.movement_key)) return { status: 'ALREADY_APPLIED' };
      const b = batches.get(p.stock_batch_id);
      if (!b) return { status: 'CONFLICT_BATCH_NOT_FOUND' };
      if (b.qty + p.quantity_delta < -0.0005) return { status: 'CONFLICT_INSUFFICIENT_STOCK', actual_opening: b.qty };
      b.qty += p.quantity_delta;
      movements.set(p.movement_key, { bill_id: p.bill_id, qty: p.quantity_delta, batch: p.stock_batch_id });
      return { status: 'APPLIED' };
    },
    async reconcileStockMovementStrict() { throw new Error('legacy absolute path must not be used'); },
    async findStockMovementByKeyStrict(k) { return movements.has(k) ? { movement_key: k, bill_id: movements.get(k).bill_id, qty: movements.get(k).qty } : null; },
    async findSaleByBillIdStrict(billId) { calls.find += 1; const r = sales.get(billId); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async createSaleStrict(payload) {
      calls.create += 1;
      const row = sales.get(payload.billId) || { id: uuid(), bill_id: payload.billId, sale_items: [] };
      Object.assign(row, { total_amount: String(payload.totalAmount), amount_received: payload.amountReceived, outstanding_amount: payload.outstandingAmount, payment_status: payload.paymentStatus });
      payload.items.forEach((it, i) => { if (!row.sale_items[i]) row.sale_items[i] = { id: uuid(), drug_name: it.drugName, quantity: `${Number(it.quantity).toFixed(3)}`, total: `${Number(it.total).toFixed(2)}` }; });
      sales.set(payload.billId, row);
      return { id: row.id };
    },
    async fetchInventory() { return []; },
    async getSession() { return { user: { id: 'u-1', email: 'counter@example.invalid' } }; },
    async isCurrentUserAdmin() { return state.admin; },
    describeCloudError(e) { return { code: e && e.code || null, message: e && e.message ? e.message : String(e), details: null, hint: null }; },
  };
  return { api, sales, movements, batches, deletedBills, calls, state, qty: (id) => batches.get(id) && batches.get(id).qty };
}

function loadWorker(db, cloud) {
  const window = {
    electronAPI: {
      getLocalSale: async (b) => db.getLocalSaleByBillId(b),
      markFinancialSyncAttempt: async (b, e) => db.markFinancialSyncAttempt(b, e),
      markFinancialSyncConfirmed: async (b, id) => db.markFinancialSyncConfirmed(b, id),
      markFinancialSyncSaleConfirmed: async (b, id) => db.markFinancialSyncSaleConfirmed(b, id),
      markFinancialSyncStockPending: async (b, e) => db.markFinancialSyncStockPending(b, e),
      markFinancialSyncReviewRequired: async (b, s, d, id) => db.markFinancialSyncReviewRequired(b, s, d, id),
      getUnsyncedFinancialSyncOperations: async () => db.getUnsyncedFinancialSyncOperations(),
      getFinancialSyncReviewItems: async () => db.getFinancialSyncReviewItems(),
      markFinancialSyncReviewResolved: async (b, o) => db.markFinancialSyncReviewResolved(b, o),
      markFinancialSyncReviewAcknowledged: async (b, o) => db.markFinancialSyncReviewAcknowledged(b, o),
    },
    VHC_CLOUD: cloud.api,
    addEventListener() {}, dispatchEvent() { return true; },
  };
  const store = new Map();
  const sandbox = {
    window, console: { log() {}, warn() {}, error() {} },
    document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { onLine: true },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'dist', 'assets', 'vhc-runtime-policy.js'), 'utf8'), sandbox);
  window.VHC_RUNTIME_POLICY = sandbox.VHC_RUNTIME_POLICY || window.VHC_RUNTIME_POLICY;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8'), sandbox);
  const sync = window.VHC_FINANCIAL_SYNC;
  return {
    sync,
    async runOnce() {
      const out = [];
      for (const op of db.getUnsyncedFinancialSyncOperations()) out.push(await sync._syncOneFinancialOperation(op));
      return out;
    },
  };
}

let db;
async function freshDb() {
  if (db.closeDatabase) try { db.closeDatabase(); } catch (e) {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhc-stock-sync-'));
  db.initDatabase(path.join(dir, 'vhc_pharmacy.db'));
}
// lines: [{ batchId, qty, batch }]
function newBill(prefix, lines) {
  const billId = `${prefix}-${Date.now()}-${++seq}`;
  const total = lines.reduce((s, l) => s + 10 * l.qty, 0);
  const res = db.createLocalSale({
    billId, patientSnapshot: { name: 'Stock Sync Test' }, paymentMode: 'Cash', totalAmount: total,
    paymentDetails: { breakdown: { Cash: total }, amountReceived: total, outstandingAmount: 0, status: 'Paid' },
    items: lines.map((l, i) => ({ name: `Drug ${prefix} ${i}`, category: 'Medicine', batch: l.batch || `B-${i}`, expiry: '12/28', mrp: 10, unitsPerPack: 1,
      qty: l.qty, stock: l.stock ?? 50, itemId: ITEM, cloudBatchId: l.batchId, cloudLocationId: LOC })),
    extraParticulars: [],
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  return billId;
}
const op = (billId) => ({ ...db.getFinancialSyncOperations().find((x) => x.bill_id === billId) });

// ─── 1. Atomic deduction in the worker ───────────────────────────────────────────────────────────────────
test('1a. partial failure: one short line -> NOTHING deducted, STOCK_CONFLICT with the exact per-line reason', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' }); cloud.batches.set(BATCH_B, { qty: 1, batch_no: 'B-1' });
  const billId = newBill('PARTIAL', [{ batchId: BATCH_A, qty: 2, batch: 'B-0' }, { batchId: BATCH_B, qty: 3, batch: 'B-1' }]);
  const [r] = await w.runOnce();
  assert.strictEqual(r.reviewRequired, 'STOCK_CONFLICT');
  assert.strictEqual(cloud.qty(BATCH_A), 10, 'the good line was NOT applied on its own');
  assert.strictEqual(cloud.qty(BATCH_B), 1);
  assert.strictEqual(cloud.movements.size, 0);
  assert.strictEqual(op(billId).sync_status, 'STOCK_CONFLICT');
  assert.match(op(billId).last_error, /status=CONFLICT_INSUFFICIENT_STOCK applied=0 lines=\[/);
  const [item] = await w.sync.getStockReviewItems();
  assert.strictEqual(item.review.code, 'CONFLICT_INSUFFICIENT_STOCK');
  assert.match(item.review.title, /less stock than this bill sold/);
  assert.strictEqual(JSON.stringify(item.review.lines.map((l) => l.status).sort()), JSON.stringify(['CONFLICT_INSUFFICIENT_STOCK', 'PENDING']));
  const short = item.review.lines.find((l) => l.status === 'CONFLICT_INSUFFICIENT_STOCK');
  assert.strictEqual(short.cloud_stock, 1);
  assert.strictEqual(short.needed, 3);
});

test('1b. all lines OK -> applied together once, CLOUD_CONFIRMED, verified by read-back', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' }); cloud.batches.set(BATCH_B, { qty: 5, batch_no: 'B-1' });
  const billId = newBill('OK', [{ batchId: BATCH_A, qty: 2, batch: 'B-0' }, { batchId: BATCH_B, qty: 3, batch: 'B-1' }]);
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.qty(BATCH_A), 8); assert.strictEqual(cloud.qty(BATCH_B), 2);
  assert.strictEqual(cloud.movements.size, 2);
  assert.strictEqual(cloud.calls.bulk, 1); assert.strictEqual(cloud.calls.legacy, 0);
});

test('1c. reply lost after commit -> retry deducts nothing twice (original keys)', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' });
  const billId = newBill('LOST', [{ batchId: BATCH_A, qty: 4, batch: 'B-0' }]);
  cloud.state.mode = 'lose-response';
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  cloud.state.mode = 'apply';
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.qty(BATCH_A), 6, 'deducted exactly once');
  assert.strictEqual(cloud.movements.size, 1);
});

test('1d. server function not installed -> older single-line path still works (no regression before deployment)', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' });
  cloud.state.mode = 'missing';
  const billId = newBill('MISSING', [{ batchId: BATCH_A, qty: 1, batch: 'B-0' }]);
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.calls.legacy, 1);
  assert.strictEqual(cloud.qty(BATCH_A), 9);
});

test('1e. conflict is never retried automatically (no retry storm)', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 0, batch_no: 'B-0' });
  newBill('NORETRY', [{ batchId: BATCH_A, qty: 1, batch: 'B-0' }]);
  await w.runOnce();
  const n = cloud.calls.bulk;
  for (let i = 0; i < 5; i += 1) await w.runOnce();
  assert.strictEqual(cloud.calls.bulk, n);
});

// ─── 2. Review and resolution ─────────────────────────────────────────────────────────────────────────────
async function conflictedBill(cloud, w, prefix, lines) {
  const billId = newBill(prefix, lines);
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'STOCK_CONFLICT');
  return billId;
}

test('2a. retry after the stock was put right: only missing deductions applied, verified, review cleared with audit', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' }); cloud.batches.set(BATCH_B, { qty: 0, batch_no: 'B-1' });
  const billId = await conflictedBill(cloud, w, 'RETRY', [{ batchId: BATCH_A, qty: 2, batch: 'B-0' }, { batchId: BATCH_B, qty: 3, batch: 'B-1' }]);
  // a line that an OLDER app version already applied before stopping (legacy partial bill)
  const k0 = `VHC:BILL:${billId}:${db.getLocalSaleByBillId(billId).stock_movements.find((m) => m.server_stock_batch_id === BATCH_A).id}`;
  cloud.movements.set(k0, { bill_id: billId, qty: -2, batch: BATCH_A }); cloud.batches.get(BATCH_A).qty = 8;
  cloud.batches.get(BATCH_B).qty = 5; // audited correction / transfer arrived
  const r = await w.sync.resolveStockReview(billId, { mode: 'retry' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.applied, 1, 'only the missing line');
  assert.strictEqual(cloud.qty(BATCH_A), 8, 'the already-applied line was not deducted again');
  assert.strictEqual(cloud.qty(BATCH_B), 2);
  const row = op(billId);
  assert.strictEqual(row.sync_status, 'CLOUD_CONFIRMED');
  assert.match(row.review_resolution, /verified in the cloud after review \(retry\)/);
  assert.strictEqual(row.review_resolved_by, 'counter@example.invalid');
  assert.ok(row.review_resolved_at);
  assert.strictEqual((await w.sync.getStockReviewItems()).length, 0);
  const again = await w.sync.resolveStockReview(billId, { mode: 'retry' });
  assert.strictEqual(again.ok, false, 'a resolved bill cannot be resolved twice');
  assert.strictEqual(cloud.qty(BATCH_B), 2);
});

test('2b. retry still refused -> stays in review with the NEW reason, nothing applied', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' }); cloud.batches.set(BATCH_B, { qty: 0, batch_no: 'B-1' });
  const billId = await conflictedBill(cloud, w, 'STILL', [{ batchId: BATCH_A, qty: 2, batch: 'B-0' }, { batchId: BATCH_B, qty: 3, batch: 'B-1' }]);
  cloud.batches.get(BATCH_B).qty = 1;
  const r = await w.sync.resolveStockReview(billId, { mode: 'retry' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(op(billId).sync_status, 'STOCK_CONFLICT');
  assert.match(op(billId).last_error, /"cloud_stock":1/);
  assert.strictEqual(cloud.qty(BATCH_A), 10); assert.strictEqual(cloud.movements.size, 0);
});

test('2c. deleted batch: re-pointing to the current batch is admin-only and audited; never double-deducted', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 10, batch_no: 'B-0' });
  const billId = await conflictedBill(cloud, w, 'GONE', [{ batchId: BATCH_B, qty: 2, batch: 'B-1' }]);
  const [item] = await w.sync.getStockReviewItems();
  assert.strictEqual(item.review.code, 'CONFLICT_BATCH_NOT_FOUND');
  assert.strictEqual(item.review.canRetryCurrentBatch, true);
  cloud.batches.set(BATCH_NEW, { qty: 7, batch_no: 'B-1' }); // staff re-created the batch
  let r = await w.sync.resolveStockReview(billId, { mode: 'retry_current_batch' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Only an admin/);
  assert.strictEqual(cloud.qty(BATCH_NEW), 7);
  cloud.state.admin = true;
  r = await w.sync.resolveStockReview(billId, { mode: 'retry_current_batch' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(cloud.qty(BATCH_NEW), 5);
  assert.strictEqual(op(billId).sync_status, 'CLOUD_CONFIRMED');
});

test('2d. acknowledge: admin + written reason only; no stock write; leaves the review count', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 0, batch_no: 'B-0' });
  const billId = await conflictedBill(cloud, w, 'ACK', [{ batchId: BATCH_A, qty: 1, batch: 'B-0' }]);
  let r = await w.sync.resolveStockReview(billId, { mode: 'acknowledge', reason: 'Shelf recounted 23-Oct and corrected' });
  assert.strictEqual(r.ok, false, 'pharmacist cannot acknowledge');
  cloud.state.admin = true;
  r = await w.sync.resolveStockReview(billId, { mode: 'acknowledge', reason: 'short' });
  assert.strictEqual(r.ok, false, 'a reason is required');
  const before = cloud.calls.bulk;
  r = await w.sync.resolveStockReview(billId, { mode: 'acknowledge', reason: 'Shelf recounted 23-Oct and corrected' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(cloud.calls.bulk, before, 'no stock call');
  assert.strictEqual(op(billId).sync_status, 'REVIEW_ACKNOWLEDGED');
  assert.strictEqual(op(billId).review_resolution, 'Shelf recounted 23-Oct and corrected');
  assert.strictEqual((await w.sync.getStockReviewItems()).length, 0);
  assert.ok(!db.getUnsyncedFinancialSyncOperations().some((x) => x.bill_id === billId), 'never retried after acknowledgement');
});

test('2e. SALE_MISMATCH cannot be stock-retried; it can only be acknowledged by an admin', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newBill('MISMATCH', [{ batchId: BATCH_A, qty: 1 }]);
  cloud.sales.set(billId, { id: uuid(), bill_id: billId, total_amount: '10.00', amount_received: 10, outstanding_amount: 0, payment_status: 'Paid', sale_items: [{ drug_name: 'Other', quantity: '1.000', total: '10.00' }] });
  await w.runOnce();
  assert.strictEqual(op(billId).sync_status, 'SALE_MISMATCH');
  const [item] = await w.sync.getStockReviewItems();
  assert.strictEqual(item.review.code, 'SALE_CONTENT_MISMATCH');
  assert.strictEqual(item.review.canRetry, false);
  cloud.state.admin = true;
  assert.strictEqual((await w.sync.resolveStockReview(billId, { mode: 'retry' })).ok, false);
  assert.strictEqual((await w.sync.resolveStockReview(billId, { mode: 'acknowledge', reason: 'Checked cloud bill against paper copy' })).ok, true);
});

test('2f. a bill deleted on this counter is never deducted from the review screen', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 0, batch_no: 'B-0' });
  const billId = await conflictedBill(cloud, w, 'DELBILL', [{ batchId: BATCH_A, qty: 1, batch: 'B-0' }]);
  assert.strictEqual(db.cancelLocalSale(billId).success, true);
  cloud.batches.get(BATCH_A).qty = 9;
  const r = await w.sync.resolveStockReview(billId, { mode: 'retry' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /was deleted on this counter/);
  assert.strictEqual(cloud.qty(BATCH_A), 9);
});

test('2g. cloud unreachable during a retry -> transient, item unchanged, nothing applied', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.batches.set(BATCH_A, { qty: 0, batch_no: 'B-0' });
  const billId = await conflictedBill(cloud, w, 'NET', [{ batchId: BATCH_A, qty: 1, batch: 'B-0' }]);
  const errBefore = op(billId).last_error;
  cloud.state.mode = 'network';
  const r = await w.sync.resolveStockReview(billId, { mode: 'retry' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.transient, true);
  assert.strictEqual(op(billId).sync_status, 'STOCK_CONFLICT');
  assert.strictEqual(op(billId).last_error, errBefore);
});

// ─── 3. Local database: overlays, references, delete ────────────────────────────────────────────────────
test('3a. only still-pending deductions overlay inventory (as a delta); conflicts and acknowledged items never do', async () => {
  await freshDb();
  const pending = newBill('PEND', [{ batchId: BATCH_A, qty: 2 }]);
  const conflicted = newBill('CONF', [{ batchId: BATCH_B, qty: 3 }]);
  const cloudId = 'cccccccc-0000-4000-8000-00000000000c';
  db.markFinancialSyncSaleConfirmed(conflicted, cloudId);
  db.markFinancialSyncReviewRequired(conflicted, 'STOCK_CONFLICT', 'STOCK_RECONCILIATION_CONFLICT: x status=CONFLICT_BATCH_NOT_FOUND', cloudId);
  const rows = db.getPendingStockOverlays();
  assert.deepStrictEqual(rows.map((r) => r.bill_id), [pending]);
  assert.strictEqual(Number(rows[0].qty), -2);
  assert.strictEqual(db.markFinancialSyncReviewAcknowledged(conflicted, { resolution: 'Recounted and corrected', resolvedBy: 'admin' }).success, true);
  assert.ok(!db.getPendingStockOverlays().some((r) => r.bill_id === conflicted));
});

test('3b. batch references: pending and review bills protect their batch; confirmed/cancelled do not', async () => {
  await freshDb();
  const pending = newBill('REFP', [{ batchId: BATCH_A, qty: 1, batch: 'RA-1' }]);
  let refs = db.getStockBatchReferences({ serverStockBatchId: BATCH_A });
  assert.deepStrictEqual(refs.bills, [pending]); assert.strictEqual(refs.pending, 1);
  const cloudId = 'cccccccc-0000-4000-8000-00000000000d';
  db.markFinancialSyncSaleConfirmed(pending, cloudId);
  db.markFinancialSyncReviewRequired(pending, 'STOCK_CONFLICT', 'x', cloudId);
  refs = db.getStockBatchReferences({ serverItemId: ITEM, cloudLocationId: LOC, batchNo: ' ra-1 ' });
  assert.deepStrictEqual(refs.bills, [pending], 'found by item + location + batch number too'); assert.strictEqual(refs.review, 1);
  db.markFinancialSyncReviewResolved(pending, { cloudSaleId: cloudId, resolution: 'verified' });
  assert.deepStrictEqual(db.getStockBatchReferences({ serverStockBatchId: BATCH_A }).bills, []);
});

test('3c. deleting a bill whose stock step is still pending cancels that step (it can never deduct a deleted bill)', async () => {
  await freshDb();
  const billId = newBill('DELPEND', [{ batchId: BATCH_A, qty: 1 }]);
  db.markFinancialSyncSaleConfirmed(billId, 'cccccccc-0000-4000-8000-00000000000e');
  assert.strictEqual(op(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  assert.strictEqual(db.cancelLocalSale(billId).cancelledSyncOperations, 1);
  assert.strictEqual(op(billId).sync_status, 'CANCELLED');
  assert.ok(!db.getUnsyncedFinancialSyncOperations().some((x) => x.bill_id === billId));
});

test('3d. review resolution guards: only STOCK_CONFLICT can be resolved; acknowledgement needs a real reason', async () => {
  await freshDb();
  const billId = newBill('GUARD', [{ batchId: BATCH_A, qty: 1 }]);
  assert.strictEqual(db.markFinancialSyncReviewResolved(billId, { cloudSaleId: 'cccccccc-0000-4000-8000-00000000000f' }).success, false);
  assert.strictEqual(db.markFinancialSyncReviewAcknowledged(billId, { resolution: 'Recounted and corrected' }).success, false, 'not in review');
  db.markFinancialSyncSaleConfirmed(billId, 'cccccccc-0000-4000-8000-00000000000f');
  db.markFinancialSyncReviewRequired(billId, 'STOCK_CONFLICT', 'x', 'cccccccc-0000-4000-8000-00000000000f');
  assert.strictEqual(db.markFinancialSyncReviewAcknowledged(billId, { resolution: 'ok' }).success, false);
  assert.strictEqual(op(billId).sync_status, 'STOCK_CONFLICT');
});

// ─── 4. Inventory overlay block (real code from the bundle) ─────────────────────────────────────────────
function between(src, a, b) { const i = src.indexOf(a); assert.ok(i >= 0, 'marker ' + a.slice(0, 50)); const j = src.indexOf(b, i); assert.ok(j > i); return src.slice(i, j); }
const bundle = read('dist/assets/index-doBKNLAj.js');
// Runs the REAL inventory loader l() and its display normaliser c() from the bundle (inventory provider), with a
// stand-in cloud client and local database. Returns what the inventory screen state is set to (null = not set).
const loaderSrc = (() => {
  const seg = between(bundle, '      c = (e) => {', '      loadPatients = async () => {').trimEnd().replace(/,$/, '');
  return `let inventoryLoadSeq = { current: 0 }; let ${seg}; return l;`;
})();
function makeLoader({ fetchInventory, getPendingStockOverlays, findKeys }) {
  const screen = { sets: [], last: null };
  // Like the real client: getInventory() returns whatever the LAST completed fetch stored in the shared cache.
  let shared = [];
  const fetchAndCache = async () => { const r = await fetchInventory(); shared = r; return r; };
  const win = {
    VHC_CLOUD: { fetchInventory: fetchAndCache, getInventory: () => shared, ...(findKeys ? { findStockMovementsByKeysStrict: findKeys } : {}) },
    electronAPI: getPendingStockOverlays ? { getPendingStockOverlays } : {},
  };
  const l = new Function('window', 'console', 'a', loaderSrc)(win, { warn() {}, log() {} }, (v) => { screen.sets.push(v); screen.last = v; });
  return { l, screen };
}
async function runOverlay(cloudInventory, overlays, extra) {
  const { l, screen } = makeLoader({ fetchInventory: async () => cloudInventory, getPendingStockOverlays: async () => overlays, ...(extra || {}) });
  await l();
  return screen.last;
}
test('4a. pending deductions are shown as a delta on the LIVE cloud quantity (not a frozen closing)', async () => {
  const inv = [{ id: BATCH_A, itemId: ITEM, locationId: LOC, batch: 'B-0', stock: 10 }, { id: BATCH_B, itemId: ITEM, locationId: LOC, batch: 'B-1', stock: 4 }];
  const out = await runOverlay(inv, [
    { server_stock_batch_id: BATCH_A, qty: -1, closing: 99 }, { server_stock_batch_id: BATCH_A, qty: -2.5, closing: 99 },
    { server_stock_batch_id: null, server_item_id: ITEM, cloud_location_id: LOC, batch_no: ' b-1 ', qty: -1, closing: 99 },
  ]);
  assert.strictEqual(out[0].stock, 6.5); assert.strictEqual(out[0].stockPendingSync, true);
  assert.strictEqual(out[1].stock, 3); assert.strictEqual(out[1].stockPendingSync, true);
});
test('4b. with no pending deductions (e.g. only review items) the live cloud stock is shown unchanged', async () => {
  const inv = [{ id: BATCH_A, itemId: ITEM, locationId: LOC, batch: 'B-0', stock: 10 }];
  const out = await runOverlay(inv, []);
  assert.strictEqual(out[0].stock, 10); assert.ok(!out[0].stockPendingSync);
});
// Reported symptom: the cloud quantity was corrected and is non-zero, but the desktop inventory kept showing 0 / an old
// number. Shipped builds overlaid every unconfirmed bill (incl. STOCK_CONFLICT review bills, never retried) by pinning the
// batch to that bill's frozen closing quantity. Real SQLite layer + real loader: the corrected cloud quantity is shown.
test('4c. REGRESSION: cloud corrected to 12 after a review (STOCK_CONFLICT) bill took the batch to 0 -> screen shows 12, not 0', async () => {
  await freshDb();
  const billId = newBill('INV0', [{ batchId: BATCH_A, qty: 5, stock: 5 }]);       // local closing = 0
  assert.strictEqual(db.markFinancialSyncSaleConfirmed(billId, 'cccccccc-0000-4000-8000-000000000001').success, true);
  assert.strictEqual(db.markFinancialSyncReviewRequired(billId, 'STOCK_CONFLICT', 'insufficient stock', 'cccccccc-0000-4000-8000-000000000001').success, true);
  const cloud = [{ id: BATCH_A, itemId: ITEM, locationId: LOC, batch: 'B-0', stock: '12.000' }];   // after the correction
  const { l, screen } = makeLoader({ fetchInventory: async () => cloud, getPendingStockOverlays: async () => db.getPendingStockOverlays(), findKeys: async () => [] });
  await l();
  assert.strictEqual(screen.last[0].stock, 12);
  assert.ok(!screen.last[0].stockPendingSync, 'a review bill never freezes or adjusts the shown stock');
  // Re-opening the screen / refreshing gives the same live value.
  cloud[0].stock = '11.000'; await l();
  assert.strictEqual(screen.last[0].stock, 11);
});
test('4d. a pending bill whose deduction is ALREADY in the cloud (reply lost) is not subtracted again; unknown -> kept', async () => {
  await freshDb();
  const billId = newBill('INV1', [{ batchId: BATCH_A, qty: 2, stock: 10 }, { batchId: BATCH_B, qty: 1, stock: 4 }]);
  db.markFinancialSyncSaleConfirmed(billId, 'cccccccc-0000-4000-8000-000000000002');
  db.markFinancialSyncStockPending(billId, 'TypeError: Failed to fetch');           // reply lost: worker still pending
  const rows = db.getPendingStockOverlays();
  assert.strictEqual(rows.length, 2);
  const keyA = `VHC:BILL:${billId}:${rows.find((r) => r.server_stock_batch_id === BATCH_A).local_movement_id}`;
  // Cloud: A already deducted (10 -> 8), B not yet (4).
  const cloud = () => [{ id: BATCH_A, itemId: ITEM, locationId: LOC, batch: 'B-0', stock: 8 }, { id: BATCH_B, itemId: ITEM, locationId: LOC, batch: 'B-1', stock: 4 }];
  const asked = [];
  let { l, screen } = makeLoader({ fetchInventory: async () => cloud(), getPendingStockOverlays: async () => db.getPendingStockOverlays(),
    findKeys: async (keys) => { asked.push(...keys); return keys.includes(keyA) ? [{ movement_key: keyA }] : []; } });
  await l();
  assert.strictEqual(asked.length, 2, 'every pending line is checked');
  assert.strictEqual(screen.last[0].stock, 8, 'already-applied deduction NOT subtracted twice (old: 6)');
  assert.ok(!screen.last[0].stockPendingSync);
  assert.strictEqual(screen.last[1].stock, 3, 'genuinely pending deduction still shown');
  assert.strictEqual(screen.last[1].stockPendingSync, true);
  // Cloud check fails -> nothing guessed: every pending deduction stays applied (lower, never higher; never zeroed).
  ({ l, screen } = makeLoader({ fetchInventory: async () => cloud(), getPendingStockOverlays: async () => db.getPendingStockOverlays(),
    findKeys: async () => { throw new TypeError('Failed to fetch'); } }));
  await l();
  assert.deepStrictEqual(screen.last.map((x) => x.stock), [6, 3]);
});
test('4e. an older, slower inventory load can never overwrite a newer one (stale stock after a refresh)', async () => {
  let release = [];
  const responses = [[{ id: BATCH_A, stock: 5 }], [{ id: BATCH_A, stock: 12 }]];
  let n = 0;
  const { l, screen } = makeLoader({ fetchInventory: () => { const r = responses[n++]; return new Promise((res) => release.push(() => res(r))); },
    getPendingStockOverlays: async () => [] });
  const first = l(); const second = l();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.strictEqual(release.length, 2);
  release[1](); await second;                 // newer load (after the correction) arrives first
  release[0](); await first;                  // older load (before the correction) arrives last
  assert.strictEqual(screen.last[0].stock, 12);
  assert.strictEqual(screen.sets.length, 1, 'the stale response is dropped');
});
test('4f. a failed inventory load keeps the last good quantities (never replaced with zero or emptied)', async () => {
  let fail = false;
  const { l, screen } = makeLoader({ fetchInventory: async () => { if (fail) throw new Error('network'); return [{ id: BATCH_A, stock: '7.000' }]; },
    getPendingStockOverlays: async () => [] });
  await l(); fail = true; await l();
  assert.strictEqual(screen.sets.length, 1); assert.strictEqual(screen.last[0].stock, 7);
});

// ─── 5. Cloud client functions (REAL code from BOTH copies) ─────────────────────────────────────────────
function fnText(src, name, indent) {
  const start = src.indexOf(`\n${indent}async function ${name}(`) + 1;
  assert.ok(start > 0, `function ${name}`);
  const end = src.indexOf(`\n${indent}}\n`, start) + indent.length + 2;
  return src.slice(start, end);
}
function loadCloud(file, indent) {
  const src = read(file);
  const helpers = between(src, '// ─── Manual stock corrections', `\n${indent}async function updateInventoryItem(`);
  const code = helpers + '\n' + ['addInventoryItem', 'deleteInventoryItem', 'restoreBillStock', 'applyBillStockMovements', 'isCurrentUserAdmin'].map((n) => fnText(src, n, indent)).join('\n');
  return new Function('supabase', 'env', 'window', `
    let inventoryCache = env.cache;
    const ensurePharmacyLocation = async () => '${LOC}';
    const resolveItemId = async () => '${ITEM}';
    const fetchInventory = async () => inventoryCache;
    const expiryToISODate = (x) => x || null;
    const cacheSet = () => {};
    const assertCloudWritesAllowed = () => {};
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rowToInventoryItem = (row) => ({ id: row.id, itemId: row.item_id, locationId: row.location_id, batch: row.batch_no, stock: row.qty, name: row.items && row.items.name });
    ${code}
    return { addInventoryItem, deleteInventoryItem, restoreBillStock, applyBillStockMovements, isCurrentUserAdmin, getCache: () => inventoryCache };`);
}
function fakeSb(handlers) {
  const calls = [];
  const builder = (table) => {
    const ops = [];
    const b = {};
    for (const m of ['insert', 'update', 'delete', 'eq', 'in', 'select', 'single', 'maybeSingle']) b[m] = (...a) => { ops.push([m, ...a]); return b; };
    b.then = (res, rej) => Promise.resolve().then(() => { calls.push({ table, ops }); return (handlers.from || (() => ({ data: null, error: null })))(table, ops); }).then(res, rej);
    return b;
  };
  return { calls, from: builder, rpc: async (name, args) => { calls.push({ rpc: name, args }); return handlers.rpc ? handlers.rpc(name, args) : { data: null, error: null }; } };
}
const writes = (calls) => calls.filter((c) => c.table && c.ops.some((o) => ['insert', 'update', 'delete'].includes(o[0])));
for (const [label, file, indent] of [['cloud-src', 'cloud-src/vhc-cloud-sync.js', ''], ['dist bundle', 'dist/assets/vhc-cloud-sync.js', '  ']]) {
  const factory = loadCloud(file, indent);
  const mk = (handlers, refs) => {
    const sb = fakeSb(handlers || {});
    const env = { cache: [{ id: BATCH_A, itemId: ITEM, locationId: LOC, batch: 'B-0', stock: 0, name: 'X' }, { id: BATCH_B, itemId: ITEM, locationId: LOC, batch: 'B-1', stock: 5, name: 'Y' }] };
    const refCalls = [];
    const win = { electronAPI: { getStockBatchReferences: async (r) => { refCalls.push(r); return refs || { success: true, bills: [] }; } } };
    return { sb, env, refCalls, api: factory(sb, env, win) };
  };
  test(`5a [${label}] batch used by a pending/review bill -> refused before any cloud call`, async () => {
    const { sb, api, refCalls } = mk({}, { success: true, bills: ['BILL-1', 'BILL-2'], pending: 1, review: 1 });
    await assert.rejects(api.deleteInventoryItem(BATCH_A), (e) => e.code === 'BATCH_IN_USE' && /2 bill\(s\)/.test(e.message) && /BILL-1/.test(e.message));
    assert.strictEqual(sb.calls.length, 0);
    assert.deepStrictEqual(refCalls[0], { serverStockBatchId: BATCH_A, serverItemId: ITEM, cloudLocationId: LOC, batchNo: 'B-0' });
  });
  test(`5b [${label}] local reference check unavailable -> refused (fail closed)`, async () => {
    const { sb, api } = mk({}, { success: false, error: 'db down' });
    await assert.rejects(api.deleteInventoryItem(BATCH_A), (e) => e.code === 'BATCH_REFERENCES_UNKNOWN');
    assert.strictEqual(sb.calls.length, 0);
  });
  test(`5c [${label}] delete goes through delete_stock_batch; refusals are explained; nothing deleted directly`, async () => {
    for (const [status, re] of [['CONFLICT_BATCH_NOT_EMPTY', /still holds 3/], ['CONFLICT_BATCH_HAS_HISTORY', /kept \(closed at zero\)/], ['CONFLICT_BATCH_REFERENCED', /referenced by a bill/]]) {
      const { sb, api } = mk({ rpc: () => ({ data: { status, current_qty: 3 }, error: null }) });
      await assert.rejects(api.deleteInventoryItem(BATCH_A), (e) => e.code === status && re.test(e.message) && /Nothing was deleted/.test(e.message));
      assert.strictEqual(writes(sb.calls).length, 0);
      assert.strictEqual(sb.calls[0].rpc, 'delete_stock_batch');
    }
    const { sb, api } = mk({ rpc: () => ({ data: { status: 'APPLIED' }, error: null }) });
    const r = await api.deleteInventoryItem(BATCH_A, { reason: 'Duplicate entry typed by mistake' });
    assert.deepStrictEqual(r, { success: true, id: BATCH_A, recorded: true });
    assert.strictEqual(sb.calls[0].args.payload.reason, 'Duplicate entry typed by mistake');
    assert.ok(/^[A-Za-z0-9_-]{16,80}$/.test(sb.calls[0].args.payload.request_key));
    assert.ok(!api.getCache().some((i) => i.id === BATCH_A));
    assert.strictEqual(writes(sb.calls).length, 0, 'no direct DELETE when the server function exists');
  });
  test(`5d [${label}] server function not installed -> direct delete only for an EMPTY batch`, async () => {
    const missing = { rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.delete_stock_batch' } }) };
    let m = mk(missing);
    await assert.rejects(m.api.deleteInventoryItem(BATCH_B), (e) => e.code === 'CONFLICT_BATCH_NOT_EMPTY');
    assert.strictEqual(writes(m.sb.calls).length, 0);
    m = mk(missing);
    await m.api.deleteInventoryItem(BATCH_A);
    assert.strictEqual(writes(m.sb.calls).length, 1);
  });
  test(`5e [${label}] new batch through create_stock_batch (opening quantity audited); duplicate refused`, async () => {
    let m = mk({
      rpc: () => ({ data: { status: 'APPLIED', stock_batch_id: BATCH_NEW }, error: null }),
      from: () => ({ data: { id: BATCH_NEW, item_id: ITEM, location_id: LOC, batch_no: 'N-1', qty: 12, items: { name: 'New' } }, error: null }),
    });
    const created = await m.api.addInventoryItem({ name: 'New', batch: 'N-1', stock: '12', mrp: 50 });
    assert.strictEqual(created.id, BATCH_NEW); assert.strictEqual(created.stock, 12);
    const rpc = m.sb.calls.find((c) => c.rpc);
    assert.strictEqual(rpc.rpc, 'create_stock_batch');
    assert.strictEqual(rpc.args.payload.opening_qty, 12); assert.strictEqual(rpc.args.payload.batch_no, 'N-1');
    assert.strictEqual(writes(m.sb.calls).length, 0, 'no direct insert');
    m = mk({ rpc: () => ({ data: { status: 'CONFLICT_BATCH_EXISTS', stock_batch_id: BATCH_B, current_qty: 5 }, error: null }) });
    await assert.rejects(m.api.addInventoryItem({ name: 'Y', batch: 'b-1', stock: 3 }), (e) => e.code === 'CONFLICT_BATCH_EXISTS' && /already exists \(current stock 5\)/.test(e.message));
    assert.strictEqual(writes(m.sb.calls).length, 0);
  });
  test(`5f [${label}] restoreBillStock / applyBillStockMovements map "not installed" to RPC_MISSING`, async () => {
    const { api } = mk({ rpc: () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }) });
    assert.deepStrictEqual(await api.restoreBillStock({ billId: 'B', reason: 'Bill deleted' }), { status: 'RPC_MISSING' });
    assert.deepStrictEqual(await api.applyBillStockMovements({ bill_id: 'B', movements: [] }), { status: 'RPC_MISSING' });
    const { sb, api: a2 } = mk({ rpc: () => ({ data: { status: 'APPLIED' }, error: null }) });
    await a2.restoreBillStock({ billId: 'B-9', reason: ' Bill deleted by admin ', patientId: 'not-a-uuid' });
    assert.deepStrictEqual(sb.calls[0].args.payload, { bill_id: 'B-9', reason: 'Bill deleted by admin' });
  });
  test(`5h [${label}] T7: restoreBillStock never sends a patient id (a counter's local UUID is not a cloud patients.id)`, async () => {
    const { sb, api } = mk({ rpc: () => ({ data: { status: 'APPLIED' }, error: null }) });
    await api.restoreBillStock({ billId: 'B-10', reason: 'Bill deleted - stock restored', patientId: '28ad4342-0000-4000-8000-00000000c0de' });
    assert.ok(!('patient_id' in sb.calls[0].args.payload), JSON.stringify(sb.calls[0].args.payload));
    // A server/HTTP error (e.g. the old 409 FK violation) is thrown to the caller, never turned into success.
    const { api: a3 } = mk({ rpc: () => ({ data: null, error: { code: '23503', message: 'insert or update on table "stock_movements" violates foreign key constraint "stock_movements_patient_id_fkey"' } }) });
    await assert.rejects(a3.restoreBillStock({ billId: 'B-11', reason: 'Bill deleted - stock restored' }), (e) => /stock_movements_patient_id_fkey/.test(e && e.message));
  });
  test(`5g [${label}] admin check fails closed`, async () => {
    assert.strictEqual(await mk({ rpc: () => ({ data: true, error: null }) }).api.isCurrentUserAdmin(), true);
    assert.strictEqual(await mk({ rpc: () => ({ data: null, error: { message: 'x' } }) }).api.isCurrentUserAdmin(), false);
    assert.strictEqual(await mk({ rpc: () => { throw new Error('offline'); } }).api.isCurrentUserAdmin(), false);
  });
}

// ─── 6. Screens (real code from the bundle) ─────────────────────────────────────────────────────────────
test('6a. bill delete: cloud restore first (inside the sync-exclusive section), local cancel only on success, line-based restore only when not installed', () => {
  const block = between(bundle, '  let handleDeleteBill = async (billToDelete) => {', '      let salesHistory = [];');
  const iLedger = block.indexOf('await window.VHC_CLOUD.restoreBillStock(');
  const iCancel = block.indexOf('await window.electronAPI.cancelLocalSale(billRecord.billId)');
  const iExcl = block.indexOf('fs.runExclusiveOfFinancialSync(runLedgerRestore)');
  const iLegacy = block.indexOf('if (restoreList.length > 0 && reportsUpdateItemsBulk) {');
  assert.ok(iLedger > 0 && iCancel > iLedger && iExcl > iCancel && iLegacy > iExcl, 'order: restore -> cancel on success (both in the exclusive section) -> legacy fallback');
  assert.match(block, /if \(okStatus && window\.electronAPI && window\.electronAPI\.cancelLocalSale\)/);
  assert.doesNotMatch(between(block, 'window.VHC_CLOUD.restoreBillStock({', '});'), /patientId/, 'no patient id is sent');
});

// Runs the REAL handleDeleteBill from the bundle with stubbed screen state, local DB and cloud.
const deleteBlock = between(bundle, '  let handleDeleteBill = async (billToDelete) => {', '\n  let E = _.useMemo(');
function runDelete({ restore, exclusive, missingRestore = false } = {}) {
  const bill = { billId: 'BILL-T7-UI-1', patientId: '28ad4342-0000-4000-8000-00000000c0de', patientName: 'QA', patientSnapshot: { name: 'QA' },
    particulars: [{ drugName: 'QA Drug', batchNo: 'B-1', quantity: 2, category: 'Medicine' }] };
  const store = new Map([['vhc_pos_sales_history', JSON.stringify([bill, { billId: 'OTHER' }])]]);
  const log = [];
  let inExclusive = false;
  const window = {
    VHC_CLOUD: {
      ...(missingRestore ? {} : { async restoreBillStock(a) { log.push(['restore', a, inExclusive]); return restore(a); } }),
      async deleteSaleByBillId(id) { log.push(['cloudDelete', id]); return { deleted: true }; },
    },
    electronAPI: { async cancelLocalSale(id) { log.push(['cancelLocal', id, inExclusive]); return { success: true }; } },
    VHC_FINANCIAL_SYNC: { async runExclusiveOfFinancialSync(fn) {
      if (exclusive === 'busy') return { ok: false, busy: true, error: 'Cloud sync is running. Try again in a moment.' };
      inExclusive = true; try { return { ok: true, value: await fn() }; } finally { inExclusive = false; } } },
    VHC_AUDIT: { logFinancial(type, d) { log.push(['audit', type, d]); } },
  };
  const toasts = [];
  const names = ['window', 'localStorage', 'fetch', 'console', 'confirmAction', 'reportsInventory', 'reportsUpdateItemsBulk', 'vhcIsCategory',
    't', 'r', 'u', 'd', 'vhcConfirmDurable'];
  const fn = new Function(...names, deleteBlock + '\nreturn handleDeleteBill;')(
    window,
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { log.push(['lsSet', k]); store.set(k, String(v)); } },
    (url, o) => { log.push(['fetch', url, o && o.method]); return Promise.resolve({}); },
    { log() {}, warn() {}, error() {} },
    async () => true,
    [{ id: 'inv-1', name: 'QA Drug', batch: 'B-1' }],
    async (list, ctx) => { log.push(['legacyRestore', list, ctx]); return {}; },
    (c, n) => String(c || '') === n,
    (msg, type) => toasts.push({ msg, type }),
    (upd) => log.push(['listUpdate']), null, () => {},
    async () => ({ ok: true }),
  );
  return { run: () => fn({ billId: bill.billId }), log, toasts, store, bill };
}
const kinds = (log) => log.map((x) => x[0]);
// Nothing on this counter changed: no local cancel, no cloud soft delete, no history rewrite, no line-based restore.
const untouchedLocally = (h, label) => {
  for (const k of ['cancelLocal', 'cloudDelete', 'lsSet', 'fetch', 'listUpdate', 'legacyRestore']) assert.ok(!kinds(h.log).includes(k), `${label}: ${k} must not happen`);
  assert.strictEqual(JSON.parse(h.store.get('vhc_pos_sales_history')).length, 2, `${label}: bill still in history`);
  assert.strictEqual(h.toasts.length, 1); assert.strictEqual(h.toasts[0].type, 'error');
  assert.match(h.toasts[0].msg, /was NOT removed/);
};
// A definite server answer (or a call that was never sent): nothing changed anywhere, and the user is told so.
const untouched = (h, label) => {
  untouchedLocally(h, label);
  assert.match(h.toasts[0].msg, /Nothing was changed on this counter or in the cloud/);
};
// No usable reply (lost / timed out / empty): the cloud result is unknown and must never be reported as unchanged.
const unknownOutcome = (h, label) => {
  untouchedLocally(h, label);
  const m = h.toasts[0].msg;
  assert.match(m, /was NOT removed on this counter/, label);
  assert.match(m, /cloud result is UNKNOWN/, label);
  assert.match(m, /may or may not already have been restored/, label);
  assert.match(m, /Remove the bill again when the counter is online/, label);
  assert.match(m, /restores each item at most once/, label);
  assert.doesNotMatch(m, /Nothing was changed/, `${label}: must not claim that nothing changed`);
};
test('6d. T7: restore fails with the server error (HTTP 409 FK) -> bill NOT deleted locally or in the cloud, user told', async () => {
  const h = runDelete({ restore: async () => { throw new Error('insert or update on table "stock_movements" violates foreign key constraint "stock_movements_patient_id_fkey"'); } });
  await h.run();
  // A thrown call is reported as "result unknown" (the wrapper cannot tell an HTTP error from a lost reply).
  unknownOutcome(h, '409');
  assert.match(h.toasts[0].msg, /stock_movements_patient_id_fkey/);
  const audit = h.log.find((x) => x[0] === 'audit');
  assert.ok(audit && audit[1] === 'BILL_DELETE_REFUSED' && /stock_movements_patient_id_fkey/.test(audit[2].message));
});
test('6e. T7: restore refused (CONFLICT_RESTORE_WRITE_FAILED / batch missing / returns / not permitted / retry) -> nothing deleted', async () => {
  for (const res of [{ status: 'CONFLICT', conflict: 'CONFLICT_RESTORE_WRITE_FAILED', sqlstate: '23503', restored: 0 },
                     { status: 'CONFLICT', conflict: 'CONFLICT_RESTORE_BATCH_MISSING', restored: 0 },
                     { status: 'CONFLICT_BILL_HAS_RETURNS' }, { status: 'CONFLICT_ALREADY_RESTORED' },
                     { status: 'NOT_PERMITTED' }, { status: 'REJECTED_REASON' }, { status: 'RETRY', restored: 0 }]) {
    const h = runDelete({ restore: async () => res });
    await h.run();
    untouched(h, JSON.stringify(res));
  }
});
test('6e2. reply lost / timed out / empty reply -> NOT removed, message says the cloud result is UNKNOWN (never "nothing changed")', async () => {
  const cases = [
    ['reply lost', async () => { throw new TypeError('Failed to fetch'); }],
    ['timeout', async () => { throw new Error('The request timed out'); }],
    ['empty reply', async () => null],
    ['reply without status', async () => ({ restored: 1 })],
  ];
  for (const [label, restore] of cases) {
    const h = runDelete({ restore });
    await h.run();
    unknownOutcome(h, label);
    const audit = h.log.find((x) => x[0] === 'audit');
    assert.ok(audit && audit[1] === 'BILL_DELETE_REFUSED' && /cloud result unknown/.test(audit[2].message), label);
  }
});
test('6f. T7: a running sync that does not finish -> nothing restored, nothing deleted', async () => {
  const h = runDelete({ restore: async () => ({ status: 'APPLIED', lines: [] }), exclusive: 'busy' });
  await h.run();
  assert.ok(!kinds(h.log).includes('restore'));
  untouched(h, 'busy');
  assert.match(h.toasts[0].msg, /SYNC_BUSY/);
});
test('6g. T7: restore APPLIED -> no patient id sent; local cancel inside the exclusive section, then local + cloud delete', async () => {
  const h = runDelete({ restore: async () => ({ status: 'APPLIED', restored: 2, lines: [{ status: 'APPLIED', qty: 2 }, { status: 'APPLIED', qty: 4 }] }) });
  await h.run();
  const k = kinds(h.log);
  const r = h.log.find((x) => x[0] === 'restore');
  assert.deepStrictEqual(Object.keys(r[1]).sort(), ['billId', 'reason'], 'no patientId argument');
  assert.strictEqual(r[2], true, 'restore runs inside the sync-exclusive section');
  const c = h.log.find((x) => x[0] === 'cancelLocal');
  assert.strictEqual(c[2], true, 'local cancel runs inside the exclusive section, after the restore');
  assert.ok(k.indexOf('restore') < k.indexOf('cancelLocal') && k.indexOf('cancelLocal') < k.indexOf('cloudDelete'));
  assert.ok(!k.includes('legacyRestore'), 'line-based restore never runs when the server restore is installed');
  assert.deepStrictEqual(JSON.parse(h.store.get('vhc_pos_sales_history')).map((b) => b.billId), ['OTHER']);
  assert.strictEqual(h.toasts[0].type, 'success');
  assert.match(h.toasts[0].msg, /removed and 6 unit\(s\) returned/);
});
test('6h. retry of an already-restored delete (ALREADY_APPLIED) -> deletes; message says stock was already restored and nothing was added', async () => {
  const h = runDelete({ restore: async () => ({ status: 'ALREADY_APPLIED', restored: 0, already_restored: 2, lines: [{ status: 'ALREADY_APPLIED' }, { status: 'ALREADY_APPLIED' }] }) });
  await h.run();
  assert.ok(kinds(h.log).includes('cloudDelete') && kinds(h.log).includes('cancelLocal') && !kinds(h.log).includes('legacyRestore'));
  assert.strictEqual(h.toasts[0].type, 'success');
  assert.match(h.toasts[0].msg, /removed\. Its stock had already been restored to inventory by an earlier attempt \(2 item line\(s\)\); no additional stock was added\./);
  assert.doesNotMatch(h.toasts[0].msg, /unit\(s\) returned/);
});
test('6h2. a bill with no cloud deduction (NOTHING_TO_RESTORE) -> deletes; message says no stock was added', async () => {
  const h = runDelete({ restore: async () => ({ status: 'NOTHING_TO_RESTORE', lines: [] }) });
  await h.run();
  assert.ok(kinds(h.log).includes('cloudDelete') && !kinds(h.log).includes('legacyRestore'));
  assert.match(h.toasts[0].msg, /removed\. No cloud stock had been deducted for this bill, so no stock was added\./);
});
test('6h3. partly restored earlier (APPLIED + ALREADY_APPLIED lines) -> only the new units are reported, the rest "not added again"', async () => {
  const h = runDelete({ restore: async () => ({ status: 'APPLIED', restored: 1, already_restored: 1, lines: [{ status: 'APPLIED', qty: 3 }, { status: 'ALREADY_APPLIED' }] }) });
  await h.run();
  assert.match(h.toasts[0].msg, /removed and 3 unit\(s\) returned to inventory\. 1 other item line\(s\) had already been restored by an earlier attempt and were not added again\./);
});
// Stateful stand-in for restore_bill_stock (once-only restore keys, same contract as the migration).
function fakeServer() {
  const st = { calls: 0, restoredPerLine: { m1: 0, m2: 0 }, deletedMarker: 0 };
  const qty = { m1: 2, m2: 4 };
  st.restore = (mode) => async () => {
    st.calls += 1;
    if (mode === 'unreachable') throw new TypeError('Failed to fetch');           // never reached the server
    const lines = Object.keys(qty).map((k) => {
      if (st.restoredPerLine[k] > 0) return { key: k, status: 'ALREADY_APPLIED' };
      st.restoredPerLine[k] += 1; return { key: k, status: 'APPLIED', qty: qty[k] };
    });
    if (!st.deletedMarker) st.deletedMarker = 1;
    const applied = lines.filter((l) => l.status === 'APPLIED').length;
    const res = { status: applied === 0 ? 'ALREADY_APPLIED' : 'APPLIED', restored: applied, already_restored: lines.length - applied, lines };
    if (mode === 'reply-lost') throw new TypeError('Failed to fetch');            // committed, reply lost
    return res;
  };
  return st;
}
test('6k. reply lost after the server restored -> bill kept, "result unknown"; retry -> removed with "already restored", stock restored exactly once', async () => {
  const srv = fakeServer();
  const h1 = runDelete({ restore: srv.restore('reply-lost') });
  await h1.run();
  unknownOutcome(h1, 'first attempt');
  assert.deepStrictEqual(srv.restoredPerLine, { m1: 1, m2: 1 }, 'the server did restore on the first attempt');
  const h2 = runDelete({ restore: srv.restore('ok') });
  await h2.run();
  assert.strictEqual(srv.calls, 2);
  assert.deepStrictEqual(srv.restoredPerLine, { m1: 1, m2: 1 }, 'never restored twice');
  assert.ok(kinds(h2.log).includes('cancelLocal') && kinds(h2.log).includes('cloudDelete') && !kinds(h2.log).includes('legacyRestore'));
  assert.match(h2.toasts[0].msg, /Its stock had already been restored to inventory by an earlier attempt \(2 item line\(s\)\); no additional stock was added\./);
  // A third attempt on another counter / double click is still a no-op for stock.
  const h3 = runDelete({ restore: srv.restore('ok') });
  await h3.run();
  assert.deepStrictEqual(srv.restoredPerLine, { m1: 1, m2: 1 });
});
test('6l. request never reached the server -> "result unknown", nothing deleted; retry -> restored once and removed', async () => {
  const srv = fakeServer();
  const h1 = runDelete({ restore: srv.restore('unreachable') });
  await h1.run();
  unknownOutcome(h1, 'unreachable');
  assert.deepStrictEqual(srv.restoredPerLine, { m1: 0, m2: 0 });
  const h2 = runDelete({ restore: srv.restore('ok') });
  await h2.run();
  assert.deepStrictEqual(srv.restoredPerLine, { m1: 1, m2: 1 });
  assert.match(h2.toasts[0].msg, /removed and 6 unit\(s\) returned to inventory!/);
  assert.ok(kinds(h2.log).includes('cloudDelete'));
});
test('6i. server function not installed (pre-deployment) -> unchanged line-based restore path', async () => {
  for (const opt of [{ restore: async () => ({ status: 'RPC_MISSING' }) }, { missingRestore: true }]) {
    const h = runDelete(opt);
    await h.run();
    const k = kinds(h.log);
    assert.ok(k.includes('legacyRestore') && k.includes('cancelLocal') && k.includes('cloudDelete'), k.join());
  }
});
test('6b. badge: acknowledged items are neither pending nor in review; review click opens the review list', () => {
  const block = between(bundle, 'function AutoSyncBadgeComponent() {', 'function StockValuationAdminComponent() {');
  assert.match(block, /op\.sync_status !== "REVIEW_ACKNOWLEDGED"/);
  assert.match(block, /inReview \? setShowStockReview\(true\) : handleSyncClick\(\)/);
});
test('6c. review screen renders each item with its exact reason, line detail and the allowed actions', () => {
  const React = require('react'); const jsx = require('react/jsx-runtime'); const { renderToStaticMarkup } = require('react-dom/server');
  const block = between(bundle, 'function vhcReviewLineText(l) {', 'function StockValuationAdminComponent() {');
  const items = [
    { bill_id: 'BILL-77', sync_status: 'STOCK_CONFLICT', last_error: 'x', review: { code: 'CONFLICT_INSUFFICIENT_STOCK', title: 'The cloud batch has less stock than this bill sold.', canRetry: true, canRetryCurrentBatch: false,
      lines: [{ key: 'm1', status: 'PENDING' }, { key: 'm2', status: 'CONFLICT_INSUFFICIENT_STOCK', cloud_stock: 1, needed: 3 }], detail: 'STOCK_RECONCILIATION_CONFLICT: bill=BILL-77' } },
    { bill_id: 'BILL-78', sync_status: 'STOCK_CONFLICT', last_error: 'y', review: { code: 'CONFLICT_BATCH_NOT_FOUND', title: 'The batch ... deleted', canRetry: true, canRetryCurrentBatch: true, lines: [], detail: 'y' } },
  ];
  let n = 0;
  const _ = { ...React, useState: (init) => { n += 1; return [n === 1 ? items : init, () => {}]; }, useEffect: () => {} };
  const Comp = new Function('_', 'J', 'window', `${block}; return StockReviewModalComponent;`)(_, jsx, {});
  const html = renderToStaticMarkup(React.createElement(Comp, { onClose() {} }));
  assert.match(html, /Bills needing stock review/);
  assert.match(html, /Bill BILL-77 — CONFLICT_INSUFFICIENT_STOCK/);
  assert.match(html, /The cloud batch has less stock than this bill sold\./);
  assert.match(html, /m2: CONFLICT_INSUFFICIENT_STOCK • cloud stock 1 • needed 3/);
  assert.strictEqual((html.match(/Retry stock/g) || []).length, 2);
  assert.strictEqual((html.match(/Apply to current batch \(admin\)/g) || []).length, 1, 'only for a deleted batch');
  assert.strictEqual((html.match(/Close with reason \(admin\)/g) || []).length, 2);
  assert.match(html, /Do not delete or re-create batches/);
});

test('1f. T7: while a bill delete holds the sync-exclusive section no sync run can start; a running sync blocks it', async () => {
  await freshDb();
  const { sync } = loadWorker(db, makeCloud());
  const plain = (x) => JSON.parse(JSON.stringify(x));
  let during = null;
  const res = await sync.runExclusiveOfFinancialSync(async () => { during = await sync.run({ reachabilityVerified: true }); return 'done'; });
  assert.deepStrictEqual(plain(res), { ok: true, value: 'done' });
  assert.deepStrictEqual(plain(during), { skipped: true, reason: 'sync already running' }, 'no sync run while the delete holds the section');
  assert.deepStrictEqual(plain(await sync.runExclusiveOfFinancialSync(async () => 'second')), { ok: true, value: 'second' }, 'released after use');
  // A sync that is still running: the delete gives up after waitMs without running anything.
  let ran = false;
  const outer = await sync.runExclusiveOfFinancialSync(async () => sync.runExclusiveOfFinancialSync(async () => { ran = true; }, { waitMs: 0 }));
  assert.strictEqual(outer.value.ok, false); assert.strictEqual(outer.value.busy, true); assert.strictEqual(ran, false);
  // An exception inside releases the section.
  await assert.rejects(sync.runExclusiveOfFinancialSync(async () => { throw new Error('boom'); }), (e) => /boom/.test(e.message));
  assert.deepStrictEqual(plain(await sync.runExclusiveOfFinancialSync(async () => 3)), { ok: true, value: 3 });
});

// ─── 7. Startup: realtime (the trigger that refreshes the screens on cloud changes) must not be lost ─────────
// Reported symptom: stock corrected in the cloud, desktop inventory kept the old quantity. A failed or session-less
// init() at app start used to leave the whole session WITHOUT the realtime subscription, with nothing retrying.
for (const [label, file, indent] of [['cloud-src', 'cloud-src/vhc-cloud-sync.js', ''], ['dist bundle', 'dist/assets/vhc-cloud-sync.js', '  ']]) {
  const initSrc = fnText(read(file), 'init', indent);
  const makeInit = (o) => {
    const calls = [];
    const fn = new Function('o', 'calls', 'window', `
      let currentSession = null;
      const installEnvironmentIndicator = () => {};
      const getSession = async () => { currentSession = o.session; return o.session; };
      const ensurePharmacyLocation = async () => { calls.push('location'); if (o.locFail) throw new Error('location'); };
      const fetchInventory = async () => { calls.push('inventory'); if (o.invFail) throw new Error('inventory fetch failed'); return []; };
      const fetchPatients = async () => { calls.push('patients'); if (o.patFail) throw new Error('patients fetch failed'); return []; };
      const fetchSalesHistory = async () => { calls.push('sales'); return []; };
      const fetchPendingPharmacyTransfers = async () => [];
      const autoRecoverLocalInventoryIfNeeded = async () => { calls.push('autoRecover'); };
      const startRealtime = async () => { calls.push('realtime'); };
      const emit = () => {};
      ${initSrc}
      return init;`)(o, calls, { __vhcTransferPollTimer: 1 });
    return { init: fn, calls };
  };
  test(`7a [${label}] init: no session -> reported error (was a silent return); nothing started`, async () => {
    const { init, calls } = makeInit({ session: null });
    await assert.rejects(init(), (e) => e.code === 'AUTH_SESSION_MISSING');
    assert.ok(!calls.includes('realtime'));
  });
  test(`7b [${label}] init: an initial fetch fails -> realtime STILL starts, then the failure is reported (caller retries)`, async () => {
    let { init, calls } = makeInit({ session: { user: { id: 'u' } }, patFail: true });
    await assert.rejects(init(), /patients fetch failed/);
    assert.ok(calls.includes('realtime'), 'realtime started despite the failed fetch');
    assert.ok(calls.includes('autoRecover'), 'inventory read succeeded -> recovery check may run');
    ({ init, calls } = makeInit({ session: { user: { id: 'u' } }, invFail: true }));
    await assert.rejects(init(), /inventory fetch failed/);
    assert.ok(calls.includes('realtime'));
    assert.ok(!calls.includes('autoRecover'), 'a failed inventory read must never look like an empty cloud inventory');
    ({ init, calls } = makeInit({ session: { user: { id: 'u' } } }));
    await init();
    assert.deepStrictEqual(calls.filter((c) => c === 'realtime').length, 1);
  });
}
test('7c. startup gate: a failed cloud init is retried (15 s, 30 s, 60 s, then 2 min) until it succeeds; screens reload once; stops on sign-out', async () => {
  const fnSrc = between(bundle, 'function vhcScheduleCloudInitRetry(attempt) {', '\nfunction VhcCloudAuthGate(');
  const timers = []; const events = []; const logs = [];
  let results = [{ error: 'fetch failed' }, { error: 'fetch failed' }, {}];
  let initCalls = 0;
  const win = { VHC_CLOUD: { init: async () => { initCalls += 1; return results.shift(); } }, dispatchEvent: (e) => events.push(e.detail), __vhcCloudInitRetryTimer: null };
  const sched = new Function('window', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent', `${fnSrc}\nreturn vhcScheduleCloudInitRetry;`)(
    win, (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {}, { warn: (...a) => logs.push(a), log: (...a) => logs.push(a) },
    class { constructor(t, i) { this.type = t; this.detail = i.detail; } });
  sched(1);
  for (let i = 0; i < 3; i++) await timers[i].fn();
  assert.deepStrictEqual(timers.map((t) => t.ms), [15000, 30000, 60000]);
  assert.strictEqual(initCalls, 3);
  assert.deepStrictEqual(events.map((e) => e.table), ['stock_batches', 'patients'], 'inventory + patients reloaded once after success');
  assert.strictEqual(timers.length, 3, 'no further retries after success');
  // Long outage: capped at 2 minutes.
  results = Array(10).fill({ error: 'offline' }); timers.length = 0; sched(1);
  for (let i = 0; i < 6; i++) await timers[i].fn();
  assert.deepStrictEqual(timers.slice(0, 7).map((t) => t.ms), [15000, 30000, 60000, 120000, 120000, 120000, 120000]);
  // Sign-out cancels the pending retry and the gate wires it.
  const gate = between(bundle, '    let onSignedOut = () => {', '    };');
  assert.match(gate, /clearTimeout\(window\.__vhcCloudInitRetryTimer\)/);
  const gateInit = between(bundle, '        setSession(s);\n        let initResult = await window.VHC_CLOUD.init();', '      } else if');
  assert.match(gateInit, /vhcScheduleCloudInitRetry\(1\)/);
});

(async () => {
  db = await import(pathToFileURL(path.join(ROOT, 'electron', 'database.js')).href);
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log(`PASS ${t.name}`); }
    catch (error) { console.error(`FAIL ${t.name}`); console.error(error); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  try { db.closeDatabase(); } catch (e) {}
})();
