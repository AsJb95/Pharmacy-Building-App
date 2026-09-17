// ─── Standalone verification for electron/sync-engine.js (Phase 2D) ───
// Real Supabase calls are deliberately NOT made here — this project has no dedicated test
// Supabase project, and hitting the real production project from an automated test is not a
// safe default. Per the task's own allowance ("test against a controlled mock boundary and
// clearly label the limitation"), this file replaces the global `fetch` the sync engine calls
// with a scripted mock, so every network outcome (success, timeout, 401, a real Postgres
// conflict, a lost-response retry) is exercised deterministically and repeatably, without any
// real network access. What is NOT verified here: the real Supabase RPCs' actual behavior
// against a live database — that was verified separately by reading their SQL bodies directly
// (see the Phase 2D report) and is trusted, not re-tested, in this file.
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert';
import Database from 'better-sqlite3';
import {
  initDatabase, closeDatabase, createLocalSale, cancelLocalSale, getLocalSaleByBillId,
  getSyncStatus, recoverStuckSyncItems,
} from './database.js';
import { runSyncCycle, setAccessTokenGetter } from './sync-engine.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhc-sync-selftest-'));
const dbPath = path.join(tmpDir, 'selftest.db');
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

const realFetch = global.fetch;
let mockQueue = [];
/** Push one scripted response/behavior; consumed in order, one per callRpc() invocation. */
function mockNextCall(fn) { mockQueue.push(fn); }
function installFetchMock() {
  global.fetch = async (url, options) => {
    if (mockQueue.length === 0) throw new Error('Test error: fetch called with no scripted mock response queued');
    const behavior = mockQueue.shift();
    return behavior(url, options);
  };
}
function restoreFetch() { global.fetch = realFetch; }
function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function sampleItem(overrides = {}) {
  return { name: 'SyncTestDrug', category: 'Medicine', batch: 'SYN-1', expiry: '2028-01-01', mrp: 100, unitsPerPack: 10, gst: 12, qty: 1, stock: 100, itemId: 'aaaaaaaa-1111-4111-8111-111111111111', ...overrides };
}
function makeSale(billId, overrides = {}) {
  return createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleItem()], extraParticulars: [],
    ...overrides,
  });
}

/**
 * Forces every currently-pending/processing row well past its backoff window and resolves it
 * with a generic success response, looping until the queue is empty (or a safety cap is hit).
 * Several tests below need to assert on the EXACT set of rows a single scripted cycle touches
 * — without this, a row left mid-retry by an earlier test (e.g. Phase 2E's new item/patient
 * sync rows) would compete for the same handful of scripted mock responses and produce
 * confusing, order-dependent failures unrelated to the thing actually being tested.
 */
async function drainQueue() {
  for (let i = 0; i < 20; i++) {
    const status = getSyncStatus();
    if (status.pending === 0 && status.processing === 0) return;
    const raw = new Database(dbPath);
    raw.prepare("UPDATE sync_queue SET updated_at = ? WHERE status IN ('pending', 'processing')").run(new Date(Date.now() - 600000).toISOString());
    const pendingCount = raw.prepare("SELECT COUNT(*) AS c FROM sync_queue WHERE status IN ('pending','processing')").get().c;
    raw.close();
    for (let j = 0; j < pendingCount; j++) mockNextCall(async () => jsonResponse(200, [{ id: 'drain-' + Math.random().toString(36).slice(2) }]));
    await runSyncCycle();
    mockQueue.length = 0; // discard any unused mocks from this pass before the next
  }
}

initDatabase(dbPath);
installFetchMock();
setAccessTokenGetter(() => 'fake-test-access-token');

