#!/usr/bin/env node
// Dependency-free contract for supabase/migrations/20261022000100_stock_correction_rpcs.sql.
// Behaviour is proven against real PostgreSQL by test/stock-correction-rpcs.pg.mjs (disposable localhost DB);
// this file pins the guarantees for the ordinary suite.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); console.log('  PASS  ' + name); passed++; } catch (e) { console.log('  FAIL  ' + name + ' — ' + e.message); failed++; } };
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261022000100_stock_correction_rpcs.sql'), 'utf8');
const fn = (name) => {
  const a = sql.indexOf(`create or replace function public.${name}(`);
  const b = sql.indexOf('$$;', sql.indexOf('as $$', a));
  return sql.slice(a, b);
};
const edit = fn('apply_stock_correction'), restore = fn('apply_stock_restore'), transfer = fn('accept_pharmacy_transfer');
const rule = fn('vhc_transfer_dest_qty');
const bodies = [fn('vhc_manual_stock_reason_ok'), rule, edit, restore, transfer];
let outside = sql; for (const b of bodies) outside = outside.replace(b, ''); outside = outside.replace(/--[^\n]*/g, '');

check('additive and re-runnable: only create or replace + owner + grants outside function bodies', () => {
  assert.doesNotMatch(outside, /\b(insert|update|delete|truncate|alter table|drop|create table|create index)\b/i);
  assert.doesNotMatch(sql, /function public\.(apply_bill_stock_movement|reconcile_stock_movement)\s*\(/, 'BILL / legacy functions are not redefined');
});
check('all three: SECURITY INVOKER (caller RLS decides, as for the direct writes they replace), fixed search_path', () => {
  assert.doesNotMatch(sql, /security definer/i); assert.doesNotMatch(sql, /owner to/i);
  for (const b of [edit, restore, transfer]) { assert.match(b, /security invoker/); assert.match(b, /set search_path = public/); }
  for (const b of [edit, restore]) assert.match(b, /v_loc_type is distinct from 'pharmacy_counter'/);
});
check('every UPDATE is row-count checked (RLS can silently match 0 rows)', () => {
  assert.equal((edit.match(/get diagnostics v_rows = row_count;/g) || []).length, 1);
  assert.equal((restore.match(/get diagnostics v_rows = row_count;/g) || []).length, 1);
  assert.equal((transfer.match(/get diagnostics v_rows = row_count;/g) || []).length, 3);
  for (const b of [edit, restore, transfer]) assert.equal((b.match(/\bupdate public\./g) || []).length, (b.match(/get diagnostics v_rows/g) || []).length);
});
check('TRANSFER: per-pharmacy-batch advisory lock taken before any batch is read', () => {
  const adv = transfer.indexOf('pg_advisory_xact_lock'), firstRead = transfer.indexOf('from public.transfer_order_items l');
  assert.ok(adv > 0 && adv < firstRead);
});
check('actor comes from auth.uid() only and is required; payload never supplies created_by', () => {
  for (const b of [edit, restore, transfer]) {
    assert.match(b, /v_actor uuid := auth\.uid\(\)/); assert.match(b, /if v_actor is null then/);
    assert.doesNotMatch(b, /payload->>'created_by'/);
  }
});
check('EDIT: lock, then idempotency, then stale check, then the single write block', () => {
  const lock = edit.indexOf('for update'), keyAt = edit.indexOf('where movement_key = v_key'), stale = edit.indexOf("'CONFLICT_STALE_OPENING'"), upd = edit.indexOf('update public.stock_batches');
  assert.ok(lock > 0 && keyAt > lock && stale > keyAt && upd > stale);
  assert.match(edit, /v_key := 'VHC:EDIT:' \|\| v_request/);
  assert.match(edit, /'CONFLICT_REQUEST_KEY_REUSED'/); assert.match(edit, /'ALREADY_APPLIED'/);
  assert.match(edit, /exception\s+when unique_violation/);
});
check('RESTORE: positive delta only, keyed by bill + batch, mismatch detected', () => {
  assert.match(restore, /v_delta <= 0 then/);
  assert.match(restore, /v_key := 'VHC:RESTORE:' \|\| v_bill_id \|\| ':' \|\| v_batch_id::text/);
  assert.match(restore, /'CONFLICT_MOVEMENT_MISMATCH'/);
});
check('TRANSFER: order locked, Pending required, validation before any write, per-line OUT/IN keys', () => {
  const lock = transfer.indexOf('from public.transfer_orders where id = v_id for update');
  const firstWrite = transfer.indexOf("update public.transfer_orders set status = 'Completed'");
  const lastCheck = transfer.lastIndexOf("'CONFLICT_");
  assert.ok(lock > 0 && lastCheck > lock && firstWrite > lastCheck, 'all CONFLICT returns happen before the first write');
  assert.match(transfer, /'ALREADY_COMPLETED'/);
  assert.match(transfer, /':OUT'/); assert.match(transfer, /':IN'/);
});
check('reasons: generic placeholders rejected, trimmed and length-bounded', () => {
  assert.match(sql, /btrim\(lower\(regexp_replace\(p_reason/);
  for (const w of ["'update'", "'edit'", "'stock update'", "'correction'", "'n a'"]) assert.ok(sql.includes(w), w);
  assert.match(edit, /vhc_manual_stock_reason_ok\(v_reason\)/); assert.match(restore, /vhc_manual_stock_reason_ok\(v_reason\)/);
});
check('grants: authenticated + service_role; never anon/public', () => {
  for (const f of ['apply_stock_correction', 'apply_stock_restore', 'accept_pharmacy_transfer', 'vhc_manual_stock_reason_ok', 'vhc_transfer_dest_qty']) {
    const sig = f === 'vhc_manual_stock_reason_ok' ? `${f}(text)` : f === 'vhc_transfer_dest_qty' ? `${f}(numeric, text, numeric)` : `${f}(jsonb)`;
    assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon;`), 'revoke ' + f);
    assert.ok(sql.includes(`grant execute on function public.${sig} to authenticated, service_role;`), 'grant ' + f);
  }
});
check('NOT_PERMITTED: permission failures are reported, never disguised as not-found, and roll the write block back', () => {
  for (const b of [edit, restore]) {
    assert.match(b, /if exists \(select 1 from public\.stock_batches where id = v_batch_id\) then\s+return jsonb_build_object\('status', 'NOT_PERMITTED'/);
    assert.match(b, /when insufficient_privilege then\s+(--[^\n]*\n\s+)?return jsonb_build_object\('status', 'NOT_PERMITTED'/);
  }
  assert.match(transfer, /v_locked := found;/);
  assert.match(transfer, /if not v_locked then\s+return jsonb_build_object\('status', 'NOT_PERMITTED'/);
  assert.match(transfer, /exception when insufficient_privilege then/);
  // every "not permitted" row-count raise carries the errcode the handlers catch
  const raises = sql.match(/raise exception '[^']*not permitted[^']*'[^;]*;/g) || [];
  assert.equal(raises.length, 5);
  for (const r of raises) assert.match(r, /using errcode = 'insufficient_privilege'/);
});
// Production columns, read-only from yrgtnhvnwkqudxdcrkhm information_schema on 2026-10-22.
const PROD_COLUMNS = {
  stock_batches: 'id item_id location_id batch_no expiry_date mrp net_rate gst stockist qty updated_at',
  stock_movements: 'id seq item_id location_id batch_no type qty opening closing bill_id patient_id reason created_by created_at movement_key',
  transfer_orders: 'id transfer_number from_location_id to_location_id status created_at transfer_date notes',
  transfer_order_items: 'id transfer_order_id item_id name batch_no expiry_date mrp net_rate qty units_per_pack transfer_unit',
  locations: 'id name type color created_at',
};
const cols = Object.fromEntries(Object.entries(PROD_COLUMNS).map(([k, v]) => [k, new Set(v.split(' '))]));
check('every column the migration names exists in PRODUCTION (no created_at on stock_batches, no patient_name, seq left to identity)', () => {
  const body = sql.replace(/--[^\n]*/g, '');
  const bad = [];
  for (const m of body.matchAll(/insert into public\.(\w+)\s*\(([^)]*)\)/g))
    for (const c of m[2].split(',').map((s) => s.trim())) if (!cols[m[1]].has(c)) bad.push(`insert ${m[1]}.${c}`);
  for (const m of body.matchAll(/update public\.(\w+) set ([^;]*?) where/g))
    for (const c of m[2].split(',').map((s) => s.trim().split(/\s*=/)[0])) if (!cols[m[1]].has(c)) bad.push(`update ${m[1]}.${c}`);
  const recs = { v_batch: 'stock_batches', v_src: 'stock_batches', v_dst: 'stock_batches', v_existing: 'stock_movements', v_t: 'transfer_orders', v_line: 'transfer_order_items' };
  for (const [v, tbl] of Object.entries(recs))
    for (const m of body.matchAll(new RegExp('\\b' + v + '\\.(\\w+)', 'g'))) if (!cols[tbl].has(m[1])) bad.push(`${v}.${m[1]} (${tbl})`);
  for (const m of body.matchAll(/\bfrom public\.(\w+)(?:\s+\w+)?\s+where\s+([^;]*?)(?:for update|order by|limit|;|\))/g))
    for (const c of m[2].matchAll(/\b([a-z_]+)\s*(?:=|is |<>|>|<|like)/g)) if (cols[m[1]] && !cols[m[1]].has(c[1]) && !/^v_|^and$|^or$/.test(c[1])) bad.push(`where ${m[1]}.${c[1]}`);
  assert.deepEqual(bad, []);
  assert.doesNotMatch(body, /\bseq\b/, 'seq is assigned by the database (identity in production, trigger in TEST)');
  assert.doesNotMatch(body, /patient_name/);
});
check('TRANSFER units: Mobile rule (legacy 1:1 / strips|units x pack / else refuse), validated before any write, IN side uses the converted qty', () => {
  assert.match(rule, /when p_transfer_unit is null and p_units_per_pack is null then p_qty/);
  assert.match(rule, /when p_transfer_unit in \('strips', 'units'\) and p_units_per_pack > 0/);
  assert.match(rule, /then p_qty \* p_units_per_pack/);
  assert.match(rule, /else null/);
  assert.match(rule, /immutable/);
  const check = transfer.indexOf("'CONFLICT_TRANSFER_UNIT'"), firstWrite = transfer.indexOf("update public.transfer_orders set status = 'Completed'");
  assert.ok(check > 0 && check < firstWrite, 'unit validation happens in Phase 1, before the first write');
  assert.equal((transfer.match(/v_dest := public\.vhc_transfer_dest_qty\(v_line\.qty, v_unit, v_upp\)/g) || []).length, 1);
  assert.match(transfer, /set qty = qty \+ v_dest/);
  assert.match(transfer, /'TRANSFER', v_dest,\s+v_dst\.qty, v_dst\.qty \+ v_dest/);
  assert.match(transfer, /'TRANSFER', v_dest,\s+0, v_dest/);
  assert.match(transfer, /set qty = qty - v_line\.qty/, 'Main Stock is still debited in strips (source native unit)');
  assert.doesNotMatch(transfer, /qty \+ v_line\.qty/, 'the pharmacy side never adds the raw strip count');
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
