// ─── Standalone verification for electron/database.js ───
// The project has no test framework (no jest/mocha/vitest in package.json) and no build
// pipeline, so this is a plain, dependency-free script rather than a new framework
// integration — run with `npm run test:database`. This uses Electron's Node runtime so its
// native better-sqlite3 ABI matches the packaged application. It never touches the
// real app's userData database; everything runs against a throwaway temp file that is deleted
// at the end, pass or fail.
import path from 'path';
import fs from 'fs';
import os from 'os';
import assert from 'assert';
import Database from 'better-sqlite3';
import { initDatabase, getDatabaseStatus, getSchemaVersion, closeDatabase, createLocalSale, cancelLocalSale, getLocalSaleByBillId, recordCreditRepayment, getCreditRepaymentsByBillId, getCreditSettlementByBillId, getSalesHistory, getSalesSummary, clearSalesHistoryData, clearSalesAndInventoryLedgerData, clearInventoryLedgerData } from './database.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhc-db-selftest-'));
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

console.log('=== 1. Initialization ===');
check('initDatabase creates the file and parent dir', () => {
  initDatabase(dbPath);
  assert.ok(fs.existsSync(dbPath), 'db file should exist after init');
});
check('calling initDatabase again returns the same connection (no double-open)', () => {
  const before = getDatabaseStatus().path;
  initDatabase(dbPath);
  assert.strictEqual(getDatabaseStatus().path, before);
});

console.log('=== 2. Migration ===');
check('schema_version reflects the latest applied migration after initialization', () => {
  // Intentionally not hardcoded to a specific number — this file's MIGRATIONS array grows in
  // later phases, and this check should keep passing as long as getSchemaVersion() correctly
  // tracks whatever the latest one is.
  const raw = new Database(dbPath, { readonly: true });
  const maxVersion = raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  raw.close();
  assert.strictEqual(getSchemaVersion(), String(maxVersion));
});
check('database_metadata was seeded correctly', () => {
  const status = getDatabaseStatus();
  assert.strictEqual(status.opened, true);
  assert.ok(status.sqliteVersion, 'sqlite version should be reported');
});
check('re-running migrations on reopen does not duplicate rows or error', () => {
  const before = new Database(dbPath, { readonly: true }).prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
  closeDatabase();
  initDatabase(dbPath);
  const raw = new Database(dbPath, { readonly: true });
  const rows = raw.prepare('SELECT * FROM schema_migrations').all();
  raw.close();
  assert.strictEqual(rows.length, before, 'reopening must not re-run or duplicate any already-applied migration');
});

console.log('=== 3. CRUD (via a raw connection to the same file, proving real persistence) ===');
check('insert/select/update/delete all work against the migrated schema', () => {
  const raw = new Database(dbPath);
  raw.prepare("INSERT INTO database_metadata (key, value, updated_at) VALUES ('t1', 'a', ?)").run(new Date().toISOString());
  let row = raw.prepare('SELECT value FROM database_metadata WHERE key = ?').get('t1');
  assert.strictEqual(row.value, 'a');
  raw.prepare("UPDATE database_metadata SET value = 'b' WHERE key = 't1'").run();
  row = raw.prepare('SELECT value FROM database_metadata WHERE key = ?').get('t1');
  assert.strictEqual(row.value, 'b');
  raw.prepare("DELETE FROM database_metadata WHERE key = 't1'").run();
  row = raw.prepare('SELECT value FROM database_metadata WHERE key = ?').get('t1');
  assert.strictEqual(row, undefined);
  raw.close();
});

console.log('=== 4. Transaction commit/rollback ===');
check('getDatabaseStatus().writeTest reports true (write probe rolls back cleanly)', () => {
  const status = getDatabaseStatus();
  assert.strictEqual(status.writeTest, true);
});
check('the write probe never actually persists a row', () => {
  getDatabaseStatus(); // runs (and rolls back) the write probe again
  const raw = new Database(dbPath, { readonly: true });
  const row = raw.prepare("SELECT * FROM database_metadata WHERE key = '__write_probe__'").get();
  raw.close();
  assert.strictEqual(row, undefined, 'the rolled-back probe row must not exist');
});
check('an explicit failed transaction rolls back fully (all-or-nothing)', () => {
  const raw = new Database(dbPath);
  try {
    const tx = raw.transaction(() => {
      raw.prepare("INSERT INTO database_metadata (key, value, updated_at) VALUES ('tx1', 'x', ?)").run(new Date().toISOString());
      raw.prepare("INSERT INTO database_metadata (key, value, updated_at) VALUES ('tx1', 'y', ?)").run(new Date().toISOString()); // duplicate PK -> throws
    });
    tx();
    assert.fail('transaction should have thrown on duplicate primary key');
  } catch (e) {
    // expected
  }
  const row = raw.prepare("SELECT * FROM database_metadata WHERE key = 'tx1'").get();
  assert.strictEqual(row, undefined, 'neither insert should have survived the rolled-back transaction');
  raw.close();
});

console.log('=== 5. Reopen persistence ===');
check('data written before close is present after close + reopen', () => {
  closeDatabase();
  const raw1 = new Database(dbPath);
  raw1.prepare("INSERT INTO database_metadata (key, value, updated_at) VALUES ('persist1', 'yes', ?)").run(new Date().toISOString());
  raw1.close();
  const raw2 = new Database(dbPath, { readonly: true });
  const row = raw2.prepare("SELECT value FROM database_metadata WHERE key = 'persist1'").get();
  raw2.close();
  assert.strictEqual(row.value, 'yes');
});

console.log('=== 6. Invalid migration handling ===');
check('a migration that throws is not marked applied, and its schema changes do not persist', () => {
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const badVersion = 9999;
  try {
    const applyBad = raw.transaction(() => {
      raw.exec('CREATE TABLE broken_migration_table (id INTEGER PRIMARY KEY)');
      raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(badVersion, 'deliberately_broken', new Date().toISOString());
      throw new Error('simulated failure partway through migration');
    });
    applyBad();
    assert.fail('the transaction should have thrown');
  } catch (e) {
    // expected
  }
  const migRow = raw.prepare('SELECT * FROM schema_migrations WHERE version = ?').get(badVersion);
  assert.strictEqual(migRow, undefined, 'a failed migration must not be recorded as applied');
  const tableExists = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='broken_migration_table'").get();
  assert.strictEqual(tableExists, undefined, 'a failed migration\'s schema changes must not persist');
  raw.close();
});

console.log('=== 7. Pharmacy core schema ===');
// Section 6 closed the module's connection and only ever reopened it via raw `new Database()`
// calls for its own direct manipulation — restore the module's own live connection via
// initDatabase() before using its exported functions again below.
initDatabase(dbPath);
check('migration 2 applied; the pharmacy core schema tables exist', () => {
  const raw = new Database(dbPath, { readonly: true });
  const applied = raw.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version);
  raw.close();
  assert.ok(applied.includes(2), 'migration 2 should be applied');
});
check('all six core tables exist', () => {
  const raw = new Database(dbPath, { readonly: true });
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  raw.close();
  for (const t of ['items', 'patients', 'stock_batches', 'stock_movements', 'sales', 'sale_items']) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
});

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

