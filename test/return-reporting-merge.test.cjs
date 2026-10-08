#!/usr/bin/env node
// Focused tests for the Returns & Refunds reporting merge (v3.18.3).
//
// The report must count BOTH local SQLite returns (bills billed on this device) and cloud
// public.sale_returns (returns taken against history-only cloud bills, which have no local sale
// row). The merge replicated here mirrors the effect in dist/assets/index-doBKNLAj.js exactly;
// the last test asserts the shipped bundle still contains that logic.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); console.log('  PASS  ' + name); pass++; } catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); fail++; } };

// ── mirror of the renderer's normalize + merge ────────────────────────────────────────────
const normalizeLocal = (row) => ({
  id: String(row.id ?? ''), bill_id: row.bill_id, created_at: row.created_at,
  return_amount: Number(row.return_amount || 0), refund_amount: Number(row.refund_amount || 0),
  credit_amount: Number(row.credit_amount || 0), patient_name: row.patient_name || '',
  items: row.items || '', source: 'local',
});
const normalizeCloud = (row) => ({
  id: String(row.id ?? ''), bill_id: row.original_bill_id || row.bill_id, created_at: row.created_at,
  return_amount: Number(row.return_amount || 0), refund_amount: Number(row.refund_amount || 0),
  credit_amount: Number(row.credit_amount || 0),
  patient_name: (row.sales && row.sales.patient_name) || '',
  items: Array.isArray(row.sale_return_items)
    ? row.sale_return_items.map((l) => `${Number(l.quantity || 0)} x ${(l.sale_items && l.sale_items.drug_name) || 'Item'}`).join(', ')
    : '',
  source: 'cloud',
});
function merge(localRows, cloudRows) {
  const local = (localRows || []).map(normalizeLocal);
  const cloud = (cloudRows || []).map(normalizeCloud);
  const byId = new Map();
  for (const row of local) { const k = row.id.trim().toLowerCase(); if (k) byId.set(k, row); }
  for (const row of cloud) { const k = row.id.trim().toLowerCase(); if (k && !byId.has(k)) byId.set(k, row); }
  return [...byId.values()].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}
// what the Returns & Balance card computes from returnRecords
const summary = (rows) => ({
  returnBillCount: rows.length,
  returnAmount: rows.reduce((s, r) => s + Number(r.return_amount || 0), 0),
  refundedAmount: rows.reduce((s, r) => s + Number(r.refund_amount || 0), 0),
  creditAmount: rows.reduce((s, r) => s + Number(r.credit_amount || 0), 0),
});

// ── fixtures ──────────────────────────────────────────────────────────────────────────────
const LOCAL_A = { id: 'RET-1700000000000-abc123', bill_id: 'BILL-LOCAL-1', created_at: '2026-10-06T10:00:00Z', return_amount: 10, refund_amount: 10, credit_amount: 0, patient_name: 'Walk-in', items: '1 x Amoxicillin' };
const CLOUD_CASH_1 = { id: 'aa000000-0000-4000-8000-000000000001', original_bill_id: 'CLOUD-CASH-1', created_at: '2026-10-06T11:00:00Z', return_amount: 30, refund_amount: 30, credit_amount: 0, status: 'COMPLETED', sales: { patient_name: 'Cloud Patient' }, sale_return_items: [{ quantity: 3, sale_items: { drug_name: 'Amoxicillin 500mg' } }] };
const CLOUD_CASH_2 = { id: 'aa000000-0000-4000-8000-000000000002', original_bill_id: 'CLOUD-CASH-1', created_at: '2026-10-06T12:00:00Z', return_amount: 20, refund_amount: 20, credit_amount: 0, status: 'COMPLETED', sales: { patient_name: 'Cloud Patient' }, sale_return_items: [{ quantity: 2, sale_items: { drug_name: 'Amoxicillin 500mg' } }] };
const CLOUD_CREDIT = { id: 'aa000000-0000-4000-8000-000000000003', original_bill_id: 'CLOUD-CREDIT-1', created_at: '2026-10-06T13:00:00Z', return_amount: 40, refund_amount: 0, credit_amount: 40, status: 'COMPLETED', sales: { patient_name: 'Cloud Patient' }, sale_return_items: [{ quantity: 4, sale_items: { drug_name: 'Amoxicillin 500mg' } }] };

