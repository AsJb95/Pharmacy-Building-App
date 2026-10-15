#!/usr/bin/env node
// v3.19.2/v3.19.3 staged, idempotent sync. Runs the REAL financial sync worker (dist/assets/vhc-audit-engine.js,
// loaded in a vm sandbox) against the REAL local SQLite layer (electron/database.js on a temp DB),
// with a scripted in-memory cloud. Must run under Electron's Node (better-sqlite3 ABI):
//   set ELECTRON_RUN_AS_NODE=1 && electron test/financial-sync-order.test.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ROOT = path.join(__dirname, '..');
const CLOUD_ITEM = '11111111-1111-4111-8111-111111111111';
const CLOUD_BATCH = '22222222-2222-4222-8222-222222222222';
const CLOUD_LOCATION = '33333333-3333-4333-8333-333333333333';
let seq = 0;
const uuid = () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++seq).padStart(12, '0')}`;

// In-memory cloud whose stock RPC follows the SAME contract as
// supabase/migrations/20261015000100_v3193_apply_bill_stock_movement.sql (proven against real
// PostgreSQL by test/apply-bill-stock-movement.pg.mjs): delta applied to the CURRENT batch qty,
// exactly once per movement_key, a different movement under an existing key is a conflict.
function makeCloud() {
  const sales = new Map();          // bill_id -> sales row with sale_items
  const movements = new Map();      // movement_key -> movement
  const batches = new Map();        // stock_batch_id -> qty (lazily = the counter's opening)
  const calls = { find: 0, create: 0, reconcile: 0, apply: 0, legacy: 0 };
  // apply | conflict | network (fails before commit) | lose-response (commits, reply lost) | missing (RPC not deployed)
  let stockMode = 'apply';
  const qtyOf = (p) => { if (!batches.has(p.stock_batch_id)) batches.set(p.stock_batch_id, Number(p.expected_opening)); return batches.get(p.stock_batch_id); };
  function applyDelta(payload) {
    const existing = movements.get(payload.movement_key);
    if (existing) {
      const same = existing.bill_id === payload.bill_id && Math.abs(existing.qty - payload.quantity_delta) < 0.0005 && existing.stock_batch_id === payload.stock_batch_id;
      return same ? { status: 'ALREADY_APPLIED' } : { status: 'CONFLICT_MOVEMENT_MISMATCH' };
    }
    const opening = qtyOf(payload);
    const closing = opening + payload.quantity_delta;
    if (closing < -0.0005) return { status: 'CONFLICT_INSUFFICIENT_STOCK', actual_opening: opening };
    batches.set(payload.stock_batch_id, closing);
    movements.set(payload.movement_key, { movement_key: payload.movement_key, bill_id: payload.bill_id, qty: payload.quantity_delta, stock_batch_id: payload.stock_batch_id, opening, closing });
    return { status: 'APPLIED', opening, closing, drift: opening - Number(payload.expected_opening) };
  }
  const cloud = {
    calls, sales, movements, batches,
    setStockMode(mode) { stockMode = mode; },
    setBatchQty(id, qty) { batches.set(id, qty); },
    api: {
      async applyBillStockMovementStrict(payload) {
        calls.reconcile += 1; calls.apply += 1;
        if (stockMode === 'missing') return { status: 'RPC_MISSING' };
        if (stockMode === 'network') throw new TypeError('Failed to fetch');
        if (stockMode === 'conflict') return { status: 'CONFLICT_INSUFFICIENT_STOCK', actual_opening: 0 };
        const r = applyDelta(payload);
        if (stockMode === 'lose-response') throw new TypeError('Failed to fetch'); // committed server-side, reply lost
        return r;
      },
      async findSaleByBillIdStrict(billId) { calls.find += 1; const row = sales.get(billId); return row ? JSON.parse(JSON.stringify(row)) : null; },
      async createSaleStrict(payload) {
        calls.create += 1;
        const existing = sales.get(payload.billId);
        const row = existing || { id: uuid(), bill_id: payload.billId, sale_items: [] };
        Object.assign(row, { total_amount: String(payload.totalAmount), amount_received: payload.amountReceived, outstanding_amount: payload.outstandingAmount, payment_status: payload.paymentStatus });
        // idempotent replay: one row per logical line, never duplicated
        payload.items.forEach((it, i) => {
          if (!row.sale_items[i]) row.sale_items[i] = { id: uuid(), sale_id: row.id, drug_name: it.drugName, quantity: `${Number(it.quantity).toFixed(3)}`, total: `${Number(it.total).toFixed(2)}`, category: 'medicine' };
        });
        sales.set(payload.billId, row);
        return { id: row.id };
      },
      // legacy absolute compare-and-set (reconcile_stock_movement), used only when the new RPC is missing
      async reconcileStockMovementStrict(payload) {
        calls.reconcile += 1; calls.legacy += 1;
        if (movements.has(payload.movement_key)) return { status: 'ALREADY_APPLIED' };
        const opening = qtyOf(payload);
        if (Math.abs(opening - Number(payload.expected_opening)) > 0.0005) return { status: 'CONFLICT', actual_opening: opening };
        batches.set(payload.stock_batch_id, Number(payload.closing));
        movements.set(payload.movement_key, { movement_key: payload.movement_key, bill_id: payload.bill_id, qty: payload.quantity_delta, stock_batch_id: payload.stock_batch_id });
        return { status: 'APPLIED' };
      },
      async findStockMovementByKeyStrict(key) { return movements.get(key) || null; },
      async fetchInventory() { return []; },
      async getSession() { return { user: { id: 'u' } }; },
      describeCloudError(e) { return { code: e && e.code || null, message: e && e.message ? e.message : String(e), details: null, hint: null }; },
    },
  };
  return cloud;
}

function loadWorker(db, cloud) {
  const store = new Map();
  const listeners = new Map();
  const window = {
    electronAPI: {
      getLocalSale: async (b) => db.getLocalSaleByBillId(b),
      markFinancialSyncAttempt: async (b, e) => db.markFinancialSyncAttempt(b, e),
      markFinancialSyncConfirmed: async (b, id) => db.markFinancialSyncConfirmed(b, id),
      markFinancialSyncSaleConfirmed: async (b, id) => db.markFinancialSyncSaleConfirmed(b, id),
      markFinancialSyncStockPending: async (b, e) => db.markFinancialSyncStockPending(b, e),
      markFinancialSyncReviewRequired: async (b, s, d, id) => db.markFinancialSyncReviewRequired(b, s, d, id),
      getUnsyncedFinancialSyncOperations: async () => db.getUnsyncedFinancialSyncOperations(),
    },
    VHC_CLOUD: cloud.api,
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatchEvent() { return true; },
  };
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
  assert.ok(sync && sync._syncOneFinancialOperation, 'worker export');
  return {
    sync,
    // one worker pass over exactly the operations the real DB says are retryable
    async runOnce() {
      const ops = db.getUnsyncedFinancialSyncOperations();
      const results = [];
      for (const op of ops) results.push(await sync._syncOneFinancialOperation(op));
      return results;
    },
  };
}

let db;
function newSale(prefix, qty = 1) {
  const billId = `${prefix}-${Date.now()}-${++seq}`;
  const res = db.createLocalSale({
    billId, patientSnapshot: { name: 'Order Test' }, paymentMode: 'Cash', totalAmount: 10 * qty,
    paymentDetails: { breakdown: { Cash: 10 * qty }, amountReceived: 10 * qty, outstandingAmount: 0, status: 'Paid' },
    items: [{ name: `Drug ${prefix}`, category: 'Medicine', batch: `B-${prefix}-${seq}`, expiry: '12/28', mrp: 10, unitsPerPack: 1,
      qty, stock: 50, itemId: CLOUD_ITEM, cloudBatchId: CLOUD_BATCH, cloudLocationId: CLOUD_LOCATION }],
    extraParticulars: [],
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  return billId;
}
// Multi-line bill: lines = [{ batchId, qty, mrp, unitsPerPack, stock }]
const CLOUD_BATCH_2 = '22222222-2222-4222-8222-000000000002';
function newMultiSale(prefix, lines) {
  const billId = `${prefix}-${Date.now()}-${++seq}`;
  const total = lines.reduce((s, l) => s + (l.mrp / (l.unitsPerPack || 1)) * l.qty, 0);
  const res = db.createLocalSale({
    billId, patientSnapshot: { name: 'Order Test' }, paymentMode: 'Cash', totalAmount: total,
    paymentDetails: { breakdown: { Cash: total }, amountReceived: total, outstandingAmount: 0, status: 'Paid' },
    items: lines.map((l, i) => ({ name: `Drug ${prefix} ${i}`, category: 'Medicine', batch: `B-${prefix}-${seq}-${i}`, expiry: '12/28',
      mrp: l.mrp, unitsPerPack: l.unitsPerPack || 1, qty: l.qty, stock: l.stock ?? 50, itemId: CLOUD_ITEM, cloudBatchId: l.batchId, cloudLocationId: CLOUD_LOCATION })),
    extraParticulars: [],
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  return billId;
}
const op = (billId) => db.getFinancialSyncOperations().find((x) => x.bill_id === billId);
const only = (billId) => ({ ...op(billId) });

// Each test gets a fresh DB so cross-test operations never interfere.
let currentDbPath = null;
async function freshDb() {
  if (db) db.closeDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhc-sync-order-'));
  currentDbPath = path.join(dir, 'vhc_pharmacy.db');
  db.initDatabase(currentDbPath);
}

test('A. cloud sale confirmation is persisted BEFORE stock reconciliation can fail', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('ORDER');
  cloud.setStockMode('conflict');
  const [r] = await w.runOnce();
  const row = only(billId);
  assert.strictEqual(cloud.calls.create, 1);
  assert.ok(row.cloud_sale_id && row.cloud_sale_id === cloud.sales.get(billId).id, 'real cloud sales.id persisted');
  assert.notStrictEqual(row.sync_status, 'SYNC_FAILED');
  assert.strictEqual(r.saleConfirmed, true);
});

test('C. stock CONFLICT stays visible/auditable, is not SYNC_FAILED and causes no further uploads or retries', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('CONFLICT');
  cloud.setStockMode('conflict');
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'STOCK_CONFLICT');
  assert.match(only(billId).last_error, /STOCK_RECONCILIATION_CONFLICT/);
  const before = { ...cloud.calls };
  for (let i = 0; i < 10; i += 1) await w.runOnce();
  assert.strictEqual(cloud.calls.create, before.create, 'no re-upload');
  assert.strictEqual(cloud.calls.find, before.find, 'no further lookups');
  assert.strictEqual(cloud.calls.reconcile, before.reconcile, 'conflict is not retried automatically');
  assert.strictEqual(only(billId).sync_status, 'STOCK_CONFLICT');
  assert.strictEqual(cloud.sales.size, 1);
  assert.strictEqual(cloud.sales.get(billId).sale_items.length, 1);
});

test('C2. transient stock failure retries the stock step ONLY (no lookup, no upload) and then confirms', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('TRANSIENT');
  cloud.setStockMode('network');
  const [r1] = await w.runOnce();
  assert.strictEqual(r1.stockPending, true);
  assert.strictEqual(only(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  const savedId = only(billId).cloud_sale_id;
  assert.ok(savedId);
  const afterFirst = { ...cloud.calls };
  cloud.setStockMode('apply');
  await w.runOnce();
  assert.strictEqual(cloud.calls.create, afterFirst.create, 'no re-upload on retry');
  assert.strictEqual(cloud.calls.find, afterFirst.find, 'no sale lookup on stock-only retry');
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(only(billId).cloud_sale_id, savedId);
  assert.strictEqual(cloud.movements.size, 1);
});

test('B. existing EXACT cloud sale on retry: content verified, real cloud id saved, no re-upload, retries stop', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('EXISTING', 2);
  const local = db.getLocalSaleByBillId(billId);
  const cloudId = uuid();
  cloud.sales.set(billId, { id: cloudId, bill_id: billId, total_amount: '20.00', amount_received: 20, outstanding_amount: 0, payment_status: 'Paid',
    sale_items: local.sale_items.map((it) => ({ id: uuid(), sale_id: cloudId, drug_name: it.drug_name, quantity: '2.000', total: '20.00' })) });
  await w.runOnce();
  assert.strictEqual(cloud.calls.create, 0, 'never re-uploaded');
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(only(billId).cloud_sale_id, cloudId);
  const calls = { ...cloud.calls };
  for (let i = 0; i < 5; i += 1) await w.runOnce();
  assert.deepStrictEqual(cloud.calls, calls, 'confirmed bill is never retried');
});

test('B2. existing cloud sale with DIFFERENT content -> SALE_MISMATCH once; never re-uploaded or retried', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('DIFF');
  cloud.sales.set(billId, { id: uuid(), bill_id: billId, total_amount: '10.00', amount_received: 10, outstanding_amount: 0, payment_status: 'Paid',
    sale_items: [{ id: uuid(), drug_name: 'Some Other Drug', quantity: '1.000', total: '10.00' }] });
  const [r] = await w.runOnce();
  assert.strictEqual(r.reviewRequired, 'SALE_MISMATCH');
  assert.strictEqual(only(billId).sync_status, 'SALE_MISMATCH');
  assert.match(only(billId).last_error, /content mismatch/);
  const calls = { ...cloud.calls };
  for (let i = 0; i < 5; i += 1) await w.runOnce();
  assert.deepStrictEqual(cloud.calls, calls);
  assert.strictEqual(cloud.calls.create, 0);
});

test('B3. cloud sale missing items is repaired by ONE idempotent replay, then confirmed', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('PARTIAL');
  cloud.sales.set(billId, { id: uuid(), bill_id: billId, total_amount: '10.00', amount_received: 10, outstanding_amount: 0, payment_status: 'Paid', sale_items: [] });
  await w.runOnce();
  assert.strictEqual(cloud.calls.create, 1);
  assert.strictEqual(cloud.sales.get(billId).sale_items.length, 1);
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
});

test('D. a row without a valid sales.id (e.g. sale_items-shaped sale_id) is NEVER stored as the cloud sale id', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('WRONGID');
  const realSaleId = uuid();
  cloud.sales.set(billId, { sale_id: realSaleId, bill_id: billId, total_amount: '10.00', amount_received: 10, outstanding_amount: 0, payment_status: 'Paid',
    sale_items: [{ id: uuid(), drug_name: `Drug WRONGID`, quantity: '1.000', total: '10.00' }] });
  const [r] = await w.runOnce();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /CLOUD_SALE_ID_INVALID/);
  assert.strictEqual(only(billId).cloud_sale_id, null);
  assert.notStrictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.calls.create, 0);
});

test('D2. a cloud row for a DIFFERENT bill_id is never accepted as confirmation', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('OTHERBILL');
  cloud.sales.set(billId, { id: uuid(), bill_id: 'BILL-SOMETHING-ELSE', total_amount: '10.00', sale_items: [{ drug_name: 'Drug OTHERBILL', quantity: '1.000', total: '10.00' }] });
  await w.runOnce();
  assert.notStrictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(only(billId).cloud_sale_id, null);
});

test('F. a bill deleted locally before syncing is CANCELLED and never uploaded (no self-made ghost)', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('DELETED');
  assert.strictEqual(db.cancelLocalSale(billId).success, true);
  for (let i = 0; i < 3; i += 1) await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CANCELLED');
  assert.strictEqual(cloud.calls.find + cloud.calls.create + cloud.calls.reconcile, 0, 'no cloud call at all');
  // defense in depth: even if such an op reaches the worker, a non-active sale is refused
  const r = await w.sync._syncOneFinancialOperation({ ...only(billId), sync_status: 'PENDING_CLOUD' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /LOCAL_SALE_NOT_ACTIVE/);
  assert.strictEqual(cloud.calls.create, 0);
});

// ─── v3.19.3: delta-based idempotent stock stage ───────────────────────────────────────────────
test('ROOT CAUSE: cloud stock changed after checkout (drift) -> applied on real qty, NOT a conflict, no cascade', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const bill1 = newSale('DRIFT1');                 // counter opening 50
  cloud.setBatchQty(CLOUD_BATCH, 48);              // warehouse/other terminal moved stock meanwhile
  await w.runOnce();
  assert.strictEqual(only(bill1).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 47, 'deducted from the real cloud qty');
  const bill2 = newSale('DRIFT2');                 // the old design conflicted here (cascade)
  await w.runOnce();
  assert.strictEqual(only(bill2).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 46);
  assert.strictEqual(cloud.calls.legacy, 0);
});

test('A. normal sale: sale once, items once, stock once, movement once, CLOUD_CONFIRMED', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('NORMAL', 3);
  await w.runOnce();
  assert.strictEqual(cloud.sales.size, 1);
  assert.strictEqual(cloud.sales.get(billId).sale_items.length, 1);
  assert.strictEqual(cloud.movements.size, 1);
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 47);
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
});

test('C. stock committed but response lost -> retry detects it: no second deduction, no duplicate movement', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('LOST');
  cloud.setStockMode('lose-response');
  const [r1] = await w.runOnce();
  assert.strictEqual(r1.stockPending, true, 'treated as transient');
  assert.strictEqual(only(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49, 'server did commit once');
  cloud.setStockMode('apply');
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49, 'not deducted twice');
  assert.strictEqual(cloud.movements.size, 1);
  assert.strictEqual(cloud.calls.create, 1, 'sale not re-created');
});

test('D. movement already exists: same movement = success; different movement = STOCK_CONFLICT, no mutation', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const same = newSale('SAMEKEY');
  const key = `VHC:BILL:${same}:${db.getLocalSaleByBillId(same).stock_movements[0].id}`;
  cloud.movements.set(key, { movement_key: key, bill_id: same, qty: -1, stock_batch_id: CLOUD_BATCH });
  cloud.setBatchQty(CLOUD_BATCH, 49);
  await w.runOnce();
  assert.strictEqual(only(same).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49, 'existing movement accepted, no deduction');
  const diff = newSale('DIFFKEY');
  const key2 = `VHC:BILL:${diff}:${db.getLocalSaleByBillId(diff).stock_movements[0].id}`;
  cloud.movements.set(key2, { movement_key: key2, bill_id: 'BILL-SOMEONE-ELSE', qty: -5, stock_batch_id: CLOUD_BATCH });
  await w.runOnce();
  assert.strictEqual(only(diff).sync_status, 'STOCK_CONFLICT');
  assert.match(only(diff).last_error, /CONFLICT_MOVEMENT_MISMATCH/);
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49, 'no mutation on conflict');
});

test('E. app closes after cloud sale, before stock -> restart resumes the stock stage only', async () => {
  await freshDb();
  const cloud = makeCloud(); let w = loadWorker(db, cloud);
  const billId = newSale('CRASH-E');
  cloud.setStockMode('network');                 // sale lands, stock request never reaches the server
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  // "restart": close + reopen the real local DB, fresh worker instance
  const dbPath = currentDbPath;
  db.closeDatabase(); db.initDatabase(dbPath);
  cloud.setStockMode('apply');
  w = loadWorker(db, cloud);
  const before = { ...cloud.calls };
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.calls.create, before.create, 'sale not re-created');
  assert.strictEqual(cloud.calls.find, before.find, 'no sale lookup on resume');
  assert.strictEqual(cloud.movements.size, 1);
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49);
});

test('F. app closes after stock, before final status -> restart proves cloud state and completes, no replay', async () => {
  await freshDb();
  const cloud = makeCloud(); let w = loadWorker(db, cloud);
  const billId = newSale('CRASH-F');
  cloud.setStockMode('lose-response');            // stock committed; the app never recorded it
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'SALE_CONFIRMED_STOCK_PENDING');
  const dbPath = currentDbPath;
  db.closeDatabase(); db.initDatabase(dbPath);
  cloud.setStockMode('apply');
  w = loadWorker(db, cloud);
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49, 'stock deducted exactly once');
  assert.strictEqual(cloud.movements.size, 1);
});

test('G. no internet: bill stays saved locally and queued; nothing written to the cloud; recovers later', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const realFind = cloud.api.findSaleByBillIdStrict;
  cloud.api.findSaleByBillIdStrict = async () => { throw new TypeError('Failed to fetch'); };
  const billId = newSale('OFFLINE');
  assert.ok(db.getLocalSaleByBillId(billId), 'local bill exists (checkout never depended on the cloud)');
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'SYNC_FAILED');
  assert.strictEqual(cloud.sales.size + cloud.movements.size, 0, 'no partial cloud state');
  cloud.api.findSaleByBillIdStrict = realFind;
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.sales.size, 1); assert.strictEqual(cloud.movements.size, 1);
});

test('H/I/J. multi-line, multi-batch bill with strip/unit quantities: each movement applied exactly once', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  // line 1: 10 units = 1 strip of 10 (unitsPerPack 10), line 2: 3 units of another batch
  const billId = newMultiSale('MULTI', [
    { batchId: CLOUD_BATCH, qty: 10, mrp: 100, unitsPerPack: 10, stock: 40 },
    { batchId: CLOUD_BATCH_2, qty: 3, mrp: 30, unitsPerPack: 1, stock: 12 },
  ]);
  cloud.setStockMode('lose-response');           // both lines commit, replies lost
  await w.runOnce();
  cloud.setStockMode('apply');
  for (let i = 0; i < 3; i += 1) await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 30, '40 - 10 units, once');
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH_2), 9, '12 - 3 units, once');
  assert.strictEqual(cloud.movements.size, 2);
  assert.strictEqual(cloud.sales.get(billId).sale_items.length, 2);
});

test('K/L/M. repeated cycles and duplicate concurrent invocations of the same operation: everything once', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('DUPINV');
  const opRow = only(billId);
  await Promise.all([w.sync._syncOneFinancialOperation(opRow), w.sync._syncOneFinancialOperation(opRow), w.sync._syncOneFinancialOperation(opRow)]);
  for (let i = 0; i < 5; i += 1) await w.runOnce();
  assert.strictEqual(cloud.sales.size, 1);
  assert.strictEqual(cloud.sales.get(billId).sale_items.length, 1);
  assert.strictEqual(cloud.movements.size, 1);
  assert.strictEqual(cloud.batches.get(CLOUD_BATCH), 49);
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
});

test('new RPC not deployed yet -> falls back to the legacy reconcile (no failure loop)', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  cloud.setStockMode('missing');
  const billId = newSale('LEGACY');
  await w.runOnce();
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(cloud.calls.legacy, 1);
  assert.strictEqual(cloud.movements.size, 1);
});

test('bounded backoff: a failed operation is not retried every cycle; the delay grows and is capped', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const { _isDueForRetry, _retryDelayMs } = w.sync;
  assert.strictEqual(_retryDelayMs(0), 0);
  assert.strictEqual(_retryDelayMs(1), 30000);
  assert.strictEqual(_retryDelayMs(3), 120000);
  assert.strictEqual(_retryDelayMs(50), 15 * 60 * 1000);
  const now = Date.now();
  assert.strictEqual(_isDueForRetry({ retry_count: 2, last_attempt_at: new Date(now - 10000).toISOString() }, now), false);
  assert.strictEqual(_isDueForRetry({ retry_count: 2, last_attempt_at: new Date(now - 61000).toISOString() }, now), true);
  assert.strictEqual(_isDueForRetry({ retry_count: 0, last_attempt_at: new Date(now).toISOString() }, now), true, 'fresh/crashed attempt is due immediately');
});

test('happy path: ten worker runs create the cloud sale once and confirm with its real id', async () => {
  await freshDb();
  const cloud = makeCloud(); const w = loadWorker(db, cloud);
  const billId = newSale('HAPPY');
  for (let i = 0; i < 10; i += 1) await w.runOnce();
  assert.strictEqual(cloud.calls.create, 1);
  assert.strictEqual(cloud.sales.size, 1);
  assert.strictEqual(cloud.movements.size, 1);
  assert.strictEqual(only(billId).sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(only(billId).cloud_sale_id, cloud.sales.get(billId).id);
});

(async () => {
  db = await import(pathToFileURL(path.join(ROOT, 'electron', 'database.js')).href);
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log(`PASS ${t.name}`); }
    catch (error) { console.error(`FAIL ${t.name}`); console.error(error); process.exitCode = 1; }
  }
  try { db.closeDatabase(); } catch (e) {}
  console.log(`\nfinancial-sync-order tests: ${passed}/${tests.length} passed`);
})();