check('item -> stock_batch relationship: insert works, and a stock_batch cannot reference a non-existent item (FK enforced)', () => {
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  const itemId = uuid();
  raw.prepare('INSERT INTO items (id, name, category, units_per_pack, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(itemId, 'Paracetamol 500mg', 'Medicine', 10, now, now);
  raw.prepare('INSERT INTO stock_batches (id, item_id, batch_no, qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), itemId, 'B100', 50, now, now);
  const batches = raw.prepare('SELECT * FROM stock_batches WHERE item_id = ?').all(itemId);
  assert.strictEqual(batches.length, 1);

  let fkRejected = false;
  try {
    raw.prepare('INSERT INTO stock_batches (id, item_id, batch_no, qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid(), 'nonexistent-item-id', 'B999', 1, now, now);
  } catch (e) {
    fkRejected = /FOREIGN KEY/i.test(e.message);
  }
  assert.ok(fkRejected, 'inserting a stock_batch with a non-existent item_id should be rejected by the foreign key');
  raw.close();
});

check('patient relationship: a sale can reference a patient, and stock_movements can reference both item and patient', () => {
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  const patientId = uuid();
  raw.prepare('INSERT INTO patients (id, name, contact, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(patientId, 'Test Patient', '9876543210', now, now);
  const itemRow = raw.prepare('SELECT id FROM items LIMIT 1').get();
  raw.prepare('INSERT INTO stock_movements (id, item_id, type, qty, bill_id, patient_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), itemRow.id, 'BILL', -2, 'BILL-TEST-1', patientId, now);
  const movement = raw.prepare('SELECT * FROM stock_movements WHERE patient_id = ?').get(patientId);
  assert.strictEqual(movement.bill_id, 'BILL-TEST-1');
  raw.close();
});

check('sale -> sale_items relationship, and bill_id UNIQUE constraint is enforced', () => {
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  const saleId = uuid();
  const itemRow = raw.prepare('SELECT id FROM items LIMIT 1').get();
  raw.prepare(`INSERT INTO sales (id, bill_id, total_amount, sale_date, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(saleId, 'BILL-TEST-2', 250, now, now, now);
  raw.prepare(`INSERT INTO sale_items (id, sale_id, item_id, drug_name, quantity, rate, total, affects_stock)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid(), saleId, itemRow.id, 'Paracetamol 500mg', 2, 5, 10, 1);
  const items = raw.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].drug_name, 'Paracetamol 500mg');

  let uniqueRejected = false;
  try {
    raw.prepare(`INSERT INTO sales (id, bill_id, total_amount, sale_date, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(uuid(), 'BILL-TEST-2', 999, now, now, now);
  } catch (e) {
    uniqueRejected = /UNIQUE/i.test(e.message);
  }
  assert.ok(uniqueRejected, 'a duplicate bill_id should be rejected by the UNIQUE constraint');
  raw.close();
});

check('deleting a sale cascades to its sale_items (ON DELETE CASCADE)', () => {
  const raw = new Database(dbPath);
  const saleId = raw.prepare("SELECT id FROM sales WHERE bill_id = 'BILL-TEST-2'").get().id;
  raw.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
  const remaining = raw.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  assert.strictEqual(remaining.length, 0, 'sale_items should be cascade-deleted with their parent sale');
  raw.close();
});

console.log('=== 8. Local-first billing transaction ===');

function sampleCartItem(overrides = {}) {
  return {
    name: 'Amoxicillin 500mg', category: 'Medicine', batch: 'AMX-1', expiry: '2027-01-01',
    mrp: 100, unitsPerPack: 10, gst: 12, stockist: 'Test Stockist', qty: 3, stock: 50,
    ...overrides,
  };
}

check('A. successful local sale creates sale + sale_items and reduces stock', () => {
  const billId = 'BILL-TEST-A-' + Date.now();
  const res = createLocalSale({
    billId, patientSnapshot: { name: 'Alice', contact: '9000000001' }, doctorName: 'Dr. X',
    paymentMode: 'Cash', subtotal: 300, totalTax: 0, totalAmount: 300, gstMode: 'regular',
    discount: 0, discountPercent: 0,
    paymentDetails: { breakdown: { Cash: 300 }, amountReceived: 300, outstandingAmount: 0, status: 'Paid', recordedBy: 'test@vhc' },
    items: [sampleCartItem()],
    extraParticulars: [],
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  const sale = getLocalSaleByBillId(billId);
  assert.ok(sale, 'sale should be retrievable by bill_id');
  assert.strictEqual(sale.sale_items.length, 1);
  assert.strictEqual(sale.total_amount, 300);

  const raw = new Database(dbPath, { readonly: true });
  const batch = raw.prepare("SELECT * FROM stock_batches WHERE batch_no = 'AMX-1'").get();
  raw.close();
  assert.strictEqual(batch.qty, 47, 'stock should be reduced from the seeded 50 by the sold 3');
});

check('B. insufficient stock is rejected and rolls back completely (no sale, no sale_items, no stock change)', () => {
  const billId = 'BILL-TEST-B-' + Date.now();
  const res = createLocalSale({
    billId, patientSnapshot: null, paymentMode: 'Cash', totalAmount: 100,
    paymentDetails: { amountReceived: 100, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 9999 })], // far more than the 47 units now in stock
    extraParticulars: [],
  });
  assert.strictEqual(res.success, false);
  assert.ok(/Insufficient stock/.test(res.error), res.error);
  assert.strictEqual(getLocalSaleByBillId(billId), null, 'no sale row should exist after a rejected transaction');

  const raw = new Database(dbPath, { readonly: true });
  const batch = raw.prepare("SELECT qty FROM stock_batches WHERE batch_no = 'AMX-1'").get();
  raw.close();
  assert.strictEqual(batch.qty, 47, 'stock must be unchanged after a rolled-back sale');
});

check('C/D. a brand-new item+batch is seeded from the cart stock, and the main process rejects a quantity above it', () => {
  const billId1 = 'BILL-TEST-CD1-' + Date.now();
  const res1 = createLocalSale({
    billId: billId1, paymentMode: 'Cash', totalAmount: 50,
    paymentDetails: { amountReceived: 50, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Brand New Drug', batch: 'BND-1', qty: 2, stock: 10 })],
    extraParticulars: [],
  });
  assert.strictEqual(res1.success, true, JSON.stringify(res1));
  const raw1 = new Database(dbPath, { readonly: true });
  const item = raw1.prepare("SELECT * FROM items WHERE name = 'Brand New Drug'").get();
  const batch = raw1.prepare("SELECT * FROM stock_batches WHERE batch_no = 'BND-1'").get();
  raw1.close();
  assert.ok(item, 'a new item row should have been created');
  assert.strictEqual(batch.qty, 8, 'seeded at 10, minus 2 sold');

  // The cart now reports 8 (its own optimistic paint of the previous sale). Selling 9 must be
  // rejected by the main process itself even if the renderer let it through.
  const res2 = createLocalSale({
    billId: 'BILL-TEST-CD2-' + Date.now(), paymentMode: 'Cash', totalAmount: 999,
    paymentDetails: { amountReceived: 999, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Brand New Drug', batch: 'BND-1', qty: 9, stock: 8 })],
    extraParticulars: [],
  });
  assert.strictEqual(res2.success, false);
  assert.ok(/Insufficient stock/.test(res2.error), res2.error);
});

check('E. an invalid quantity anywhere in the cart rolls back the ENTIRE bill, including its otherwise-valid lines', () => {
  const billId = 'BILL-TEST-E-' + Date.now();
  const res = createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 100,
    paymentDetails: { amountReceived: 100, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 }), sampleCartItem({ name: 'Second Drug', batch: 'SD-1', qty: -5, stock: 20 })],
    extraParticulars: [],
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(getLocalSaleByBillId(billId), null);
  const raw = new Database(dbPath, { readonly: true });
  const batch = raw.prepare("SELECT qty FROM stock_batches WHERE batch_no = 'AMX-1'").get();
  raw.close();
  assert.strictEqual(batch.qty, 47, 'the valid first line must NOT have been applied once the second line failed');
});

check('F/G/H. sale -> sale_items relationship, stock reduction, and stock_movement are all created together', () => {
  const billId = 'BILL-TEST-FGH-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 200,
    paymentDetails: { amountReceived: 200, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 2 })],
    extraParticulars: [],
  });
  const raw = new Database(dbPath, { readonly: true });
  const movement = raw.prepare("SELECT * FROM stock_movements WHERE bill_id = ? AND type = 'BILL'").get(billId);
  raw.close();
  assert.ok(movement, 'a stock_movement row should exist for this bill');
  assert.strictEqual(movement.type, 'BILL');
  assert.strictEqual(movement.qty, -2);
});

check('I. cash payment fields persist correctly', () => {
  const billId = 'BILL-TEST-I-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 60,
    paymentDetails: { breakdown: { Cash: 60 }, amountReceived: 60, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })],
    extraParticulars: [],
  });
  const sale = getLocalSaleByBillId(billId);
  assert.strictEqual(sale.payment_status, 'Paid');
  assert.strictEqual(sale.outstanding_amount, 0);
});

check('J. credit payment fields (amount_received=0, outstanding_amount=total, status=Credit) persist correctly', () => {
  const billId = 'BILL-TEST-J-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Credit', totalAmount: 150,
    paymentDetails: { breakdown: { credit: 150 }, amountReceived: 0, outstandingAmount: 150, status: 'Credit' },
    items: [sampleCartItem({ qty: 1 })],
    extraParticulars: [],
  });
  const sale = getLocalSaleByBillId(billId);
  assert.strictEqual(sale.payment_mode, 'Credit');
  assert.strictEqual(sale.amount_received, 0);
  assert.strictEqual(sale.outstanding_amount, 150);
  assert.strictEqual(sale.payment_status, 'Credit');
});

check('K. patient association: an existing patient (matched by contact) is reused, not duplicated', () => {
  const billId1 = 'BILL-TEST-K1-' + Date.now();
  const billId2 = 'BILL-TEST-K2-' + Date.now();
  createLocalSale({
    billId: billId1, patientSnapshot: { name: 'Bob', contact: '9000000002' }, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })], extraParticulars: [],
  });
  createLocalSale({
    billId: billId2, patientSnapshot: { name: 'Bob', contact: '9000000002' }, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })], extraParticulars: [],
  });
  const raw = new Database(dbPath, { readonly: true });
  const patients = raw.prepare("SELECT * FROM patients WHERE contact = '9000000002'").all();
  const sale1 = raw.prepare('SELECT patient_id FROM sales WHERE bill_id = ?').get(billId1);
  const sale2 = raw.prepare('SELECT patient_id FROM sales WHERE bill_id = ?').get(billId2);
  raw.close();
  assert.strictEqual(patients.length, 1, 'the same contact must resolve to exactly one patient row');
  assert.strictEqual(sale1.patient_id, sale2.patient_id);
});

check('L. duplicate bill_id protection: a second sale with the same bill_id is rejected, not silently overwritten', () => {
  const billId = 'BILL-TEST-L-' + Date.now();
  const first = createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })], extraParticulars: [],
  });
  assert.strictEqual(first.success, true);
  const second = createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })], extraParticulars: [],
  });
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.duplicate, true);
  assert.ok(/already exists/i.test(second.error), second.error);
  const raw = new Database(dbPath, { readonly: true });
  const n = raw.prepare('SELECT COUNT(*) AS c FROM sales WHERE bill_id = ?').get(billId).c;
  const moves = raw.prepare("SELECT COUNT(*) AS c FROM stock_movements WHERE bill_id = ? AND type = 'BILL'").get(billId).c;
  raw.close();
  assert.strictEqual(n, 1, 'exactly one sale row');
  assert.strictEqual(moves, 1, 'the rejected duplicate must not deduct stock a second time');
});

check('M/N. persistence: the sale survives close + reopen of the database', () => {
  const billId = 'BILL-TEST-MN-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ qty: 1 })], extraParticulars: [],
  });
  closeDatabase();
  initDatabase(dbPath);
  const sale = getLocalSaleByBillId(billId);
  assert.ok(sale, 'the sale must still be readable after a full close+reopen (simulates an app restart)');
});

check('O. rapid consecutive billing: 20 back-to-back sales all succeed with distinct primary keys', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    const billId = `BILL-TEST-RAPID-${Date.now()}-${i}`;
    const res = createLocalSale({
      billId, paymentMode: 'Cash', totalAmount: 5,
      paymentDetails: { amountReceived: 5, outstandingAmount: 0, status: 'Paid' },
      items: [sampleCartItem({ name: 'Rapid Fire Drug', batch: 'RF-1', qty: 1, stock: 100 })],
      extraParticulars: [],
    });
    assert.strictEqual(res.success, true, `rapid sale #${i} failed: ${res.error}`);
    assert.ok(!ids.has(res.saleId), 'no two sales should ever get the same primary key');
    ids.add(res.saleId);
  }
  assert.strictEqual(ids.size, 20);
});

check('P. cancellation restores stock atomically via a reverse stock_movement', () => {
  const billId = 'BILL-TEST-P-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 30,
    paymentDetails: { amountReceived: 30, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Cancel Test Drug', batch: 'CT-1', qty: 4, stock: 20 })],
    extraParticulars: [],
  });
  const rawBefore = new Database(dbPath, { readonly: true });
  const qtyAfterSale = rawBefore.prepare("SELECT qty FROM stock_batches WHERE batch_no = 'CT-1'").get().qty;
  rawBefore.close();
  assert.strictEqual(qtyAfterSale, 16);

  const cancelRes = cancelLocalSale(billId);
  assert.strictEqual(cancelRes.success, true, JSON.stringify(cancelRes));

  const raw = new Database(dbPath, { readonly: true });
  const qtyAfterCancel = raw.prepare("SELECT qty FROM stock_batches WHERE batch_no = 'CT-1'").get().qty;
  const sale = raw.prepare("SELECT status FROM sales WHERE bill_id = ?").get(billId);
  const reverseMovement = raw.prepare("SELECT * FROM stock_movements WHERE bill_id = ? AND type = 'RESTORE'").get(billId);
  raw.close();
  assert.strictEqual(qtyAfterCancel, 20, 'stock should be fully restored to its pre-sale quantity');
  assert.strictEqual(sale.status, 'deleted');
  assert.ok(reverseMovement, 'a reverse RESTORE stock_movement should exist');

  // Cancelling an already-cancelled (or never-existent) bill is a safe no-op, not an error.
  const secondCancel = cancelLocalSale(billId);
  assert.strictEqual(secondCancel.success, true);
  assert.strictEqual(secondCancel.noop, true);
});

console.log('=== 9. Credit repayments ===');

function makeCreditSale(billId, totalAmount, overrides = {}) {
  return createLocalSale({
    billId, paymentMode: 'Credit', totalAmount,
    paymentDetails: { breakdown: { credit: totalAmount }, amountReceived: 0, outstandingAmount: totalAmount, status: 'Credit' },
    items: [sampleCartItem({ qty: 1, name: 'CreditTestDrug', batch: 'CR-1', stock: 500 })],
    extraParticulars: [],
    ...overrides,
  });
}

check('1. migration 3 creates credit_repayments with the expected columns', () => {
  const raw = new Database(dbPath, { readonly: true });
  const cols = raw.prepare("PRAGMA table_info(credit_repayments)").all().map((c) => c.name);
  raw.close();
  for (const col of ['id', 'sale_id', 'amount', 'method', 'reference', 'payment_date', 'recorded_by', 'created_at']) {
    assert.ok(cols.includes(col), `missing column: ${col}`);
  }
});

const billA = 'BILL-CREDIT-A-' + Date.now();
check('2/5/6. a repayment can be recorded offline, with amount/method/reference/recordedBy preserved exactly', () => {
  makeCreditSale(billA, 1000);
  const res = recordCreditRepayment({ id: 'PMT-TEST-A1', billId: billA, amount: 300, method: 'cash', reference: 'REF-001', date: '2026-01-01T10:00:00.000Z', recordedBy: 'tester@vhc' });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(res.repayment.amount, 300);
  assert.strictEqual(res.repayment.method, 'cash');
  assert.strictEqual(res.repayment.reference, 'REF-001');
  assert.strictEqual(res.repayment.recorded_by, 'tester@vhc');
  assert.strictEqual(res.repayment.payment_date, '2026-01-01T10:00:00.000Z');
});

check('3. repayment persists after close + reopen (simulates app restart)', () => {
  closeDatabase();
  initDatabase(dbPath);
  const repayments = getCreditRepaymentsByBillId(billA);
  assert.strictEqual(repayments.length, 1);
  assert.strictEqual(repayments[0].id, 'PMT-TEST-A1');
});

check('4/11. multiple repayments for one sale accumulate correctly; outstanding reflects partial payment', () => {
  const res2 = recordCreditRepayment({ id: 'PMT-TEST-A2', billId: billA, amount: 400, method: 'upi', recordedBy: 'tester@vhc' });
  assert.strictEqual(res2.success, true, JSON.stringify(res2));
  const repayments = getCreditRepaymentsByBillId(billA);
  assert.strictEqual(repayments.length, 2, 'both repayments should be present');
  const settlement = getCreditSettlementByBillId(billA);
  assert.strictEqual(settlement.totalRepaid, 700);
  assert.strictEqual(settlement.outstanding, 300, '1000 - 300 - 400 = 300 outstanding');
  assert.strictEqual(settlement.status, 'Partially Paid');
});

check('10/12. a final repayment that clears the balance reaches status "Paid"', () => {
  const res3 = recordCreditRepayment({ id: 'PMT-TEST-A3', billId: billA, amount: 300, method: 'cash' });
  assert.strictEqual(res3.success, true, JSON.stringify(res3));
  const settlement = getCreditSettlementByBillId(billA);
  assert.strictEqual(settlement.outstanding, 0);
  assert.strictEqual(settlement.status, 'Paid');
  assert.strictEqual(settlement.totalRepaid, 1000);
});

check('7. a duplicate repayment id (retried IPC call) does not create a second row', () => {
  const before = getCreditRepaymentsByBillId(billA).length;
  const retryRes = recordCreditRepayment({ id: 'PMT-TEST-A1', billId: billA, amount: 300, method: 'cash', reference: 'REF-001', date: '2026-01-01T10:00:00.000Z', recordedBy: 'tester@vhc' });
  assert.strictEqual(retryRes.success, true, JSON.stringify(retryRes));
  assert.strictEqual(retryRes.duplicate, true);
  const after = getCreditRepaymentsByBillId(billA).length;
  assert.strictEqual(after, before, 'row count must not change on a retried/duplicate id');
});

check('8. a nonexistent sale is rejected safely, distinctly from a validation error', () => {
  const res = recordCreditRepayment({ id: 'PMT-TEST-GHOST', billId: 'BILL-DOES-NOT-EXIST-' + Date.now(), amount: 50 });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.reason, 'sale-not-found');
});

check('9. an over-limit repayment amount is rejected without creating a row', () => {
  const billB = 'BILL-CREDIT-B-' + Date.now();
  makeCreditSale(billB, 500);
  const res = recordCreditRepayment({ id: 'PMT-TEST-B1', billId: billB, amount: 9999 });
  assert.strictEqual(res.success, false);
  assert.ok(/cannot exceed/i.test(res.error), res.error);
  assert.strictEqual(getCreditRepaymentsByBillId(billB).length, 0);
});

check('13. recording a repayment does not corrupt or mutate the sale’s own stored columns', () => {
  const before = getLocalSaleByBillId(billA);
  const billC = 'BILL-CREDIT-C-' + Date.now();
  makeCreditSale(billC, 200);
  const saleBefore = getLocalSaleByBillId(billC);
  recordCreditRepayment({ id: 'PMT-TEST-C1', billId: billC, amount: 200 });
  const saleAfter = getLocalSaleByBillId(billC);
  // Per computeCreditSettlement's real semantics (traced from index-doBKNLAj.js before writing
  // this): a repayment must NEVER change the sale's own stored amount_received/
  // outstanding_amount/payment_status — those stay frozen at their checkout-time values
  // forever; only the derived, on-the-fly settlement (via getCreditSettlementByBillId) changes.
  assert.strictEqual(saveEqualsIgnoringUpdatedAt(saleBefore, saleAfter), true);
  assert.strictEqual(before.sale_items.length, getLocalSaleByBillId(billA).sale_items.length, 'unrelated sale must be untouched');
});
function saveEqualsIgnoringUpdatedAt(a, b) {
  const strip = (s) => JSON.stringify({ ...s, updated_at: null, sale_items: undefined });
  return strip(a) === strip(b);
}

console.log('=== 10. Sales history reads ===');

check('1/10/11/12/13. getSalesHistory returns local sales with billId/patient/payment fields preserved', () => {
  const billId = 'BILL-HIST-A-' + Date.now();
  createLocalSale({
    billId, patientSnapshot: { name: 'History Test Patient', contact: '9445566778' },
    doctorName: 'Dr. Hist', paymentMode: 'Cash', totalAmount: 120,
    paymentDetails: { breakdown: { Cash: 120 }, amountReceived: 120, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'HistDrug1', batch: 'H-1', qty: 1 })],
    extraParticulars: [],
  });
  const history = getSalesHistory();
  const bill = history.find((b) => b.billId === billId);
  assert.ok(bill, 'the new sale should appear in getSalesHistory()');
  assert.strictEqual(bill.patientName, 'History Test Patient');
  assert.strictEqual(bill.paymentMode, 'Cash');
  assert.strictEqual(bill.totalAmount, 120);
  assert.strictEqual(bill.amountReceived, 120);
  assert.strictEqual(bill.outstandingAmount, 0);
  assert.strictEqual(bill.paymentStatus, 'Paid');
});

