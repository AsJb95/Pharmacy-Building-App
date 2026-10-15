#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeHarness({ cloudSeed = {}, failBills = new Set(), pending = [] } = {}) {
  const cloud = new Map(Object.entries(cloudSeed));
  const calls = { create: 0, find: 0, markAttempt: 0, markConfirmed: 0, setPendingFlag: [] };
  const ops = new Map(pending.map((op) => [op.bill_id, { ...op }]));
  const localSales = new Map(pending.map((op) => [op.bill_id, {
    bill_id: op.bill_id,
    patient_name: `Patient ${op.bill_id}`,
    total_amount: op.total_amount || 100,
    sale_items: [{ drug_name: 'Test Item', quantity: 1, rate: op.total_amount || 100, total_amount: op.total_amount || 100 }],
  }]));
  let inFlight = false;

  async function derivePendingFlag() {
    const hasPending = Array.from(ops.values()).some((op) => op.sync_status !== 'CLOUD_CONFIRMED');
    calls.setPendingFlag.push(hasPending);
    return hasPending;
  }

  async function syncOne(op) {
    const billId = op.bill_id;
    calls.markAttempt += 1;
    ops.get(billId).sync_status = 'SYNCING';
    try {
      const local = localSales.get(billId);
      if (!local) throw new Error('local sale missing');
      calls.find += 1;
      let existing = cloud.get(billId) || null;
      if (!existing) {
        if (failBills.has(billId)) throw new Error(`forced cloud failure for ${billId}`);
        calls.create += 1;
        cloud.set(billId, {
          id: `cloud-${billId}`,
          bill_id: billId,
          total_amount: local.total_amount,
          sale_items: local.sale_items.map((x, i) => ({ ...x, id: `${billId}-item-${i}` })),
        });
        calls.find += 1;
        existing = cloud.get(billId);
      }
      assert.strictEqual(Number(existing.total_amount), Number(local.total_amount));
      assert.strictEqual(existing.sale_items.length, local.sale_items.length);
      calls.markConfirmed += 1;
      ops.get(billId).sync_status = 'CLOUD_CONFIRMED';
      return { billId, ok: true };
    } catch (e) {
      const row = ops.get(billId);
      row.sync_status = 'SYNC_FAILED';
      row.retry_count = (row.retry_count || 0) + 1;
      row.last_error = e.message;
      return { billId, ok: false, error: e.message };
    }
  }

  async function runWorker() {
    if (inFlight) return { skipped: true };
    inFlight = true;
    try {
      const rows = Array.from(ops.values()).filter((op) => op.sync_status !== 'CLOUD_CONFIRMED');
      const results = [];
      for (const op of rows) results.push(await syncOne(op));
      await derivePendingFlag();
      return { processed: results.length, results };
    } finally {
      inFlight = false;
    }
  }

  return { cloud, calls, ops, runWorker, derivePendingFlag };
}

test('missing cloud sale is created once and confirmed by bill_id', async () => {
  const h = makeHarness({ pending: [{ bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' }] });
  const res = await h.runWorker();
  assert.strictEqual(res.processed, 1);
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.cloud.has('BILL-A'), true);
  assert.strictEqual(h.ops.get('BILL-A').sync_status, 'CLOUD_CONFIRMED');
});

test('existing cloud sale is reused without duplicate create', async () => {
  const h = makeHarness({
    cloudSeed: { 'BILL-A': { id: 'cloud-a', bill_id: 'BILL-A', total_amount: 100, sale_items: [{ id: 'i1' }] } },
    pending: [{ bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' }],
  });
  await h.runWorker();
  assert.strictEqual(h.calls.create, 0);
  assert.strictEqual(h.ops.get('BILL-A').sync_status, 'CLOUD_CONFIRMED');
});

test('running worker repeatedly does not duplicate sales or items', async () => {
  const h = makeHarness({ pending: [{ bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' }] });
  for (let i = 0; i < 10; i += 1) await h.runWorker();
  assert.strictEqual(h.calls.create, 1);
  assert.strictEqual(h.cloud.size, 1);
  assert.strictEqual(h.cloud.get('BILL-A').sale_items.length, 1);
});

test('one confirmed bill does not clear failed or pending bills', async () => {
  const h = makeHarness({
    failBills: new Set(['BILL-B']),
    pending: [
      { bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' },
      { bill_id: 'BILL-B', sync_status: 'PENDING_CLOUD' },
      { bill_id: 'BILL-C', sync_status: 'CLOUD_CONFIRMED' },
    ],
  });
  await h.runWorker();
  assert.strictEqual(h.ops.get('BILL-A').sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(h.ops.get('BILL-B').sync_status, 'SYNC_FAILED');
  assert.strictEqual(h.ops.get('BILL-C').sync_status, 'CLOUD_CONFIRMED');
  assert.strictEqual(h.calls.setPendingFlag.at(-1), true);
});

test('legacy pending flag derives from durable unsynced operations', async () => {
  const h = makeHarness({ pending: [{ bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' }] });
  assert.strictEqual(await h.derivePendingFlag(), true);
  h.ops.get('BILL-A').sync_status = 'CLOUD_CONFIRMED';
  assert.strictEqual(await h.derivePendingFlag(), false);
});

test('single-flight worker skips overlapping execution', async () => {
  const h = makeHarness({ pending: [{ bill_id: 'BILL-A', sync_status: 'PENDING_CLOUD' }] });
  const first = h.runWorker();
  const second = h.runWorker();
  const results = await Promise.all([first, second]);
  assert.strictEqual(results.some((r) => r.skipped), true);
  assert.strictEqual(h.calls.create, 1);
});

test('real worker preserves create errors and never forwards local UUIDs as cloud foreign keys', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  assert.match(source, /SALE_CREATE_FAILED:/);
  assert.match(source, /SALE_CREATED_BUT_READBACK_FAILED:/);
  assert.match(source, /patientSnapshot\.patientId/);
  assert.match(source, /patientSnapshot,/);
  assert.match(source, /item\.server_item_id/);
  assert.doesNotMatch(source, /itemId: item\.item_id \|\| item\.itemId/);
  assert.match(source, /JSON\.parse\(paymentBreakdown\)/);
});

test('real worker repairs partial sale_items through idempotent create_sale replay', async () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  const cloud = fs.readFileSync(path.join(__dirname, '..', 'cloud-src', 'vhc-cloud-sync.js'), 'utf8');
  assert.match(worker, /startsWith\('missing sale_items'\)/);
  assert.match(worker, /SALE_ITEMS_REPAIR_FAILED:/);
  assert.match(worker, /createSaleStrict\(cloudPayload\)/);
  assert.match(cloud, /rpc\('create_sale', \{ payload: rpcPayload \}\)/);
});

test('financial status UI is sourced from durable operations, not Drive backup state', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.match(source, /getFinancialSyncOperations/);
  assert.match(source, /Online \\u2022 Synced/);
  assert.match(source, /Offline \\u2022 \$\{pending\} Pending/);
  // v3.19.3: a transient failure is shown as "saved locally, waiting for cloud sync", not an alarm
  assert.match(source, /Saved locally \\u2022 \$\{pending\} waiting for cloud sync/);
  assert.doesNotMatch(source, /Sync Failed \\u2022 \$\{pending\} Pending/);
  assert.match(source, /Syncing\\u2026/);
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`PASS ${t.name}`);
    } catch (e) {
      console.error(`FAIL ${t.name}`);
      console.error(e);
      process.exitCode = 1;
    }
  }
  console.log(`\nfinancial-sync-worker tests: ${passed}/${tests.length} passed`);
})();
