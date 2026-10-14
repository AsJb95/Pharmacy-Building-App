#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeRpc(seed) {
  const batches = new Map(seed.map((row) => [row.id, { ...row }]));
  const movements = new Map();
  function reconcile(payload) {
    if (movements.has(payload.movement_key)) {
      return { status: 'ALREADY_APPLIED', ...movements.get(payload.movement_key) };
    }
    let batch;
    if (payload.stock_batch_id) {
      batch = batches.get(payload.stock_batch_id);
      if (!batch) throw new Error('not found');
      if (payload.item_id && batch.item_id !== payload.item_id) throw new Error('item mismatch');
      if (payload.location_id && batch.location_id !== payload.location_id) throw new Error('location mismatch');
    } else {
      const matches = [...batches.values()].filter((row) =>
        row.item_id === payload.item_id && row.location_id === payload.location_id &&
        String(row.batch_no || '').trim().toLowerCase() === String(payload.batch_no || '').trim().toLowerCase());
      if (matches.length === 0) throw new Error('not found');
      if (matches.length !== 1) throw new Error('ambiguous');
      batch = matches[0];
    }
    if (Number(batch.qty) !== Number(payload.expected_opening)) {
      return { status: 'CONFLICT', actual_opening: batch.qty };
    }
    batch.qty = payload.closing;
    const movement = { movement_key: payload.movement_key, stock_batch_id: batch.id,
      opening: payload.expected_opening, closing: payload.closing, qty: payload.quantity_delta };
    movements.set(payload.movement_key, movement);
    return { status: 'APPLIED', ...movement };
  }
  return { batches, movements, reconcile };
}

const baseBatch = { id: 'cloud-batch', item_id: 'cloud-item', location_id: 'cloud-location', batch_no: 'B-1', qty: 25 };
const payload = { movement_key: 'VHC:BILL:BILL-1:movement-1', bill_id: 'BILL-1', stock_batch_id: 'cloud-batch',
  item_id: 'cloud-item', location_id: 'cloud-location', batch_no: 'B-1', expected_opening: 25,
  closing: 24, quantity_delta: -1, movement_type: 'BILL' };

test('exact cloud batch id reconciles 25 to 24 once', () => {
  const rpc = makeRpc([baseBatch]);
  assert.strictEqual(rpc.reconcile(payload).status, 'APPLIED');
  assert.strictEqual(rpc.batches.get('cloud-batch').qty, 24);
  assert.strictEqual(rpc.movements.size, 1);
});

test('fallback item/location/batch match reconciles exactly one row', () => {
  const rpc = makeRpc([baseBatch]);
  assert.strictEqual(rpc.reconcile({ ...payload, stock_batch_id: null }).status, 'APPLIED');
  assert.strictEqual(rpc.batches.get('cloud-batch').qty, 24);
});

test('zero fallback matches fail closed', () => {
  const rpc = makeRpc([baseBatch]);
  assert.throws(() => rpc.reconcile({ ...payload, stock_batch_id: null, batch_no: 'missing' }), /not found/);
  assert.strictEqual(rpc.batches.get('cloud-batch').qty, 25);
});

test('ambiguous fallback matches fail closed', () => {
  const rpc = makeRpc([baseBatch, { ...baseBatch, id: 'cloud-batch-2' }]);
  assert.throws(() => rpc.reconcile({ ...payload, stock_batch_id: null }), /ambiguous/);
  assert.strictEqual([...rpc.batches.values()].reduce((n, row) => n + row.qty, 0), 50);
});

test('same deterministic movement key ten retries mutates stock once', () => {
  const rpc = makeRpc([baseBatch]);
  for (let i = 0; i < 10; i += 1) assert.ok(['APPLIED', 'ALREADY_APPLIED'].includes(rpc.reconcile(payload).status));
  assert.strictEqual(rpc.batches.get('cloud-batch').qty, 24);
  assert.strictEqual(rpc.movements.size, 1);
});

test('concurrent cloud change returns conflict without overwrite', () => {
  const rpc = makeRpc([{ ...baseBatch, qty: 23 }]);
  const result = rpc.reconcile(payload);
  assert.strictEqual(result.status, 'CONFLICT');
  assert.strictEqual(result.actual_opening, 23);
  assert.strictEqual(rpc.batches.get('cloud-batch').qty, 23);
  assert.strictEqual(rpc.movements.size, 0);
});

// v3.19.2: the cloud SALE is confirmed (real cloud id persisted) before stock reconciliation;
// CLOUD_CONFIRMED still requires the stock step, and a conflict becomes the visible STOCK_CONFLICT
// review state instead of a generic upload failure. Behaviour is covered end-to-end by
// test/financial-sync-order.test.cjs; this pins the ordering in the shipped source.
test('worker confirms the cloud sale before stock, and stock before CLOUD_CONFIRMED; conflict is a review state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  const saleConfirmedAt = source.indexOf('await window.electronAPI.markFinancialSyncSaleConfirmed(billId, cloudSaleId)');
  const stepCallAt = source.indexOf('return await _runStockStep(op, localSale, billId, cloudSaleId)', saleConfirmedAt);
  assert.ok(saleConfirmedAt > 0 && stepCallAt > saleConfirmedAt, 'sale confirmed before the stock step');
  const stepStart = source.indexOf('async function _runStockStep(');
  const reconcileAt = source.indexOf('await _reconcileStockForOperation(op, localSale)', stepStart);
  const confirmedAt = source.indexOf('await window.electronAPI.markFinancialSyncConfirmed', reconcileAt);
  assert.ok(stepStart > 0 && reconcileAt > stepStart && confirmedAt > reconcileAt, 'stock reconciled before CLOUD_CONFIRMED');
  assert.match(source, /STOCK_RECONCILIATION_CONFLICT/);
  assert.match(source, /'STOCK_CONFLICT'/);
  assert.match(source, /findStockMovementByKeyStrict/);
});

test('historical contract-v1 operation skips stock reconciliation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  assert.match(source, /contract_version \|\| 1\) < 2/);
  assert.match(source, /legacy financial sync contract/);
});

test('renderer overlays unresolved local closing and no longer calls relative cloud deduction at checkout', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.match(source, /getPendingStockOverlays/);
  assert.match(source, /server_stock_batch_id/);
  const checkoutStart = source.indexOf('let applyInventoryDeductions =');
  const checkoutEnd = source.indexOf('try {', checkoutStart);
  const checkoutBlock = source.slice(checkoutStart, checkoutEnd);
  assert.doesNotMatch(checkoutBlock, /bulkUpdateInventory\(/);
});

test('cloud migration is nullable, unique, authorized, atomic and conflict-aware', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260929000100_v3182_idempotent_stock_reconciliation.sql'), 'utf8');
  assert.match(sql, /add column if not exists movement_key text/);
  assert.match(sql, /unique index if not exists stock_movements_movement_key_uq/);
  assert.match(sql, /where movement_key is not null/);
  assert.match(sql, /is_pharmacy_writer/);
  assert.match(sql, /for update/);
  assert.match(sql, /'status', 'CONFLICT'/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public/);
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log(`PASS ${t.name}`); }
    catch (error) { console.error(`FAIL ${t.name}`); console.error(error); process.exitCode = 1; }
  }
  console.log(`\nstock-reconciliation tests: ${passed}/${tests.length} passed`);
})();