check('2/3. sale_items map correctly to particulars[], and metadata-backed fields survive the mapping', () => {
  const billId = 'BILL-HIST-B-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 50,
    paymentDetails: { amountReceived: 50, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'HistDrug2', batch: 'H-2', qty: 3, rate: 10 })],
    extraParticulars: [{ category: 'Custom', drugName: '➕ Consultation Fee', quantity: 1, rate: 100, total: 100, label: 'Consultation Fee', amount: 100 }],
  });
  const bill = getSalesHistory().find((b) => b.billId === billId);
  assert.strictEqual(bill.particulars.length, 2);
  const medicineLine = bill.particulars.find((p) => p.category === 'Medicine');
  assert.strictEqual(medicineLine.drugName, 'HistDrug2');
  assert.strictEqual(medicineLine.batchNo, 'H-2');
  assert.strictEqual(medicineLine.quantity, 3);
  const customLine = bill.particulars.find((p) => p.category === 'Custom');
  assert.strictEqual(customLine.label, 'Consultation Fee', 'metadata-backed field (label) must survive the sale_items.metadata -> particular mapping');
  assert.strictEqual(customLine.amount, 100);
});

check('4/5/6/7/8. credit repayments map correctly for unpaid, partial, and fully-paid settlements', () => {
  const billId = 'BILL-HIST-C-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Credit', totalAmount: 1000,
    paymentDetails: { breakdown: { credit: 1000 }, amountReceived: 0, outstandingAmount: 1000, status: 'Credit' },
    items: [sampleCartItem({ name: 'HistDrug3', batch: 'H-3', qty: 1 })],
    extraParticulars: [],
  });
  // Unpaid: no repayments yet.
  let bill = getSalesHistory().find((b) => b.billId === billId);
  assert.strictEqual(bill.creditRepayments.length, 0);

  // Partial: one repayment, method 'cash'.
  recordCreditRepayment({ id: 'PMT-HIST-C1', billId, amount: 400, method: 'cash', reference: 'R1', recordedBy: 'x@y' });
  bill = getSalesHistory().find((b) => b.billId === billId);
  assert.strictEqual(bill.creditRepayments.length, 1);
  assert.strictEqual(bill.creditRepayments[0].amount, 400);
  assert.strictEqual(bill.creditRepayments[0].method, 'cash');
  assert.strictEqual(bill.creditRepayments[0].reference, 'R1');
  assert.strictEqual(bill.creditRepayments[0].recordedBy, 'x@y');

  // Fully paid: second repayment via a different method clears the balance.
  recordCreditRepayment({ id: 'PMT-HIST-C2', billId, amount: 600, method: 'upi' });
  bill = getSalesHistory().find((b) => b.billId === billId);
  assert.strictEqual(bill.creditRepayments.length, 2, 'multiple repayments should all appear');
  const settlement = getCreditSettlementByBillId(billId);
  assert.strictEqual(settlement.outstanding, 0);
  assert.strictEqual(settlement.status, 'Paid');
});

