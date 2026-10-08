#!/usr/bin/env node
// Dependency-free contract test for migration 20261008000100 (v3.19.0) (create_sale_return +
// get_sale_return_eligibility, production-compatible stock reconstruction).
// Behaviour is proven by executing the real SQL in test/create-sale-return-rpc.pglite.mjs
// (real PostgreSQL via PGlite). This file locks the contract that migration must keep, so a
// later edit cannot quietly drop the authorization gate, the idempotency key, the
// partial-return check, the identity-safe stock insert or the credit-before-refund rule.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261008000100_v3190_cloud_sale_return_rpc.sql'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('declares the function with create or replace, jsonb in/out, and is re-runnable', () => {
  assert.match(sql, /create or replace function public\.create_sale_return\(payload jsonb\)\s+returns jsonb/i);
  assert.match(sql, /language plpgsql/i);
  assert.doesNotMatch(sql, /drop function public\.create_sale_return/i);
});

test('is SECURITY DEFINER with a pinned search_path and the same grant shape as reconcile_stock_movement', () => {
  assert.match(sql, /security definer\s+set search_path = public/i);
  assert.match(sql, /alter function public\.create_sale_return\(jsonb\) owner to postgres/i);
  assert.match(sql, /revoke all on function public\.create_sale_return\(jsonb\) from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.create_sale_return\(jsonb\) to authenticated, service_role/i);
});

test('gates every call on the existing is_pharmacy_writer()', () => {
  assert.match(sql, /if not coalesce\(public\.is_pharmacy_writer\(\), false\) then\s+raise exception 'Not authorized to record pharmacy returns'/i);
});

test('refuses to install unless the audit tables and movement_key already exist', () => {
  assert.match(sql, /to_regclass\('public\.sale_returns'\) is null/i);
  assert.match(sql, /to_regclass\('public\.sale_return_items'\) is null/i);
  assert.match(sql, /to_regclass\('public\.sale_refunds'\) is null/i);
  assert.match(sql, /to_regclass\('public\.sale_return_credits'\) is null/i);
  assert.match(sql, /to_regprocedure\('public\.is_pharmacy_writer\(\)'\) is null/i);
  assert.match(sql, /column_name = 'movement_key'[\s\S]*?raise exception/i);
});

test('is idempotent on a client-supplied return_id and reports ALREADY_APPLIED without writing', () => {
  assert.match(sql, /v_return_id\s*:=\s*nullif\(payload->>'return_id', ''\)::uuid/i);
  assert.match(sql, /select \* into v_existing from public\.sale_returns where id = v_return_id/i);
  assert.match(sql, /'status', 'ALREADY_APPLIED'/i);
  // The replay branch returns before any INSERT/UPDATE in the function body.
  const replayIdx = sql.indexOf("'ALREADY_APPLIED'");
  const firstInsert = sql.search(/insert into public\.sale_returns/i);
  assert.ok(replayIdx > 0 && firstInsert > replayIdx, 'the replay return must precede any write');
});

test('serialises on the original sale row before the replay check so concurrent callers cannot race', () => {
  const lockIdx = sql.search(/select \* into v_sale from public\.sales where bill_id = v_bill_id for update/i);
  const replayIdx = sql.search(/select \* into v_existing from public\.sale_returns where id = v_return_id/i);
  assert.ok(lockIdx > 0 && replayIdx > lockIdx, 'the sale row lock must be taken before the replay check');
});

test('rejects a return_id already used by a different bill', () => {
  assert.match(sql, /if v_existing\.original_bill_id <> v_bill_id then\s+raise exception 'return_id % is already used by bill %'/i);
});

