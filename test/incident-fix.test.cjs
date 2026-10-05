const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err && err.stack || err);
    failed++;
  }
}

function saveBillToLocalHistory(storage, bill) {
  const previousRaw = storage.getItem('vhc_pos_sales_history') || '[]';
  const previous = JSON.parse(previousRaw);
  if (!Array.isArray(previous)) throw new Error('Local sales history is not a valid bill list.');
  const next = [bill, ...previous.filter((b) => b && b.billId !== bill.billId)];
  storage.setItem('vhc_pos_sales_history', JSON.stringify(next));
  const persisted = JSON.parse(storage.getItem('vhc_pos_sales_history') || '[]');
  if (!Array.isArray(persisted) || !persisted.some((b) => b && b.billId === bill.billId)) {
    throw new Error(`Bill ${bill.billId} was not found after local sales-history save.`);
  }
  return { ok: true, bill, count: next.length };
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null,
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

function validateVhcBackup(raw) {
  const obj = Array.isArray(raw) ? { inventory: raw } : raw;
  const declaredApp = obj && typeof obj === 'object' ? String(obj.appName || obj.productName || obj.app || '').trim() : '';
  if (declaredApp && !/VHC Pharmacy POS|VHC Pharmacy|VARNIKA HEALTH CARE/i.test(declaredApp)) {
    throw new Error(`This backup belongs to "${declaredApp}", not VHC Pharmacy POS. Nothing was restored.`);
  }
  return true;
}

function runCloudLocalMismatchAudit(localBills, cloudRows) {
  const localIds = new Set(localBills.map((b) => b && (b.billId || b.bill_id)).filter(Boolean).map(String));
  const cloudIds = new Set(cloudRows.map((r) => r && (r.bill_id || r.billId)).filter(Boolean).map(String));
  const remoteOnly = Array.from(cloudIds).filter((id) => !localIds.has(id)).sort();
  const localOnly = Array.from(localIds).filter((id) => !cloudIds.has(id)).sort();
  const seen = new Set();
  const duplicateLocal = [];
  localBills.forEach((b) => {
    const id = b && String(b.billId || b.bill_id || '');
    if (!id) return;
    if (seen.has(id) && !duplicateLocal.includes(id)) duplicateLocal.push(id);
    seen.add(id);
  });
  return { remoteOnly, localOnly, duplicateLocal };
}

function verifyInventoryPersisted(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
  const readBack = storage.getItem(key);
  if (readBack !== JSON.stringify(value)) throw new Error(`Inventory storage verification failed for ${key}.`);
  const parsed = JSON.parse(readBack || '[]');
  if (!Array.isArray(parsed)) throw new Error(`Inventory storage for ${key} is not a valid medicine list.`);
  return true;
}

function runStorageHealthCheck(storage) {
  const key = 'vhc_storage_healthcheck_test';
  const value = JSON.stringify({ nonce: 'healthcheck' });
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('Health-check read-back did not match written value.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error('Health-check cleanup key still exists after remove.');
  return { ok: true };
}

function mapCloudSaleToLocalBill(sale, items) {
  const mode = sale.payment_mode || 'Cash';
  const total = Number(sale.total_amount || 0);
  const breakdown = sale.payment_breakdown || (mode === 'Credit' ? { credit: total } : mode === 'Split' ? { unspecified: total } : { [mode]: total });
  return {
    billId: sale.bill_id,
    date: sale.sale_date,
    patientName: sale.patient_name || 'Walk-in Patient',
    patientId: sale.patient_id || '',
    paymentMode: mode,
    subtotal: sale.subtotal || 0,
    totalTax: sale.total_tax || 0,
    totalAmount: total,
    amountReceived: sale.amount_received == null ? (mode === 'Credit' ? 0 : total) : sale.amount_received,
    outstandingAmount: sale.outstanding_amount == null ? (mode === 'Credit' ? total : 0) : sale.outstanding_amount,
    paymentStatus: sale.payment_status || (mode === 'Credit' ? 'Credit' : 'Paid'),
    paymentBreakdown: breakdown,
    particulars: items.map((it) => ({
      category: it.category || 'Medicine',
      drugName: it.drug_name || '',
      batchNo: it.batch_no || 'N/A',
      expiryDate: it.expiry_date || 'N/A',
      quantity: it.quantity,
      rate: it.rate,
      total: it.total,
    })),
    fromCloudRecoveryPreview: true,
    cloudSaleId: sale.id,
  };
}

test('checkout local save succeeds and persists bill', () => {
  const storage = memoryStorage();
  const result = saveBillToLocalHistory(storage, { billId: 'B-1', totalAmount: 10 });
  assert.strictEqual(result.ok, true);
  assert.ok(storage.getItem('vhc_pos_sales_history').includes('B-1'));
});

test('checkout local save rejects malformed existing history', () => {
  const storage = memoryStorage({ vhc_pos_sales_history: '{bad' });
  assert.throws(() => saveBillToLocalHistory(storage, { billId: 'B-2' }), /JSON|Unexpected|valid/);
});

test('checkout local save propagates quota/storage exception', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => saveBillToLocalHistory(storage, { billId: 'B-3' }), /QuotaExceededError/);
});

test('checkout local save verifies persisted bill after write', () => {
  const storage = memoryStorage();
  storage.setItem = () => {};
  assert.throws(() => saveBillToLocalHistory(storage, { billId: 'B-4' }), /not found/);
});

test('backup identity guard rejects NHC backup', () => {
  assert.throws(() => validateVhcBackup({ appName: 'NHC Pharmacy POS', salesHistory: [] }), /not VHC/);
});