check('9. a cancelled (deleted) sale is excluded from getSalesHistory, matching existing app behavior', () => {
  const billId = 'BILL-HIST-D-' + Date.now();
  createLocalSale({
    billId, paymentMode: 'Cash', totalAmount: 60,
    paymentDetails: { amountReceived: 60, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'HistDrug4', batch: 'H-4', qty: 1 })],
    extraParticulars: [],
  });
  assert.ok(getSalesHistory().find((b) => b.billId === billId), 'should be visible before cancellation');
  cancelLocalSale(billId);
  assert.ok(!getSalesHistory().find((b) => b.billId === billId), 'a cancelled sale must not appear, exactly like the existing localStorage-based Reports behavior');
});

check('10-repeat. multiple sales are all returned, each with correct fields', () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const billId = `BILL-HIST-MULTI-${Date.now()}-${i}`;
    ids.push(billId);
    createLocalSale({
      billId, paymentMode: 'Cash', totalAmount: 10 + i,
      paymentDetails: { amountReceived: 10 + i, outstandingAmount: 0, status: 'Paid' },
      items: [sampleCartItem({ name: 'MultiDrug', batch: 'M-1', qty: 1 })],
      extraParticulars: [],
    });
  }
  const history = getSalesHistory();
  for (const billId of ids) assert.ok(history.find((b) => b.billId === billId), `missing ${billId}`);
});