console.log('=== 1. cloud-only return appears in the report ===');
check('A1 a cloud-only return is included', () => {
  const rows = merge([], [CLOUD_CASH_1]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].bill_id, 'CLOUD-CASH-1');
  assert.strictEqual(rows[0].source, 'cloud');
});
check('A2 cloud row is normalized to the local report model the list renders', () => {
  const r = merge([], [CLOUD_CASH_1])[0];
  assert.strictEqual(r.patient_name, 'Cloud Patient');
  assert.strictEqual(r.items, '3 x Amoxicillin 500mg');
  assert.strictEqual(r.return_amount, 30);
  assert.strictEqual(r.refund_amount, 30);
  assert.strictEqual(r.credit_amount, 0);
  for (const k of ['id', 'bill_id', 'created_at', 'return_amount', 'refund_amount', 'credit_amount', 'patient_name', 'items']) {
    assert.ok(k in r, 'missing field ' + k);
  }
});
check('A3 cloud credit return carries its credit adjustment', () => {
  const r = merge([], [CLOUD_CREDIT])[0];
  assert.strictEqual(r.credit_amount, 40);
  assert.strictEqual(r.refund_amount, 0);
  assert.strictEqual(r.return_amount, 40);
});

console.log('\n=== 2. local reporting preserved ===');
check('B1 a local-only return still appears unchanged', () => {
  const rows = merge([LOCAL_A], []);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'local');
  assert.strictEqual(rows[0].bill_id, 'BILL-LOCAL-1');
  assert.strictEqual(rows[0].items, '1 x Amoxicillin');
  assert.strictEqual(rows[0].refund_amount, 10);
});
check('B2 offline (cloud unavailable => empty) still reports local returns normally', () => {
  const rows = merge([LOCAL_A], []);
  assert.deepStrictEqual(summary(rows), { returnBillCount: 1, returnAmount: 10, refundedAmount: 10, creditAmount: 0 });
});
check('B3 no returns anywhere yields an empty report, not a crash', () => {
  assert.deepStrictEqual(merge([], []), []);
  assert.deepStrictEqual(summary(merge([], [])), { returnBillCount: 0, returnAmount: 0, refundedAmount: 0, creditAmount: 0 });
});

console.log('\n=== 3. duplicate merge protection ===');
check('C1 the same return present locally AND in cloud is shown once', () => {
  const sameAsLocal = { id: LOCAL_A.id, original_bill_id: 'BILL-LOCAL-1', created_at: LOCAL_A.created_at, return_amount: 10, refund_amount: 10, credit_amount: 0, sales: { patient_name: 'Walk-in' }, sale_return_items: [{ quantity: 1, sale_items: { drug_name: 'Amoxicillin' } }] };
  const rows = merge([LOCAL_A], [sameAsLocal]);
  assert.strictEqual(rows.length, 1, 'must not be duplicated');
  assert.strictEqual(rows[0].source, 'local', 'local row wins');
  assert.deepStrictEqual(summary(rows), { returnBillCount: 1, returnAmount: 10, refundedAmount: 10, creditAmount: 0 });
});
check('C2 dedupe is case/whitespace tolerant on the return id', () => {
  const noisy = { id: '  ' + LOCAL_A.id.toUpperCase() + '  ', original_bill_id: 'BILL-LOCAL-1', created_at: LOCAL_A.created_at, return_amount: 10, refund_amount: 10, credit_amount: 0 };
  assert.strictEqual(merge([LOCAL_A], [noisy]).length, 1);
});
check('C3 a row with no id is dropped rather than collapsing other rows', () => {
  const rows = merge([], [{ id: '', original_bill_id: 'X', created_at: '2026-10-06T09:00:00Z', return_amount: 5 }, CLOUD_CASH_1]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].bill_id, 'CLOUD-CASH-1');
});

console.log('\n=== 4. multiple partial returns on the same bill ===');
check('D1 two partial returns on one bill remain two separate rows', () => {
  const rows = merge([], [CLOUD_CASH_1, CLOUD_CASH_2]);
  assert.strictEqual(rows.length, 2, 'must NOT be deduped by bill_id');
  assert.deepStrictEqual(rows.map((r) => r.bill_id), ['CLOUD-CASH-1', 'CLOUD-CASH-1']);
  assert.deepStrictEqual(rows.map((r) => r.return_amount).sort((a, b) => a - b), [20, 30]);
});
check('D2 their amounts add up rather than collapsing to one', () => {
  assert.deepStrictEqual(summary(merge([], [CLOUD_CASH_1, CLOUD_CASH_2])),
    { returnBillCount: 2, returnAmount: 50, refundedAmount: 50, creditAmount: 0 });
});
check('D3 local + cloud partials on the same bill all survive', () => {
  const localSameBill = { id: 'RET-local-same-bill', bill_id: 'CLOUD-CASH-1', created_at: '2026-10-06T14:00:00Z', return_amount: 5, refund_amount: 5, credit_amount: 0, patient_name: 'Cloud Patient', items: '1 x Amoxicillin 500mg' };
  const rows = merge([localSameBill], [CLOUD_CASH_1, CLOUD_CASH_2]);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(summary(rows).returnAmount, 55);
});

