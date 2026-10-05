#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migration1 = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260927000100_v3182_production_compatibility_review.sql'), 'utf8');
const migration2 = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260929000100_v3182_idempotent_stock_reconciliation.sql'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'cloud-src', 'vhc-cloud-sync.js'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('create_sale preserves the legacy public.sales return contract without unnecessary DROP', () => {
  assert.match(migration1, /create or replace function public\.create_sale\(payload jsonb\)\s+returns public\.sales/i);
  assert.match(migration1, /UUID create_sale has dependents; cannot safely restore its return type/i);
  assert.match(migration1, /if v_result = 'uuid' then\s+execute 'drop function public\.create_sale\(jsonb\)'/i);
  assert.match(migration1, /returning \* into v_sale;\s*v_sale_id := v_sale\.id;/i);
  assert.match(migration1, /return v_sale;/i);
  assert.doesNotMatch(migration1, /drop function public\.create_sale\(jsonb\)\s+cascade/i);
});

test('create_sale remains owned, SECURITY DEFINER, search_path locked and explicitly granted', () => {
  assert.match(migration1, /alter function public\.create_sale\(jsonb\) owner to postgres/i);
  assert.match(migration1, /create or replace function public\.create_sale[\s\S]*?security definer\s+set search_path = public/i);
  assert.match(migration1, /grant execute on function public\.create_sale\(jsonb\) to public, postgres, anon, authenticated, service_role/i);
  assert.match(migration1, /v_result is null or v_result not in \('sales', 'public\.sales'\)/i);
  assert.match(migration1, /v_grants is distinct from array\['PUBLIC','anon','authenticated','postgres','service_role'\]::text\[\]/i);
});

test('restore_sale_history preserves its return shape while consuming composite create_sale', () => {
  assert.match(migration1, /restore_sale_history's pre-existing return type and security mode/i);
  assert.match(migration1, /v_result = 'uuid'[\s\S]*?v_return_expression := 'v_sale\.id'/i);
  assert.match(migration1, /v_return_type := 'public\.sales'[\s\S]*?v_return_expression := 'v_sale'/i);
  assert.match(migration1, /v_sale := public\.create_sale\([\s\S]*?return %s;/i);
  assert.match(migration1, /v_sale_id := v_sale\.id/i);
  assert.match(migration1, /jsonb_build_object\('affects_stock', false\)/i);
});

test('stock-movement creator attribution is written when the target schema supports it', () => {
  assert.match(migration1, /if exists \(select 1 from information_schema\.columns[\s\S]*?column_name='created_by'\)[\s\S]*?\(item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by\)/i);
  assert.match(migration1, /else\s+insert into public\.stock_movements\s+\(item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason\)/i);
});

test('required seq values are concurrency-safe and explicit legacy values remain supported', () => {
  assert.match(migration1, /lock table public\.stock_movements in access exclusive mode/i);
  assert.match(migration1, /pg_advisory_xact_lock\(19360721, 3182\)/i);
  assert.match(migration1, /new\.seq := nextval\(v_sequence\)/i);
  assert.match(migration1, /else\s+if exists \(select 1 from public\.stock_movements where seq = new\.seq\)/i);
  assert.match(migration1, /perform setval\(v_sequence, new\.seq, true\)/i);
  assert.match(migration1, /create unique index if not exists stock_movements_seq_uq\s+on public\.stock_movements \(seq\)/i);
  assert.match(migration1, /create trigger stock_movements_assign_seq_before_insert[\s\S]*?before insert on public\.stock_movements/i);
  assert.match(migration2, /Migration 1 stock movement sequence allocator is not installed/i);
});

test('identity-backed stock_movements.seq is preserved without a competing trigger', () => {
  assert.match(migration1, /v_attidentity in \('a', 'd'\)/i);
  assert.match(migration1, /Identity-backed stock_movements\.seq has % NULL value\(s\)/i);
  assert.match(migration1, /Identity-backed stock_movements\.seq has no owned sequence/i);
  assert.match(migration1, /drop trigger if exists stock_movements_assign_seq_before_insert on public\.stock_movements/i);
  assert.match(migration1, /if v_attidentity not in \('a', 'd'\) then[\s\S]*?create or replace function public\.vhc_stock_movements_assign_seq/i);
  assert.match(migration2, /select a\.attidentity into v_attidentity/i);
  assert.match(migration2, /if v_attidentity not in \('a', 'd'\) and \(/i);
});

test('create_sale supports TEST schemas without safe_date while retaining production helper behavior', () => {
  assert.match(migration1, /to_regprocedure\('public\.safe_date\(text\)'\)[\s\S]*?execute 'select public\.safe_date\(\$1\)' into v_expiry using v_item->>'expiry_date'/i);
  assert.match(migration1, /v_expiry := nullif\(v_item->>'expiry_date',''\)::date;[\s\S]*?exception when others then\s+v_expiry := null/i);
  assert.match(migration1, /expiry_date,[\s\S]*?v_expiry,/i);
});

test('logical_key deterministic backfill and unique sale/key protection remain', () => {
  assert.match(migration1, /md5\(concat_ws\('\|',[\s\S]*?coalesce\(category,''\)\)\)/i);
  assert.match(migration1, /row_number\(\) over\s*\(\s*partition by sale_id, item_id, stock_batch_id, drug_name, batch_no, quantity, rate, total, category/i);
  assert.match(migration1, /alter column logical_key set not null/i);
  assert.match(migration1, /create unique index if not exists sale_items_sale_id_logical_key_uq\s+on public\.sale_items \(sale_id, logical_key\)/i);
});

test('sale and item retries remain idempotent, partial item repair remains possible, stock is only applied for a new item', () => {
  assert.match(migration1, /on conflict \(bill_id\) do update set updated_at=now\(\)\s+returning \* into v_sale/i);
  assert.match(migration1, /on conflict \(sale_id, logical_key\) do nothing;\s*\n\s*if not found or not v_affects_stock then continue; end if;/i);
  assert.match(migration1, /insert into public\.stock_movements[\s\S]*?if v_remaining > 0 then raise exception 'Insufficient stock/i);
});

test('current v3.18.2 worker can ignore the returned row and verify by bill_id', () => {
  assert.match(worker, /rpc\('create_sale', \{ payload: rpcPayload \}\)/);
  assert.match(worker, /bill_id/);
  assert.match(worker, /create_sale[\s\S]*?bill_id/i);
});

test('Migration 2 keeps nullable keyed idempotency, lock/opening check, absolute close and conflict result', () => {
  assert.match(migration2, /add column if not exists movement_key text/i);
  assert.match(migration2, /create unique index if not exists stock_movements_movement_key_uq[\s\S]*?where movement_key is not null/i);
  assert.match(migration2, /for update/i);
  assert.match(migration2, /v_batch\.qty - v_expected/i);
  assert.match(migration2, /update public\.stock_batches set qty = v_closing/i);
  assert.match(migration2, /'status', 'CONFLICT'/i);
  assert.match(migration2, /'status', 'ALREADY_APPLIED'/i);
  assert.match(migration2, /insert into public\.stock_movements[\s\S]*?movement_key/i);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { fn(); passed += 1; console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}`); console.error(error); process.exitCode = 1; }
  }
  console.log(`\nmigration-backward-compatibility tests: ${passed}/${tests.length} passed`);
})();