check('14. getSalesSummary reports correct billCount/totalRevenue/uniquePatientCount', () => {
  const before = getSalesSummary();
  const billId = 'BILL-SUMMARY-' + Date.now();
  createLocalSale({
    billId, patientSnapshot: { name: 'Summary Patient ' + Date.now() }, paymentMode: 'Cash', totalAmount: 77,
    paymentDetails: { amountReceived: 77, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'SummaryDrug', batch: 'S-1', qty: 1 })],
    extraParticulars: [],
  });
  const after = getSalesSummary();
  assert.strictEqual(after.billCount, before.billCount + 1);
  assert.strictEqual(Math.round((after.totalRevenue - before.totalRevenue) * 100) / 100, 77);
  assert.ok(after.uniquePatientCount >= before.uniquePatientCount);
});

check('17. an empty database (no sales yet) behaves correctly, not an error', () => {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE database_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE sales (id TEXT PRIMARY KEY, bill_id TEXT, status TEXT, patient_name TEXT, total_amount REAL, sale_date TEXT);
  `);
  const emptyResult = raw.prepare("SELECT COUNT(*) AS c FROM sales WHERE status = 'active'").get();
  assert.strictEqual(emptyResult.c, 0);
  raw.close();
  // (getSalesHistory()/getSalesSummary() themselves are exercised against the real, non-empty
  // module-level `db` throughout this file; this check independently confirms the underlying
  // "no rows" SQL shape returns a clean empty/zero result rather than throwing, which is what
  // both functions rely on for a genuinely fresh install.)
});

console.log('=== 11. VHC stock model, isolation and safety ===');

function batchQty(batchNo) {
  const raw = new Database(dbPath, { readonly: true });
  const row = raw.prepare('SELECT qty FROM stock_batches WHERE batch_no = ?').get(batchNo);
  raw.close();
  return row ? row.qty : undefined;
}
function sellOne(name, batch, qty, stock, extra = {}) {
  return createLocalSale({
    billId: `BILL-VHC-${batch}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name, batch, qty, stock })], extraParticulars: [], ...extra,
  });
}