async function main() {
  console.log('=== 1-2. Queue creation + persistence ===');
  check('creating a local sale also creates exactly one pending sync_queue row', () => {
    const res = makeSale('BILL-SYNC-1');
    assert.strictEqual(res.success, true, JSON.stringify(res));
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-1'").get();
    raw.close();
    assert.ok(row, 'a sync_queue row should exist');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.operation, 'create');
    assert.strictEqual(row.attempts, 0);
  });

  console.log('=== 3. Queue survives restart ===');
  check('closing and reopening the database preserves the queue row', () => {
    closeDatabase();
    initDatabase(dbPath);
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-1'").get();
    raw.close();
    assert.ok(row, 'queue row must survive a close+reopen (simulates an app restart)');
  });

  console.log('=== 4. Successful sync ===');
  await checkAsync('a pending create syncs successfully and stamps server_id on both the queue row and the local sale', async () => {
    const serverId = 'server-sale-id-0001';
    mockNextCall(async () => jsonResponse(200, { id: serverId, bill_id: 'BILL-SYNC-1' }));
    const summary = await runSyncCycle();
    assert.strictEqual(summary.processed, 1, JSON.stringify(summary));
    assert.strictEqual(summary.results[0].outcome, 'synced');
    const sale = getLocalSaleByBillId('BILL-SYNC-1');
    assert.strictEqual(sale.server_id, serverId);
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-1'").get();
    raw.close();
    assert.strictEqual(row.status, 'synced');
    assert.strictEqual(row.server_id, serverId);
  });

  console.log('=== 5-6. Network failure + retry ===');
  await checkAsync('a network failure leaves the row pending with an error, and a later successful retry then syncs it', async () => {
    makeSale('BILL-SYNC-2');
    mockNextCall(async () => { throw new Error('getaddrinfo ENOTFOUND fjtgszdzbiepmdmnjsxn.supabase.co'); });
    const firstCycle = await runSyncCycle();
    assert.strictEqual(firstCycle.results[0].outcome, 'retry');
    let raw = new Database(dbPath, { readonly: true });
    let row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-2'").get();
    raw.close();
    assert.strictEqual(row.status, 'pending', 'a network failure must NOT be a dead end — status stays pending for retry');
    assert.ok(/network error/i.test(row.last_error), row.last_error);
    assert.strictEqual(getLocalSaleByBillId('BILL-SYNC-2').status, 'active', 'the local sale itself must be completely unaffected by a sync failure');

    // Retry: backoff after 1 failed attempt is 10s — force it past the window for this test.
    raw = new Database(dbPath);
    raw.prepare("UPDATE sync_queue SET updated_at = ? WHERE bill_id = 'BILL-SYNC-2'").run(new Date(Date.now() - 60000).toISOString());
    raw.close();
    mockNextCall(async () => jsonResponse(200, { id: 'server-sale-id-0002' }));
    const secondCycle = await runSyncCycle();
    assert.strictEqual(secondCycle.results[0].outcome, 'synced', JSON.stringify(secondCycle));
  });

  console.log('=== 7-8. Duplicate sync / same-bill idempotency ===');
  await checkAsync('a lost-response retry (server actually succeeded, we retry anyway) never creates a duplicate local record or double-marks anything', async () => {
    makeSale('BILL-SYNC-3');
    // Simulate: our request actually succeeded server-side, but we never saw the response
    // (network died on the way back) — classified as a network failure locally either way.
    mockNextCall(async () => { throw new Error('socket hang up'); });
    await runSyncCycle();
    let raw = new Database(dbPath);
    raw.prepare("UPDATE sync_queue SET updated_at = ? WHERE bill_id = 'BILL-SYNC-3'").run(new Date(Date.now() - 60000).toISOString());
    raw.close();
    // Retry: create_sale's OWN idempotency (traced from its real SQL body) means the server
    // would just return the already-created row — the mock reflects exactly that contract.
    mockNextCall(async () => jsonResponse(200, { id: 'server-sale-id-0003' }));
    await runSyncCycle();
    raw = new Database(dbPath, { readonly: true });
    const queueRows = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-3'").all();
    const saleRows = raw.prepare("SELECT * FROM sales WHERE bill_id = 'BILL-SYNC-3'").all();
    raw.close();
    assert.strictEqual(queueRows.length, 1, 'still exactly one queue row — retry reuses it, never creates a second');
    assert.strictEqual(saleRows.length, 1, 'still exactly one local sale row');
    assert.strictEqual(queueRows[0].status, 'synced');
  });

  console.log('=== 9-10. Multiple pending bills + partial sync ===');
  await checkAsync('with 3 pending bills, 2 succeed and 1 fails — only the failed one remains pending', async () => {
    makeSale('BILL-SYNC-M1');
    makeSale('BILL-SYNC-M2');
    makeSale('BILL-SYNC-M3');
    mockNextCall(async () => jsonResponse(200, { id: 'server-m1' }));
    mockNextCall(async () => jsonResponse(400, { message: 'Insufficient stock for item SyncTestDrug' }));
    mockNextCall(async () => jsonResponse(200, { id: 'server-m3' }));
    const summary = await runSyncCycle();
    assert.strictEqual(summary.processed, 3, JSON.stringify(summary));
    const outcomes = summary.results.map((r) => r.outcome).sort();
    assert.deepStrictEqual(outcomes, ['needs_review', 'synced', 'synced']);
  });

  console.log('=== 11 / 17. Crash/restart recovery ===');
  await checkAsync('a row stuck in processing (crash mid-sync) is reset to pending on recovery, then actually retried and synced', async () => {
    makeSale('BILL-SYNC-CRASH');
    const raw = new Database(dbPath);
    raw.prepare("UPDATE sync_queue SET status = 'processing', updated_at = ? WHERE bill_id = 'BILL-SYNC-CRASH'")
      .run(new Date(Date.now() - 5 * 60000).toISOString()); // 5 minutes ago — well past the stuck threshold
    raw.close();
    const recovery = recoverStuckSyncItems();
    assert.strictEqual(recovery.recovered, 1);
    const raw2 = new Database(dbPath, { readonly: true });
    const row = raw2.prepare("SELECT status FROM sync_queue WHERE bill_id = 'BILL-SYNC-CRASH'").get();
    raw2.close();
    assert.strictEqual(row.status, 'pending');
    // Actually complete the retry now, so this bill doesn't remain pending and bleed into
    // later tests' batch-processing assertions.
    mockNextCall(async () => jsonResponse(200, { id: 'server-crash-recovered' }));
    const cycle = await runSyncCycle();
    const recovered = cycle.results.find((r) => r.id === row.id) || cycle.results[0];
    assert.strictEqual(getLocalSaleByBillId('BILL-SYNC-CRASH').server_id, 'server-crash-recovered');
  });

  console.log('=== 12. Offline cancellation ordering ===');
  await checkAsync('a bill created then cancelled offline produces an ordered create+cancel pair; cancel only syncs after create does', async () => {
    makeSale('BILL-SYNC-CANCEL');
    const cancelRes = cancelLocalSale('BILL-SYNC-CANCEL');
    assert.strictEqual(cancelRes.success, true);

    let raw = new Database(dbPath, { readonly: true });
    let rows = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-CANCEL' ORDER BY created_at").all();
    raw.close();
    assert.strictEqual(rows.length, 2, 'should have one create row and one cancel row');
    const createRow = rows.find((r) => r.operation === 'create');
    const cancelRow = rows.find((r) => r.operation === 'cancel');
    assert.strictEqual(cancelRow.depends_on, createRow.id, 'the cancel must depend on its own create');

    // Cycle 1: only the create should be eligible (cancel's dependency isn't synced yet).
    // Checked by bill-specific queue state rather than the cycle's raw processed count, since
    // other bills from earlier tests may independently have pending rows in the same cycle.
    mockNextCall(async () => jsonResponse(200, { id: 'server-cancel-test' }));
    await runSyncCycle();
    let raw2 = new Database(dbPath, { readonly: true });
    let afterCycle1 = raw2.prepare('SELECT id, status FROM sync_queue WHERE id IN (?, ?)').all(createRow.id, cancelRow.id);
    raw2.close();
    assert.strictEqual(afterCycle1.find((r) => r.id === createRow.id).status, 'synced');
    assert.strictEqual(afterCycle1.find((r) => r.id === cancelRow.id).status, 'pending', 'the cancel must NOT be picked up before its create has synced');

    // Cycle 2: now the cancel becomes eligible.
    mockNextCall(async () => jsonResponse(200, {}));
    await runSyncCycle();

    raw = new Database(dbPath, { readonly: true });
    rows = raw.prepare("SELECT status FROM sync_queue WHERE bill_id = 'BILL-SYNC-CANCEL'").all();
    raw.close();
    assert.ok(rows.every((r) => r.status === 'synced'));
  });

  console.log('=== 13. Stock conflict (needs_review) ===');
  await checkAsync('a real remote stock conflict marks the row needs_review and NEVER touches the local sale', async () => {
    makeSale('BILL-SYNC-CONFLICT');
    mockNextCall(async () => jsonResponse(400, { message: 'Insufficient stock for item SyncTestDrug' }));
    await runSyncCycle();
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-CONFLICT'").get();
    raw.close();
    assert.strictEqual(row.status, 'needs_review');
    assert.ok(/insufficient stock/i.test(row.last_error));
    const sale = getLocalSaleByBillId('BILL-SYNC-CONFLICT');
    assert.strictEqual(sale.status, 'active', 'local sale must remain completely intact after a remote conflict');
  });

  console.log('=== 14. Patient sync + conflict handling (Phase 2E) ===');
  await drainQueue(); // clean slate — tests below assert on the exact rows a scripted cycle touches
  await checkAsync('offline patient creation enqueues its own sync_queue row, separate from the sale', () => {
    const before = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) AS c FROM sync_queue WHERE entity_type = 'patient'").get().c;
    makeSale('BILL-SYNC-PATIENT', { patientSnapshot: { name: 'Local Only Patient', contact: '9111111111' } });
    const raw = new Database(dbPath, { readonly: true });
    const after = raw.prepare("SELECT COUNT(*) AS c FROM sync_queue WHERE entity_type = 'patient'").get().c;
    const patientRow = raw.prepare("SELECT * FROM sync_queue WHERE entity_type = 'patient' ORDER BY created_at DESC LIMIT 1").get();
    raw.close();
    assert.strictEqual(after, before + 1);
    assert.strictEqual(patientRow.status, 'pending');
  });
  await checkAsync('the patient syncs (legacy_patient_id idempotency key sent), and the sale then references the real patient_id — same or next cycle, both are correct as long as it eventually happens', async () => {
    let patientCallBody = null;
    let saleCallBody = null;
    // A patient is never a hard sync-blocking dependency for its sale (see
    // buildCreateSalePayload) — both rows may legitimately be eligible in the SAME cycle, with
    // the sale correctly seeing the patient's freshly-set server_id if the patient's own turn
    // happened to come first in that same pass. Two mocks are queued to cover either row order;
    // whichever runs first consumes the matching one.
    mockNextCall(async (url, options) => {
      const parsed = JSON.parse(options.body);
      if (parsed.legacy_patient_id) { patientCallBody = parsed; return jsonResponse(201, [{ id: 'server-patient-real-id' }]); }
      saleCallBody = parsed; return jsonResponse(200, { id: 'server-sale-with-patient' });
    });
    mockNextCall(async (url, options) => {
      const parsed = JSON.parse(options.body);
      if (parsed.legacy_patient_id) { patientCallBody = parsed; return jsonResponse(201, [{ id: 'server-patient-real-id' }]); }
      saleCallBody = parsed; return jsonResponse(200, { id: 'server-sale-with-patient' });
    });
    await runSyncCycle();
    if (!saleCallBody) {
      // The sale wasn't eligible yet in cycle 1 (patient hadn't synced when the batch was
      // read) — force past backoff and give it one more cycle.
      const raw = new Database(dbPath);
      raw.prepare("UPDATE sync_queue SET updated_at = ? WHERE status = 'pending'").run(new Date(Date.now() - 60000).toISOString());
      raw.close();
      mockNextCall(async (url, options) => { saleCallBody = JSON.parse(options.body); return jsonResponse(200, { id: 'server-sale-with-patient' }); });
      await runSyncCycle();
    }
    assert.ok(patientCallBody && patientCallBody.legacy_patient_id, 'the local patient id must be sent as legacy_patient_id for safe idempotency');
    assert.ok(saleCallBody, 'the sale must eventually sync once its patient has a server_id');
    assert.strictEqual(saleCallBody.payload.patient_id, 'server-patient-real-id', 'the sale must reference the patient’s real server id once resolved');
  });
  await checkAsync('a 409 on legacy_patient_id (lost-response retry) resolves via a follow-up lookup instead of erroring', async () => {
    makeSale('BILL-SYNC-PATIENT-409', { patientSnapshot: { name: 'Conflict Patient', contact: '9111111112' } });
    mockNextCall(async () => jsonResponse(409, { message: 'duplicate key value violates unique constraint "patients_legacy_patient_id_unique"' }));
    mockNextCall(async () => jsonResponse(200, [{ id: 'server-patient-resolved-via-409' }]));
    const cycle = await runSyncCycle();
    const patientResult = cycle.results.find((r) => r.outcome === 'synced' && r.serverId === 'server-patient-resolved-via-409');
    assert.ok(patientResult, JSON.stringify(cycle));
  });

  console.log('=== 15. Item sync + conflict handling (Phase 2E) ===');
  await drainQueue(); // clean slate — same reasoning as section 14
  await checkAsync('offline item creation enqueues its own sync_queue row, and a sale referencing it WAITS (stays pending) rather than failing', async () => {
    makeSale('BILL-SYNC-ITEM', { items: [sampleItem({ name: 'Never Synced Item', batch: 'NSI-1', itemId: undefined })] });
    let raw = new Database(dbPath, { readonly: true });
    const itemQueueRow = raw.prepare("SELECT * FROM sync_queue WHERE entity_type = 'item' ORDER BY created_at DESC LIMIT 1").get();
    raw.close();
    assert.ok(itemQueueRow, 'the offline-created item must have its own queue row');

    // Cycle: only the item is eligible for a real attempt; the sale should see its dependency
    // still pending and WAIT (retry), never needs_review, per the explicit requirement that a
    // sale must not fail merely because its dependency hasn't synced yet.
    mockNextCall(async () => { throw new Error('simulated network failure for the item sync'); });
    await runSyncCycle();
    raw = new Database(dbPath, { readonly: true });
    const saleQueueRow = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-ITEM' AND entity_type = 'sale'").get();
    raw.close();
    assert.strictEqual(saleQueueRow.status, 'pending', 'the sale must wait, not fail, while its item dependency is still retrying');
    assert.ok(/waiting for item/i.test(saleQueueRow.last_error), saleQueueRow.last_error);
  });
  await checkAsync('once the dependent item successfully syncs, the sale that was waiting on it syncs on the next cycle', async () => {
    // Force both rows past backoff so this cycle actually attempts them.
    const raw = new Database(dbPath);
    // Targets ALL pending rows (not just the sale's) — the item's own queue row uses its own id
    // as `bill_id` (see database.js), not the sale's bill_id, so a narrower filter here would
    // miss it and leave it stuck for later tests.
    raw.prepare("UPDATE sync_queue SET updated_at = ? WHERE status = 'pending'").run(new Date(Date.now() - 60000).toISOString());
    raw.close();
    mockNextCall(async () => jsonResponse(200, [])); // SELECT-by-name check: no existing match
    mockNextCall(async () => jsonResponse(201, [{ id: 'server-item-real-id' }])); // the actual insert
    // The item is processed first (it was enqueued first) and, on success, immediately stamps
    // its server_id — so by the time this SAME cycle reaches the sale (later in the same
    // batch), the sale is no longer "waiting" and correctly attempts its own real sync too,
    // needing its own mocked response. This faster same-cycle convergence is correct, intended
    // behavior, not a bug — the test provides for it rather than forcing an artificial 2nd cycle.
    mockNextCall(async () => jsonResponse(200, { id: 'server-sale-item-test' }));
    const cycle1 = await runSyncCycle();
    const itemResult = cycle1.results.find((r) => r.id && r.serverId === 'server-item-real-id');
    const saleResult = cycle1.results.find((r) => r.serverId === 'server-sale-item-test');
    assert.ok(itemResult, JSON.stringify(cycle1));
    assert.ok(saleResult, 'the sale should sync in the same pass once its dependency resolves mid-cycle: ' + JSON.stringify(cycle1));
  });
  await drainQueue(); // clean slate before this fully independent, precisely-scripted scenario
  await checkAsync('an item sync that hits a permission (RLS) error is routed to needs_review, not retried forever', async () => {
    makeSale('BILL-SYNC-ITEM-RLS', { items: [sampleItem({ name: 'RLS Blocked Item', batch: 'RLS-1', itemId: undefined })] });
    mockNextCall(async () => jsonResponse(200, [])); // no existing match
    mockNextCall(async () => jsonResponse(403, { message: 'new row violates row-level security policy for table "items"' }));
    await runSyncCycle();
    const raw = new Database(dbPath, { readonly: true });
    const itemRow = raw.prepare("SELECT * FROM sync_queue WHERE entity_type = 'item' ORDER BY created_at DESC LIMIT 1").get();
    raw.close();
    assert.strictEqual(itemRow.status, 'needs_review');
    assert.ok(/permission denied/i.test(itemRow.last_error), itemRow.last_error);
  });

  console.log('=== 16. Authentication failure ===');
  await drainQueue();
  await checkAsync('a 401 keeps the row pending (not needs_review) with an authentication-labeled error', async () => {
    makeSale('BILL-SYNC-AUTH');
    mockNextCall(async () => jsonResponse(401, { message: 'JWT expired' }));
    await runSyncCycle();
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT * FROM sync_queue WHERE bill_id = 'BILL-SYNC-AUTH'").get();
    raw.close();
    assert.strictEqual(row.status, 'pending', 'auth failures must stay retryable, never needs_review, per the explicit requirement');
    assert.ok(/authentication/i.test(row.last_error), row.last_error);
  });

  console.log('=== 18. No data loss (aggregate check across everything above) ===');
  check('every local sale created during this entire test run still exists, regardless of its sync outcome', () => {
    const raw = new Database(dbPath, { readonly: true });
    const billIds = ['BILL-SYNC-1', 'BILL-SYNC-2', 'BILL-SYNC-3', 'BILL-SYNC-M1', 'BILL-SYNC-M2', 'BILL-SYNC-M3', 'BILL-SYNC-CRASH', 'BILL-SYNC-CANCEL', 'BILL-SYNC-CONFLICT', 'BILL-SYNC-PATIENT', 'BILL-SYNC-ITEM', 'BILL-SYNC-AUTH'];
    for (const billId of billIds) {
      const row = raw.prepare('SELECT * FROM sales WHERE bill_id = ?').get(billId);
      if (!row) { failures++; console.log(`  FAIL  missing local sale: ${billId}`); }
    }
    raw.close();
  });

  check('getSyncStatus() reports sensible non-negative aggregate counts', () => {
    const status = getSyncStatus();
    assert.ok(status.synced >= 5);
    assert.ok(status.needsReview >= 2);
    assert.ok(typeof status.lastSyncedAt === 'string');
  });

  console.log('\n=== Cleanup ===');
  restoreFetch();
  try { closeDatabase(); } catch (e) {}
  try {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(dbPath + '-wal', { force: true });
    fs.rmSync(dbPath + '-shm', { force: true });
    fs.rmdirSync(tmpDir);
    console.log('  Temporary test database removed:', tmpDir);
  } catch (e) {
    console.log('  Cleanup warning:', e.message);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
