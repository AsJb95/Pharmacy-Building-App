#!/usr/bin/env node
// v3.19.2: a bill deleted on THIS machine must not reappear in Reports from its cloud copy
// (e.g. when the cloud delete has not reached the server), while legitimate cloud-only bills
// from other terminals stay visible. Runs the REAL bundle code: mapDbSaleToLocalBill, the
// tombstone helpers, mergeCloudSalesIntoLocal and loadLocalSalesHistoryForUI, with a fake
// window/electronAPI.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) { pending.push({ name, fn }); }

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const a = bundle.indexOf('function mapDbSaleToLocalBill(');
const b = bundle.indexOf('// ─── Coordinated destructive admin changes to the sales-history layers ───', a);
assert.ok(a > 0 && b > a, 'bundle section must exist');

function load(win) {
  // eslint-disable-next-line no-new-func
  return new Function('window', 'localStorage', 'console', `${bundle.slice(a, b)}; return { mergeCloudSalesIntoLocal, loadLocalSalesHistoryForUI, vhcDeletedBillIdsFromSnapshot, vhcSuppressDeletedCloudRows, getDeleted: () => vhcLocalDeletedBillIds };`)(
    win, win.localStorage, { log() {}, warn() {}, error() {} });
}
const cloudRow = (billId, total = 10) => ({ bill_id: billId, sale_date: '2026-10-14T09:35:34Z', patient_name: 'P', total_amount: total, sale_items: [{ category: 'medicine', drug_name: 'X', quantity: '1.000', rate: total, total }] });
function makeWindow({ cloud = [], legacy = [], sqliteActive = [], snapshotSales = [], snapshotFails = false } = {}) {
  const store = new Map([['vhc_pos_sales_history', JSON.stringify(legacy)]]);
  return {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    VHC_CLOUD: { getSalesHistory: () => cloud },
    electronAPI: {
      getSalesHistory: async () => sqliteActive,
      getFinancialIntegritySnapshot: async () => {
        if (snapshotFails) throw new Error('db busy');
        return { success: true, sales: snapshotSales, operations: [] };
      },
    },
  };
}
const ids = (bills) => bills.map((x) => x.billId).sort();

check('locally deleted bill whose cloud copy still exists is suppressed (the ghost)', async () => {
  const win = makeWindow({
    cloud: [cloudRow('BILL-DELETED'), cloudRow('BILL-KEPT')],
    sqliteActive: [{ billId: 'BILL-KEPT', totalAmount: 10, particulars: [] }],
    snapshotSales: [{ bill_id: 'BILL-DELETED', status: 'deleted' }, { bill_id: 'BILL-KEPT', status: 'active' }],
  });
  const R = load(win);
  const local = await R.loadLocalSalesHistoryForUI();
  assert.deepStrictEqual(ids(R.mergeCloudSalesIntoLocal(local)), ['BILL-KEPT']);
});

check('unrelated cloud-only bills (another terminal) remain visible', async () => {
  const win = makeWindow({
    cloud: [cloudRow('BILL-OTHER-TERMINAL'), cloudRow('BILL-DELETED')],
    snapshotSales: [{ bill_id: 'BILL-DELETED', status: 'deleted' }],
  });
  const R = load(win);
  const merged = R.mergeCloudSalesIntoLocal(await R.loadLocalSalesHistoryForUI());
  assert.deepStrictEqual(ids(merged), ['BILL-OTHER-TERMINAL']);
  assert.strictEqual(merged[0].fromCloudOnly, true);
});

check('cancelled status is a tombstone too; active is never a tombstone', () => {
  const R = load(makeWindow());
  const t = R.vhcDeletedBillIdsFromSnapshot({ sales: [{ bill_id: 'A', status: 'cancelled' }, { bill_id: 'B', status: 'deleted' }, { bill_id: 'C', status: 'active' }] });
  assert.deepStrictEqual([...t].sort(), ['A', 'B']);
});

check('a bill id that is active locally again is not suppressed (local wins)', async () => {
  const win = makeWindow({
    cloud: [cloudRow('BILL-REDONE')],
    sqliteActive: [{ billId: 'BILL-REDONE', totalAmount: 10, particulars: [] }],
    snapshotSales: [{ bill_id: 'BILL-REDONE', status: 'deleted' }, { bill_id: 'BILL-REDONE', status: 'active' }],
  });
  const R = load(win);
  assert.deepStrictEqual(ids(R.mergeCloudSalesIntoLocal(await R.loadLocalSalesHistoryForUI())), ['BILL-REDONE']);
});

check('a failed tombstone read keeps the previous tombstones (no resurrection on a transient error)', async () => {
  const win = makeWindow({ cloud: [cloudRow('BILL-DELETED')], snapshotSales: [{ bill_id: 'BILL-DELETED', status: 'deleted' }] });
  const R = load(win);
  await R.loadLocalSalesHistoryForUI();
  assert.ok(R.getDeleted().has('BILL-DELETED'));
  win.electronAPI.getFinancialIntegritySnapshot = async () => { throw new Error('transient'); };
  const merged = R.mergeCloudSalesIntoLocal(await R.loadLocalSalesHistoryForUI());
  assert.deepStrictEqual(ids(merged), []);
});

check('no tombstones (plain browser / no SQLite) leaves cloud merging unchanged', async () => {
  const win = makeWindow({ cloud: [cloudRow('BILL-1'), cloudRow('BILL-2')] });
  delete win.electronAPI;
  const R = load(win);
  assert.deepStrictEqual(ids(R.mergeCloudSalesIntoLocal(await R.loadLocalSalesHistoryForUI())), ['BILL-1', 'BILL-2']);
});

(async () => {
  for (const t of pending) {
    try { await t.fn(); console.log('  PASS  ' + t.name); passed++; }
    catch (e) { console.log('  FAIL  ' + t.name + ' — ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