check('V1. schema is exactly version 3 with no sync_queue table (sync engine is not part of this database)', () => {
  const raw = new Database(dbPath, { readonly: true });
  const versions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  raw.close();
  assert.deepStrictEqual(versions, [1, 2, 3]);
  assert.ok(!tables.includes('sync_queue'), 'no sync_queue table must exist');
  assert.ok(tables.includes('credit_repayments'));
});

check('V2. cloud restock: a higher cart stock reconciles the local ledger instead of rejecting a valid sale (audited)', () => {
  assert.strictEqual(sellOne('Restock Drug', 'RS-1', 2, 10).success, true);
  assert.strictEqual(batchQty('RS-1'), 8);
  const res = sellOne('Restock Drug', 'RS-1', 5, 60); // purchase/transfer raised real stock to 60
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(batchQty('RS-1'), 55);
  const raw = new Database(dbPath, { readonly: true });
  const rec = raw.prepare("SELECT * FROM stock_movements WHERE type = 'RECONCILE' AND batch_no = 'RS-1'").get();
  raw.close();
  assert.ok(rec, 'a RECONCILE movement must be recorded');
  assert.strictEqual(rec.opening, 8);
  assert.strictEqual(rec.closing, 60);
  assert.strictEqual(rec.qty, 52);
});

check('V3. cloud stock lowered elsewhere: local ledger follows it, and an oversell against it is rejected', () => {
  const bad = sellOne('Restock Drug', 'RS-1', 4, 3);
  assert.strictEqual(bad.success, false);
  assert.ok(/Insufficient stock/.test(bad.error), bad.error);
  assert.strictEqual(batchQty('RS-1'), 55, 'a rejected sale must leave the ledger (and its reconcile) untouched');
  const ok = sellOne('Restock Drug', 'RS-1', 2, 3);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(batchQty('RS-1'), 1);
});

check('V4. two lines on the same batch in one bill stack their deductions and cannot jointly oversell', () => {
  const okRes = createLocalSale({
    billId: 'BILL-VHC-SAMEBATCH-OK-' + Date.now(), paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Same Batch Drug', batch: 'SB-1', qty: 4, stock: 10 }), sampleCartItem({ name: 'Same Batch Drug', batch: 'SB-1', qty: 4, stock: 10 })],
    extraParticulars: [],
  });
  assert.strictEqual(okRes.success, true, JSON.stringify(okRes));
  assert.strictEqual(batchQty('SB-1'), 2, '10 - 4 - 4');
  const badRes = createLocalSale({
    billId: 'BILL-VHC-SAMEBATCH-BAD-' + Date.now(), paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Same Batch Drug', batch: 'SB-1', qty: 2, stock: 2 }), sampleCartItem({ name: 'Same Batch Drug', batch: 'SB-1', qty: 1, stock: 2 })],
    extraParticulars: [],
  });
  assert.strictEqual(badRes.success, false, '2 + 1 exceeds the 2 available');
  assert.strictEqual(batchQty('SB-1'), 2);
});

check('V5. when the payload carries no usable stock figure, the local quantity is what is enforced', () => {
  assert.strictEqual(sellOne('No Stock Field Drug', 'NS-1', 2, 10).success, true);
  assert.strictEqual(batchQty('NS-1'), 8);
  assert.strictEqual(sellOne('No Stock Field Drug', 'NS-1', 9, undefined).success, false);
  assert.strictEqual(sellOne('No Stock Field Drug', 'NS-1', 8, undefined).success, true);
  assert.strictEqual(batchQty('NS-1'), 0);
});