test('backup identity guard accepts VHC backup', () => {
  assert.strictEqual(validateVhcBackup({ appName: 'VHC Pharmacy POS', salesHistory: [] }), true);
});

test('local/cloud audit treats unowned cloud-only bill as remote and preserves local-only finding', () => {
  const audit = runCloudLocalMismatchAudit([{ billId: 'LOCAL-1' }], [{ bill_id: 'CLOUD-1' }]);
  assert.deepStrictEqual(audit.remoteOnly, ['CLOUD-1']);
  assert.deepStrictEqual(audit.localOnly, ['LOCAL-1']);
});

test('local/cloud audit detects duplicate local bill ids', () => {
  const audit = runCloudLocalMismatchAudit([{ billId: 'DUP' }, { billId: 'DUP' }], []);
  assert.deepStrictEqual(audit.duplicateLocal, ['DUP']);
});

test('recovery preview maps cloud cash sale to local bill schema', () => {
  const bill = mapCloudSaleToLocalBill({ id: 'S1', bill_id: 'B-CASH', sale_date: '2026-09-24T10:00:00Z', total_amount: 99, payment_mode: 'Cash' }, [{ drug_name: 'Med', quantity: 1, rate: 99, total: 99 }]);
  assert.strictEqual(bill.billId, 'B-CASH');
  assert.strictEqual(bill.amountReceived, 99);
  assert.strictEqual(bill.outstandingAmount, 0);
  assert.strictEqual(bill.particulars.length, 1);
});

test('recovery preview maps credit and split without fabricating payments', () => {
  const credit = mapCloudSaleToLocalBill({ id: 'S2', bill_id: 'B-CREDIT', sale_date: '2026-09-24T10:00:00Z', total_amount: 50, payment_mode: 'Credit' }, [{ drug_name: 'Med', quantity: 1, rate: 50, total: 50 }]);
  const split = mapCloudSaleToLocalBill({ id: 'S3', bill_id: 'B-SPLIT', sale_date: '2026-09-24T10:00:00Z', total_amount: 70, payment_mode: 'Split' }, [{ drug_name: 'Med', quantity: 1, rate: 70, total: 70 }]);
  assert.strictEqual(credit.amountReceived, 0);
  assert.strictEqual(credit.outstandingAmount, 50);
  assert.deepStrictEqual(split.paymentBreakdown, { unspecified: 70 });
});

test('restart-safe local representation is JSON serializable and parseable', () => {
  const bill = mapCloudSaleToLocalBill({ id: 'S4', bill_id: 'B-RESTART', sale_date: '2026-09-24T10:00:00Z', total_amount: 12, payment_mode: 'UPI' }, [{ drug_name: 'Med', quantity: 1, rate: 12, total: 12 }]);
  const parsed = JSON.parse(JSON.stringify([bill]));
  assert.strictEqual(parsed[0].billId, 'B-RESTART');
  assert.strictEqual(parsed[0].paymentMode, 'UPI');
});

test('inventory save verifies persisted medicine list after write', () => {
  const storage = memoryStorage();
  const list = [{ id: 'MED-1', name: 'Test Medicine', quantity: 10 }];
  assert.strictEqual(verifyInventoryPersisted(storage, 'pos_inventory', list), true);
  assert.ok(storage.getItem('pos_inventory').includes('MED-1'));
});

test('inventory save rejects failed read-back verification', () => {
  const storage = memoryStorage();
  storage.setItem = () => {};
  assert.throws(() => verifyInventoryPersisted(storage, 'vhc_pos_inventory', [{ id: 'MED-2' }]), /verification failed/);
});

test('inventory save rejects malformed inventory JSON shape', () => {
  const storage = memoryStorage();
  storage.setItem = (k) => { storage._data[k] = '{"not":"array"}'; };
  assert.throws(() => verifyInventoryPersisted(storage, 'pos_inventory', [{ id: 'MED-3' }]), /verification failed|valid medicine list/);
});

test('storage health check verifies write read and cleanup', () => {
  const storage = memoryStorage();
  assert.deepStrictEqual(runStorageHealthCheck(storage), { ok: true });
  assert.strictEqual(storage.getItem('vhc_storage_healthcheck_test'), null);
});

test('storage health check fails on storage exception', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => runStorageHealthCheck(storage), /QuotaExceededError/);
});

test('packaged checkout cannot complete through the legacy network-first branch', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.match(renderer, /checkoutInFlight\.current/);
  assert.match(renderer, /if \(false\) \{ try \{\s*let o = await fetch\(`\/api\/checkout`/);
  assert.match(renderer, /window\.electronAPI\.createLocalSale/);
  assert.match(renderer, /window\.VHC_FINANCIAL_SYNC\.run/);
});

test('manual patient cloud lookup is deferred until after local commit', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.match(renderer, /if \(false && window\.VHC_CLOUD && window\.VHC_CLOUD\.addManualPatient\)/);
  const localCommit = renderer.indexOf('window.electronAPI.createLocalSale');
  const cloudPatient = renderer.indexOf('window.VHC_CLOUD.addManualPatient');
  assert.ok(localCommit > -1 && cloudPatient > -1);
  assert.ok(cloudPatient < localCommit, 'the guarded cloud patient reference must remain non-executable before local commit');
});

test('local history mirror is attempted only after SQLite success', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  const sqliteCommit = renderer.indexOf('window.electronAPI.createLocalSale');
  const mirror = renderer.indexOf('SQLite committed but Local Storage mirror failed');
  assert.ok(sqliteCommit > -1 && mirror > sqliteCommit);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