console.log('\n=== 5. report totals are not double counted ===');
check('E1 mixed local + cloud totals are exact', () => {
  const rows = merge([LOCAL_A], [CLOUD_CASH_1, CLOUD_CASH_2, CLOUD_CREDIT]);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(summary(rows), { returnBillCount: 4, returnAmount: 100, refundedAmount: 60, creditAmount: 40 });
});
check('E2 re-running the merge is stable (idempotent, no growth)', () => {
  const a = merge([LOCAL_A], [CLOUD_CASH_1, CLOUD_CASH_2, CLOUD_CREDIT]);
  const b = merge([LOCAL_A], [CLOUD_CASH_1, CLOUD_CASH_2, CLOUD_CREDIT]);
  assert.deepStrictEqual(summary(a), summary(b));
  assert.strictEqual(a.length, b.length);
});
check('E3 duplicated cloud rows in one payload are collapsed', () => {
  const rows = merge([], [CLOUD_CASH_1, CLOUD_CASH_1, CLOUD_CASH_2]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(summary(rows).returnAmount, 50);
});
check('E4 newest return is listed first', () => {
  const rows = merge([LOCAL_A], [CLOUD_CASH_1, CLOUD_CASH_2, CLOUD_CREDIT]);
  const times = rows.map((r) => new Date(r.created_at).getTime());
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
});

console.log('\n=== 6. shipped bundles carry this logic ===');
check('F1 renderer merges local + cloud and dedupes by return id', () => {
  const b = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.ok(b.includes('window.VHC_CLOUD.getSaleReturnsForReports'), 'renderer must read cloud returns');
  assert.ok(b.includes('window.electronAPI.getSaleReturnsForReports'), 'renderer must still read local returns');
  assert.ok(/normalizeCloud/.test(b) && /normalizeLocal/.test(b), 'both normalizers must exist');
  assert.ok(/byId\.has\(key\)/.test(b), 'must dedupe by return id');
  assert.ok(!/dedupe by bill|byBill/.test(b), 'must not dedupe by bill');
});
check('F2 cloud layer exposes the COMPLETED-only reporting read in src and bundle', () => {
  for (const f of ['cloud-src/vhc-cloud-sync.js', 'dist/assets/vhc-cloud-sync.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(/async function getSaleReturnsForReports/.test(s), f + ' must define the reader');
    assert.ok(/sale_returns_original_sale_id_fkey/.test(s), f + ' must disambiguate the sales embed');
    assert.ok(/COMPLETED/.test(s), f + ' must filter to COMPLETED returns');
  }
});
check('F3 execution/stock/refund logic was not touched by this change', () => {
  const b = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.ok(b.includes('window.VHC_CLOUD.createSaleReturn'), 'cloud return execution intact');
  assert.ok(b.includes('createLocalSaleReturn'), 'local return execution intact');
  // The cloud-return RPC migration is NEXT-VERSION work (next-version/cloud-return-redesign/) and is
  // deliberately absent from v3.18.3, where cloud returns stay fail-closed (RPC_MISSING). Only check
  // it when a release actually carries it.
  const rpc = path.join(__dirname, '..', 'supabase', 'migrations', '20261006000200_v3183_create_sale_return_rpc.sql');
  if (fs.existsSync(rpc)) {
    assert.ok(/create or replace function public\.create_sale_return\(payload jsonb\)/.test(fs.readFileSync(rpc, 'utf8')), 'RPC unchanged');
  } else {
    assert.ok(b.includes('RPC_MISSING'), 'without the RPC migration the renderer must stay fail-closed');
  }
});

console.log('\n' + (fail === 0 ? 'ALL RETURN-REPORTING TESTS PASSED (' + pass + ')' : fail + ' FAILED / ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
