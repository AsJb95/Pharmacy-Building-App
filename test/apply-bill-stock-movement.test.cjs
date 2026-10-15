#!/usr/bin/env node
// Dependency-free contract for supabase/migrations/20261015000100_v3193_apply_bill_stock_movement.sql.
// Its behaviour is proven against real PostgreSQL 17 by test/apply-bill-stock-movement.pg.mjs
// (needs a disposable localhost database); this file pins the guarantees for the ordinary suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); console.log('  PASS  ' + name); passed++; } catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; } };
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261015000100_v3193_apply_bill_stock_movement.sql'), 'utf8');
const body = sql.slice(sql.indexOf('as $$'), sql.lastIndexOf('$$;'));
const outside = sql.replace(body, '').replace(/--[^\n]*/g, '');

check('deployment is additive and re-runnable: only create or replace + owner + grants outside the body', () => {
  assert.match(sql, /create or replace function public\.apply_bill_stock_movement\(payload jsonb\)/);
  assert.doesNotMatch(outside, /\b(insert|update|delete|truncate|alter table|drop)\b/i, 'no data or schema change at deploy time');
  assert.doesNotMatch(sql, /reconcile_stock_movement\(payload jsonb\)\s*\n?\s*returns/i, 'legacy function is not redefined');
});
check('security definer, fixed search_path, writer gate, grants (no anon)', () => {
  assert.match(sql, /security definer/); assert.match(sql, /set search_path = public/);
  assert.match(body, /is_pharmacy_writer\(\)/);
  assert.match(sql, /revoke all on function public\.apply_bill_stock_movement\(jsonb\) from public, anon/);
  assert.match(sql, /grant execute on function public\.apply_bill_stock_movement\(jsonb\) to authenticated, service_role/);
});
check('batch row locked before the idempotency check and the mutation', () => {
  const lockAt = body.indexOf('for update');
  const keyAt = body.indexOf('where movement_key = v_key');
  const updAt = body.indexOf('update public.stock_batches');
  assert.ok(lockAt > 0 && keyAt > lockAt && updAt > keyAt);
});
check('existing movement: same -> ALREADY_APPLIED, different -> CONFLICT_MOVEMENT_MISMATCH', () => {
  assert.match(body, /'CONFLICT_MOVEMENT_MISMATCH'/);
  assert.match(body, /v_existing\.bill_id is distinct from v_bill_id/);
  assert.match(body, /abs\(coalesce\(v_existing\.qty, 0\) - v_delta\)/);
  assert.match(body, /'ALREADY_APPLIED'/);
});
check('delta applied to the CURRENT quantity; the counter opening is informational (drift, not conflict)', () => {
  assert.match(body, /v_opening := v_batch\.qty/);
  assert.match(body, /v_closing := v_opening \+ v_delta/);
  assert.doesNotMatch(body, /abs\(v_batch\.qty - v_expected\) > 0\.0005\) then\s*return/, 'no compare-and-set on the opening');
  assert.match(body, /'drift', v_drift/);
});
check('genuine conflicts are returned without mutation (insufficient stock, batch missing/ambiguous/identity)', () => {
  for (const s of ['CONFLICT_INSUFFICIENT_STOCK', 'CONFLICT_BATCH_NOT_FOUND', 'CONFLICT_BATCH_AMBIGUOUS', 'CONFLICT_BATCH_IDENTITY']) assert.match(body, new RegExp(`'${s}'`));
  assert.ok(body.indexOf("'CONFLICT_INSUFFICIENT_STOCK'") < body.indexOf('update public.stock_batches'));
});
check('stock update and movement insert are one atomic block with a unique_violation race guard', () => {
  const blk = body.slice(body.indexOf('  begin\n    update public.stock_batches'), body.indexOf('end;\n\n  return jsonb_build_object(\'status\', \'APPLIED\''));
  assert.match(blk, /update public\.stock_batches set qty = v_closing/);
  assert.match(blk, /insert into public\.stock_movements/);
  assert.match(blk, /exception when unique_violation then/);
});
check('BILL only, negative delta only', () => {
  assert.match(body, /Only BILL stock application is supported/);
  assert.match(body, /quantity_delta must be negative for a BILL movement/);
});
check('worker prefers the delta RPC and falls back to the legacy reconcile only when it is missing', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  assert.match(worker, /applyBillStockMovementStrict\(payload\)/);
  assert.match(worker, /=== 'RPC_MISSING'/);
  assert.match(worker, /reconcileStockMovementStrict\(payload\)/);
  for (const f of ['cloud-src/vhc-cloud-sync.js', 'dist/assets/vhc-cloud-sync.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /rpc\(["']apply_bill_stock_movement["']/, f);
    assert.match(src, /applyBillStockMovementStrict: applyBillStockMovement/, f);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