check('V6. non-stock lines only (procedure/consultation) create a sale and touch no stock', () => {
  const countMovements = () => {
    const r = new Database(dbPath, { readonly: true });
    const c = r.prepare('SELECT COUNT(*) AS c FROM stock_movements').get().c;
    r.close();
    return c;
  };
  const before = countMovements();
  const res = createLocalSale({
    billId: 'BILL-VHC-NONSTOCK-' + Date.now(), paymentMode: 'Cash', totalAmount: 100,
    paymentDetails: { amountReceived: 100, outstandingAmount: 0, status: 'Paid' },
    items: [], extraParticulars: [{ category: 'Custom', drugName: 'Consultation Fee', quantity: 1, rate: 100, total: 100 }],
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(countMovements(), before);
});

check('V7. cancel restores exactly what the sale deducted (post-reconcile quantity), and only once', () => {
  const bill = 'BILL-VHC-CANCEL-' + Date.now();
  assert.strictEqual(createLocalSale({
    billId: bill, paymentMode: 'Cash', totalAmount: 10,
    paymentDetails: { amountReceived: 10, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Cancel Reconcile Drug', batch: 'CRC-1', qty: 3, stock: 20 })], extraParticulars: [],
  }).success, true);
  assert.strictEqual(batchQty('CRC-1'), 17);
  assert.strictEqual(cancelLocalSale(bill).success, true);
  assert.strictEqual(batchQty('CRC-1'), 20);
  assert.strictEqual(cancelLocalSale(bill).noop, true);
  assert.strictEqual(batchQty('CRC-1'), 20, 'a second cancel must not restore twice');
});

check('V7b. business rejections are flagged rejected:true; infrastructure failures are not', () => {
  const insufficient = sellOne('Flag Drug', 'FL-1', 99, 5);
  assert.strictEqual(insufficient.success, false);
  assert.strictEqual(insufficient.rejected, true, 'insufficient stock is a business rejection');
  const invalidQty = sellOne('Flag Drug', 'FL-1', -1, 5);
  assert.strictEqual(invalidQty.rejected, true);
  const dupBill = 'BILL-VHC-FLAGDUP-' + Date.now();
  const mk = () => createLocalSale({ billId: dupBill, paymentMode: 'Cash', totalAmount: 1, paymentDetails: { amountReceived: 1, outstandingAmount: 0, status: 'Paid' }, items: [sampleCartItem({ name: 'Flag Drug', batch: 'FL-1', qty: 1, stock: 5 })], extraParticulars: [] });
  assert.strictEqual(mk().success, true);
  assert.strictEqual(mk().rejected, true, 'duplicate bill is a business rejection');
  // Infrastructure failure: close the module's connection so any DB call throws/errs.
  closeDatabase();
  const noDb = sellOne('Flag Drug', 'FL-1', 1, 5);
  assert.strictEqual(noDb.success, false);
  assert.ok(!noDb.rejected, 'an unavailable database must NOT be reported as a business rejection');
  initDatabase(dbPath);
});

check('V8. isolation: database.js contains no NHC identity and no network/sync code', () => {
  const src = fs.readFileSync(new URL('./database.js', import.meta.url), 'utf8');
  for (const forbidden of ['Narpavi', 'NHC Pharmacy POS', 'NHCPharmacybot', 'NHC_Pharmacy_Data', 'nhc_pharmacy.db', 'nhc-pharmacy-pos', 'sync_queue', 'fetch(', 'supabase.co']) {
    assert.ok(!src.includes(forbidden), `database.js must not contain "${forbidden}"`);
  }
});

check('V9. a corrupt database file makes init throw cleanly, leaves no half-open connection, and later init still works', () => {
  closeDatabase();
  const badPath = path.join(tmpDir, 'corrupt.db');
  fs.writeFileSync(badPath, 'this is definitely not a sqlite database file '.repeat(50));
  assert.throws(() => initDatabase(badPath));
  assert.strictEqual(getDatabaseStatus().opened, false, 'no connection may remain after a failed init');
  assert.strictEqual(createLocalSale({ billId: 'X', items: [{ name: 'a', qty: 1 }] }).success, false);
  initDatabase(dbPath);
  assert.strictEqual(getDatabaseStatus().opened, true);
});

console.log('=== 12. Administrative clears (Clear Sales History / Reset / Factory Reset / Restore) ===');

function rawCount(table, where) {
  const r = new Database(dbPath, { readonly: true });
  const c = r.prepare(`SELECT COUNT(*) AS c FROM ${table}${where ? ' WHERE ' + where : ''}`).get().c;
  r.close();
  return c;
}
function adminSale(billId, batch, qty, stock, mode = 'Cash') {
  return createLocalSale({
    billId, patientSnapshot: { name: 'Admin Patient ' + billId, contact: '95' + Math.floor(Math.random() * 1e8) },
    paymentMode: mode, totalAmount: 100,
    paymentDetails: mode === 'Credit'
      ? { breakdown: { credit: 100 }, amountReceived: 0, outstandingAmount: 100, status: 'Credit' }
      : { breakdown: { Cash: 100 }, amountReceived: 100, outstandingAmount: 0, status: 'Paid' },
    items: [sampleCartItem({ name: 'Admin Drug', batch, qty, stock })], extraParticulars: [],
  });
}
function seedAdminData(prefix) {
  const s1 = `${prefix}-CASH`, s2 = `${prefix}-CREDIT`, s3 = `${prefix}-CANCELLED`;
  assert.strictEqual(adminSale(s1, 'ADM-1', 2, 100).success, true);
  assert.strictEqual(adminSale(s2, 'ADM-1', 3, 98, 'Credit').success, true);
  assert.strictEqual(recordCreditRepayment({ id: `PMT-${prefix}-1`, billId: s2, amount: 40, method: 'cash' }).success, true);
  assert.strictEqual(adminSale(s3, 'ADM-1', 1, 95).success, true);
  assert.strictEqual(cancelLocalSale(s3).success, true);
  return { s1, s2, s3 };
}

check('W1. Clear Sales History removes sales, lines, repayments, cancelled tombstones and sale-linked movements', () => {
  const b = seedAdminData('W1');
  assert.ok(rawCount('sales') >= 3 && rawCount('credit_repayments') >= 1 && rawCount('sales', "status='deleted'") >= 1);
  const res = clearSalesHistoryData();
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.ok(res.cleared.sales >= 3 && res.cleared.creditRepayments >= 1 && res.cleared.saleItems >= 3);
  assert.strictEqual(rawCount('sales'), 0);
  assert.strictEqual(rawCount('sale_items'), 0);
  assert.strictEqual(rawCount('credit_repayments'), 0);
  assert.strictEqual(rawCount('stock_movements', 'bill_id IS NOT NULL'), 0);
  assert.deepStrictEqual(getSalesHistory(), []);
  assert.strictEqual(getLocalSaleByBillId(b.s1), null);
  assert.deepStrictEqual(getCreditRepaymentsByBillId(b.s2), []);
  assert.strictEqual(getSalesSummary().billCount, 0);
});

check('W2. Clear Sales History PRESERVES inventory: items, patients and stock_batches quantities are untouched', () => {
  const b = seedAdminData('W2');
  const before = {
    items: rawCount('items'), patients: rawCount('patients'), batches: rawCount('stock_batches'),
    admQty: (() => { const r = new Database(dbPath, { readonly: true }); const q = r.prepare("SELECT qty FROM stock_batches WHERE batch_no='ADM-1'").get().qty; r.close(); return q; })(),
  };
  assert.strictEqual(clearSalesHistoryData().success, true);
  const r = new Database(dbPath, { readonly: true });
  const admQty = r.prepare("SELECT qty FROM stock_batches WHERE batch_no='ADM-1'").get().qty;
  r.close();
  assert.strictEqual(rawCount('items'), before.items);
  assert.strictEqual(rawCount('patients'), before.patients);
  assert.strictEqual(rawCount('stock_batches'), before.batches);
  assert.strictEqual(admQty, before.admQty, 'stock quantity must not change when sales history is cleared');
  assert.ok(b.s1);
});

check('W3. after a clear, new sales work, including reusing an old bill id, and history shows only the new sale', () => {
  const id = 'W3-REUSE';
  assert.strictEqual(adminSale(id, 'ADM-1', 1, 90).success, true);
  assert.strictEqual(clearSalesHistoryData().success, true);
  assert.strictEqual(adminSale(id, 'ADM-1', 1, 90).success, true, 'a cleared bill id may be used again');
  const h = getSalesHistory();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].billId, id);
});

check('W4. clearing twice / on an empty sales table is a harmless success with zero counts', () => {
  assert.strictEqual(clearSalesHistoryData().success, true);
  const again = clearSalesHistoryData();
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.cleared.sales, 0);
});

check('W5. Factory Reset variant also clears the local stock ledger but keeps items and patients', () => {
  seedAdminData('W5');
  const items = rawCount('items'), patients = rawCount('patients');
  assert.ok(rawCount('stock_batches') > 0 && rawCount('stock_movements') > 0);
  const res = clearSalesAndInventoryLedgerData();
  assert.strictEqual(res.success, true, JSON.stringify(res));
  for (const t of ['sales', 'sale_items', 'credit_repayments', 'stock_movements', 'stock_batches']) assert.strictEqual(rawCount(t), 0, t);
  assert.strictEqual(rawCount('items'), items, 'the product catalog shadow is preserved');
  assert.strictEqual(rawCount('patients'), patients, 'patients are preserved');
  assert.strictEqual(adminSale('W5-AFTER', 'ADM-1', 1, 50).success, true, 'billing works after a factory reset');
});