test('binds lines through the original sale and preserves bill identity', () => {
  assert.match(sql, /from public\.sale_items\s+where id = nullif\(v_line->>'sale_item_id', ''\)::uuid and sale_id = v_sale\.id/i);
  assert.match(sql, /raise exception 'Return line does not belong to bill %'/i);
  assert.match(sql, /insert into public\.sale_returns \([\s\S]*?original_sale_id, original_bill_id/i);
  assert.match(sql, /v_return_id, v_sale\.id, v_sale\.bill_id/i);
});

test('never deletes, recreates or rewrites the original sale or its items', () => {
  assert.doesNotMatch(sql, /delete from public\.sales/i);
  assert.doesNotMatch(sql, /delete from public\.sale_items/i);
  assert.doesNotMatch(sql, /update public\.sales\b/i);
  assert.doesNotMatch(sql, /update public\.sale_items\b/i);
  assert.doesNotMatch(sql, /insert into public\.sales\b/i);
  assert.doesNotMatch(sql, /insert into public\.sale_items\b/i);
});

test('enforces the remaining-returnable-quantity limit across COMPLETED returns', () => {
  assert.match(sql, /select coalesce\(sum\(sri\.quantity\), 0\) into v_already[\s\S]*?from public\.sale_return_items sri[\s\S]*?join public\.sale_returns sr on sr\.id = sri\.return_id[\s\S]*?where sri\.original_sale_item_id = v_item\.id[\s\S]*?and sr\.status = 'COMPLETED'/i);
  assert.match(sql, /if v_already \+ v_qty > least\(v_item\.quantity, v_alloc\.deducted\) \+ 0\.0005 then\s+raise exception 'Return quantity exceeds remaining sold quantity/i);
});

test('rejects a sale item repeated inside one payload so quantity cannot be smuggled past the limit', () => {
  assert.match(sql, /select count\(distinct e->>'sale_item_id'\) into v_distinct/i);
  assert.match(sql, /raise exception 'Each sale item may appear only once per return'/i);
});

test('restores stock under a deterministic per-allocation movement_key and adopts an existing movement instead of re-restoring', () => {
  assert.match(sql, /v_key := 'VHC:RETURN:' \|\| v_return_id::text \|\| ':' \|\| v_item\.id::text \|\| ':' \|\| \(v_p->>'source_movement_id'\)/i);
  assert.match(sql, /select \* into v_movement from public\.stock_movements where movement_key = v_key/i);
  assert.match(sql, /if found then\s+v_movement_id := v_movement\.id/i);
  assert.match(sql, /update public\.stock_batches\s+set qty = v_closing, updated_at = now\(\)/i);
  assert.match(sql, /type, qty,\s*opening, closing, bill_id, patient_id, reason/i);
  assert.match(sql, /'RETURN', v_qty,/i);
});

test('reconstructs stock from the original BILL movement, never from affects_stock / stock_batch_id', () => {
  // Production cloud lines are record-only; gating on these columns made every line non-restorable.
  assert.doesNotMatch(sql, /v_item\.affects_stock/i);
  assert.doesNotMatch(sql, /v_item\.stock_batch_id/i);
  assert.match(sql, /select \* into v_alloc from public\.vhc_return_line_allocation\(v_sale\.id, v_item\.id\)/i);
  assert.match(sql, /where m\.type = 'BILL' and m\.bill_id = v_bill and m\.item_id = v_item\.item_id\s+and lower\(btrim\(coalesce\(m\.batch_no, ''\)\)\) = v_key/i);
  assert.match(sql, /if \(-v_mv\.qty\) <> v_item\.quantity then\s+status := 'QTY_MISMATCH'/i);
  assert.match(sql, /status := 'BATCH_GONE'/i);
  assert.match(sql, /status := 'NO_STOCK_HISTORY'/i);
  assert.match(sql, /status := 'NON_STOCK'/i);
  assert.match(sql, /status := 'AMBIGUOUS'/i);
  // the blank/N-A fallback requires exactly one movement AND exactly one line for the item
  assert.match(sql, /if v_key not in \('', 'n\/a', 'na', '-'\) then/i);
  assert.match(sql, /if v_any <> 1 or v_lines <> 1 then\s+status := 'AMBIGUOUS'/i);
  // restores only SALEABLE quantity, into the batch locked FOR UPDATE
  assert.match(sql, /v_restore\s*:=\s*v_disposition = 'SALEABLE'/i);
  assert.match(sql, /select \* into v_batch from public\.stock_batches where id = \(v_p->>'stock_batch_id'\)::uuid for update/i);
});

test('validates every line before the first write; any unreconstructable line refuses the whole return', () => {
  assert.match(sql, /if v_alloc\.status <> 'RETURNABLE' then\s+raise exception 'RETURN_REFUSED\[%\] %: %'/i);
  const refuse = sql.search(/raise exception 'RETURN_REFUSED\[%\]/i);
  const firstWrite = sql.search(/insert into public\.sale_returns/i);
  assert.ok(refuse > 0 && firstWrite > refuse, 'refusals must precede the first write');
});

test('records a real RETURN movement and widens the type constraint explicitly (never disguised as RESTORE)', () => {
  assert.doesNotMatch(sql, /'RESTORE', v_qty/i);
  assert.match(sql, /do \$widen\$/i);
  assert.match(sql, /conname = 'stock_movements_type_check'/i);
  assert.match(sql, /raise exception 'Unexpected stock_movements_type_check shape, refusing to rewrite: %'/i);
  assert.match(sql, /v_vals := v_vals \|\| array\['RETURN'\]/i);
  assert.match(sql, /drop constraint stock_movements_type_check, '\s*'add constraint stock_movements_type_check check \(type = any \(array\[%s\]::text\[\]\)\)'/i);
  assert.match(sql, /stock_movements_type_check still rejects RETURN/i);
});

test('never supplies stock_movements.seq, so a production identity column keeps allocating', () => {
  const insert = sql.slice(sql.search(/insert into public\.stock_movements/i));
  const cols = insert.slice(insert.indexOf('('), insert.indexOf(')'));
  assert.ok(!/\bseq\b/.test(cols), 'seq must not be in the stock_movements insert column list');
  assert.match(sql, /GENERATED ALWAYS AS IDENTITY seq\s*\n--\s*allocates itself|identity seq\s*\n\s*--\s*allocates itself|GENERATED ALWAYS AS IDENTITY/i);
});

test('credit absorbs outstanding before any refund, and a caller hint can only lower it', () => {
  assert.match(sql, /v_outstanding := public\.vhc_sale_recorded_outstanding\(v_sale\.id\)/i);
  assert.match(sql, /when s\.outstanding_amount is not null then greatest\(0, s\.outstanding_amount\)/i);
  assert.match(sql, /when lower\(coalesce\(s\.payment_mode, ''\)\) = 'credit' then greatest\(0, coalesce\(s\.total_amount, 0\)\)/i);
  assert.match(sql, /when lower\(coalesce\(s\.payment_mode, ''\)\) = 'split' then null/i);
  assert.match(sql, /if v_outstanding is null then\s+raise exception 'RETURN_REFUSED\[PAYMENT_STATE_UNKNOWN\]/i);
  assert.match(sql, /v_hint := nullif\(payload->>'outstanding_amount', ''\)::numeric/i);
  assert.match(sql, /v_outstanding := least\(v_outstanding, greatest\(0, v_hint\)\)/i);
  assert.match(sql, /v_credit\s*:=\s*round\(least\(v_total, v_outstanding\), 2\)/i);
  assert.match(sql, /v_refund\s*:=\s*round\(greatest\(0, v_total - v_credit\), 2\)/i);
});

test('discounts credit already consumed by earlier returns on the same bill', () => {
  assert.match(sql, /select coalesce\(sum\(sr\.credit_amount\), 0\) into v_consumed[\s\S]*?where sr\.original_sale_id = v_sale\.id[\s\S]*?and sr\.status = 'COMPLETED'[\s\S]*?and sr\.id <> v_return_id/i);
  assert.match(sql, /v_outstanding := greatest\(0, v_outstanding - v_consumed\)/i);
});

test('writes the refund audit row only for a real refund and only with an allowed method', () => {
  assert.match(sql, /if v_refund > 0 then\s+insert into public\.sale_refunds \(return_id, amount, method, reference, status, recorded_by\)/i);
  assert.match(sql, /if v_method not in \('Cash', 'UPI', 'Card', 'Other'\) then\s+raise exception 'Unsupported refund_method %'/i);
  assert.match(sql, /when 'upi'\s+then 'UPI'/i);
  assert.match(sql, /when 'card' then 'Card'/i);
});

test('writes the credit audit row only when credit was actually applied', () => {
  assert.match(sql, /if v_credit > 0 then\s+insert into public\.sale_return_credits \(return_id, applied_sale_id, amount\)/i);
});

test('does not depend on sales.deleted_at / cancelled_at (absent in production); a missing sale row refuses', () => {
  assert.doesNotMatch(sql, /deleted_at is not null|cancelled_at is not null|v_sale\.deleted_at|v_sale\.cancelled_at/i);
  assert.match(sql, /if not found then\s+raise exception 'Original sale for bill % was not found'/i);
});

test('has no exception handler that could let partial work survive (atomicity)', () => {
  // A plpgsql body is one transaction; an EXCEPTION block would create a subtransaction that
  // could swallow a failure and commit a half-written return.
  assert.doesNotMatch(sql.slice(sql.indexOf('$fn$'), sql.lastIndexOf('$fn$')), /\bexception\s+when\b/i);
  assert.doesNotMatch(sql, /\bcommit\b|\brollback\b/i);
});

test('validates quantity, disposition and return_type', () => {
  assert.match(sql, /if v_qty is null or v_qty <= 0 then\s+raise exception 'Each return line requires a positive quantity'/i);
  assert.match(sql, /if v_disposition not in \('SALEABLE', 'DAMAGED', 'NON_SALEABLE'\) then/i);
  assert.match(sql, /if v_return_type not in \('RETURN', 'EXCHANGE'\) then/i);
  assert.match(sql, /raise exception 'At least one return line is required'/i);
});

test('self-verifies security, search_path and grants at install time', () => {
  assert.match(sql, /if not coalesce\(v_secdef, false\) then raise exception '% must be SECURITY DEFINER'/i);
  assert.match(sql, /raise exception '% must pin search_path=public'/i);
  assert.match(sql, /array\['authenticated','postgres','service_role'\]::text\[\]/i);
  assert.match(sql, /'public\.vhc_return_line_allocation\(uuid,uuid\)', 'public\.vhc_sale_recorded_outstanding\(uuid\)', 'public\.create_sale_return\(jsonb\)', 'public\.get_sale_return_eligibility\(text\)'/i);
});

test('internal helpers are owner-only; eligibility is gated and granted like the RPC', () => {
  assert.match(sql, /revoke all on function public\.vhc_return_line_allocation\(uuid, uuid\) from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on function public\.vhc_sale_recorded_outstanding\(uuid\) from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.vhc_/i);
  assert.match(sql, /'% must be owner-only, got %'/i);
  assert.match(sql, /grant execute on function public\.get_sale_return_eligibility\(text\) to authenticated, service_role/i);
  assert.match(sql, /\$elig\$[\s\S]*?if not coalesce\(public\.is_pharmacy_writer\(\), false\) then\s+raise exception 'Not authorized to read pharmacy returns'/i);
  assert.match(sql, /create or replace function public\.get_sale_return_eligibility\(p_bill_id text\)\s+returns jsonb\s+language plpgsql\s+stable/i);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); }
  catch (e) { failed++; console.log('  FAIL  ' + t.name + ' — ' + e.message); }
}
console.log('\n' + (failed === 0 ? 'ALL CONTRACT TESTS PASSED (' + tests.length + ')' : failed + ' FAILED / ' + (tests.length - failed) + ' passed'));
process.exit(failed === 0 ? 0 : 1);