check('W6. a failure part-way rolls back EVERYTHING (real blocking trigger): nothing is deleted and success is not reported', () => {
  clearSalesAndInventoryLedgerData();
  seedAdminData('W6');
  const snap = () => ({ sales: rawCount('sales'), items: rawCount('sale_items'), rep: rawCount('credit_repayments'), mov: rawCount('stock_movements'), batches: rawCount('stock_batches') });
  const before = snap();
  assert.ok(before.sales > 0 && before.rep > 0 && before.mov > 0);
  const raw = new Database(dbPath);
  raw.exec("CREATE TRIGGER block_sales_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'simulated sqlite failure'); END;");
  raw.close();
  const res = clearSalesHistoryData();
  assert.strictEqual(res.success, false);
  assert.ok(/simulated sqlite failure/.test(res.error), res.error);
  assert.deepStrictEqual(snap(), before, 'credit_repayments/sale_items deleted before the failing step must have been rolled back');
  const raw2 = new Database(dbPath);
  raw2.exec('DROP TRIGGER block_sales_delete;');
  raw2.exec("CREATE TRIGGER block_batches_delete BEFORE DELETE ON stock_batches BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END;");
  raw2.close();
  const res2 = clearSalesAndInventoryLedgerData();
  assert.strictEqual(res2.success, false);
  assert.deepStrictEqual(snap(), before, 'the factory variant must roll back the sales deletions too');
  const raw3 = new Database(dbPath);
  raw3.exec('DROP TRIGGER block_batches_delete;');
  raw3.close();
  assert.strictEqual(clearSalesHistoryData().success, true, 'works again once the fault is gone');
});

check('W7. with no open database the clears report failure (never throw, never claim success)', () => {
  closeDatabase();
  const a = clearSalesHistoryData();
  const b = clearSalesAndInventoryLedgerData();
  assert.strictEqual(a.success, false);
  assert.strictEqual(b.success, false);
  assert.ok(!a.rejected);
  initDatabase(dbPath);
});

console.log('=== 13. Clear Inventory (local stock shadow) ===');

function ledgerSnapshot() {
  return {
    sales: rawCount('sales'), saleItems: rawCount('sale_items'), repayments: rawCount('credit_repayments'),
    saleMovements: rawCount('stock_movements', 'bill_id IS NOT NULL'), items: rawCount('items'), patients: rawCount('patients'),
  };
}

check('X1. Clear Inventory empties stock_batches but keeps sales, repayments, sale audit, items and patients (history reads identical)', () => {
  clearSalesAndInventoryLedgerData();
  const b = seedAdminData('X1');
  const raw = new Database(dbPath);
  const itemId = raw.prepare('SELECT id FROM items LIMIT 1').get().id;
  raw.prepare("INSERT INTO stock_movements (id, item_id, type, qty, created_at) VALUES ('MOVE-NOBILL', ?, 'EDIT', 5, ?)").run(itemId, new Date().toISOString());
  raw.close();
  assert.ok(rawCount('stock_batches') > 0);
  const before = ledgerSnapshot();
  const historyBefore = JSON.stringify(getSalesHistory());
  const settlementBefore = JSON.stringify(getCreditSettlementByBillId(b.s2));
  const res = clearInventoryLedgerData();
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(rawCount('stock_batches'), 0, 'current stock shadow must be empty');
  assert.strictEqual(rawCount('stock_movements', "id = 'MOVE-NOBILL'"), 0, 'a pure inventory movement (no bill id) is removed');
  assert.deepStrictEqual(ledgerSnapshot(), before, 'sales, lines, repayments, sale-linked audit, items and patients must be untouched');
  assert.strictEqual(JSON.stringify(getSalesHistory()), historyBefore, 'history reads must be byte-identical');
  assert.strictEqual(JSON.stringify(getCreditSettlementByBillId(b.s2)), settlementBefore, 'credit repayment history must be identical');
  assert.strictEqual(rawCount('sale_items', 'stock_batch_id IS NOT NULL'), 0, 'historical lines are detached from the deleted batches');
  assert.ok(res.cleared.detachedSaleItems > 0);
});

check('X2. cancelling an old bill after Clear Inventory succeeds and restores no local stock (there is none)', () => {
  const res = cancelLocalSale('X1-CASH');
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.ok(!res.noop, 'the bill is still an active local sale');
  assert.strictEqual(rawCount('sales', "bill_id = 'X1-CASH' AND status = 'deleted'"), 1);
  assert.strictEqual(rawCount('stock_batches'), 0, 'no batch may be resurrected by a cancel');
  assert.strictEqual(rawCount('stock_movements', "bill_id = 'X1-CASH' AND type = 'RESTORE'"), 0);
});

check('X3. after Clear Inventory a new sale recreates the batch from the cart stock and old history is intact', () => {
  const histBefore = getSalesHistory().length;
  const res = adminSale('X3-NEW', 'ADM-1', 1, 50);
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(batchQty('ADM-1'), 49, 'seeded from the cart stock (50) then reduced by the sale');
  assert.strictEqual(getSalesHistory().length, histBefore + 1);
});

check('X4. a failure part-way rolls back the whole Clear Inventory (real blocking trigger)', () => {
  const beforeBatches = rawCount('stock_batches');
  const beforeLinked = rawCount('sale_items', 'stock_batch_id IS NOT NULL');
  assert.ok(beforeBatches > 0 && beforeLinked > 0);
  const raw = new Database(dbPath);
  raw.exec("CREATE TRIGGER block_batches_delete2 BEFORE DELETE ON stock_batches BEGIN SELECT RAISE(ABORT, 'simulated inventory failure'); END;");
  raw.close();
  const res = clearInventoryLedgerData();
  assert.strictEqual(res.success, false);
  assert.ok(/simulated inventory failure/.test(res.error), res.error);
  assert.strictEqual(rawCount('stock_batches'), beforeBatches);
  assert.strictEqual(rawCount('sale_items', 'stock_batch_id IS NOT NULL'), beforeLinked, 'the detach UPDATE must be rolled back too');
  const raw2 = new Database(dbPath);
  raw2.exec('DROP TRIGGER block_batches_delete2;');
  raw2.close();
  assert.strictEqual(clearInventoryLedgerData().success, true, 'works again once the fault is gone');
});

check('X5. Clear Inventory is idempotent, and with no open database it reports failure instead of claiming success', () => {
  const again = clearInventoryLedgerData();
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.cleared.stockBatches, 0);
  closeDatabase();
  const closed = clearInventoryLedgerData();
  assert.strictEqual(closed.success, false);
  assert.ok(!closed.rejected);
  initDatabase(dbPath);
});

console.log('\n=== Cleanup ===');
try { closeDatabase(); } catch (e) {}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  Temporary test database removed:', tmpDir);
} catch (e) {
  console.log('  Cleanup warning:', e.message);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
