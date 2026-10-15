// Real-PostgreSQL proof for public.apply_bill_stock_movement(jsonb)
// (supabase/migrations/20261015000100_v3193_apply_bill_stock_movement.sql).
//
// Runs against a DISPOSABLE local PostgreSQL database only. It refuses any connection string that
// is not localhost, so it can never reach Supabase. Production-shaped tables (stock_movements.seq
// GENERATED ALWAYS identity, type CHECK, partial unique movement_key index, is_pharmacy_writer).
//
// HOW TO RUN (example):
//   initdb/pg_ctl a throwaway cluster on localhost:55434, then
//   set VHC_TEST_PG_URL=postgres://postgres@localhost:55434/postgres
//   set VHC_PG_MODULE=<path to node_modules\pg>            (pg is not an app dependency)
//   node test/apply-bill-stock-movement.pg.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const url = process.env.VHC_TEST_PG_URL || '';
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error('Refusing: VHC_TEST_PG_URL must point at a disposable localhost database.');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { Client } = require(process.env.VHC_PG_MODULE || 'pg');
const MIGRATION = fs.readFileSync(path.join(import.meta.dirname, '..', 'supabase', 'migrations', '20261015000100_v3193_apply_bill_stock_movement.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); } };
const ITEM = '11111111-1111-4111-8111-111111111111', LOC = '33333333-3333-4333-8333-333333333333';
const B1 = '22222222-2222-4222-8222-222222222221', B2 = '22222222-2222-4222-8222-222222222222';

const db = new Client({ connectionString: url });
await db.connect();
const q = (sql, params) => db.query(sql, params);
const apply = async (payload, client = db) => (await client.query('select public.apply_bill_stock_movement($1::jsonb) r', [JSON.stringify(payload)])).rows[0].r;
const qty = async (id) => Number((await q('select qty from public.stock_batches where id = $1', [id])).rows[0].qty);
const moves = async (key) => (await q('select * from public.stock_movements where movement_key = $1', [key])).rows;
const checksum = async () => (await q(`select md5(coalesce(string_agg(id::text||':'||qty::text, ',' order by id), '')) a,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.stock_movements t) b from public.stock_batches`)).rows[0];

await q(`drop schema if exists public cascade; create schema public;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.stock_batches (id uuid primary key, item_id uuid not null, location_id uuid not null, batch_no text,
  qty numeric not null default 0, updated_at timestamptz not null default now());
create table public.stock_movements (id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  item_id uuid, location_id uuid, batch_no text, type text not null, qty numeric not null, opening numeric, closing numeric,
  bill_id text, patient_id uuid, reason text, created_by uuid, created_at timestamptz not null default now(), movement_key text,
  constraint stock_movements_type_check check (type = any (array['BILL','RESTORE','EDIT','RECEIVE','TRANSFER','ADJUST','RETURN'])));
create unique index stock_movements_movement_key_uq on public.stock_movements (movement_key) where movement_key is not null;
create or replace function public.is_pharmacy_writer() returns boolean language sql stable as $$ select true $$;`);
await q(`insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values
  ($1, '${ITEM}', '${LOC}', 'B-1', 25), ($2, '${ITEM}', '${LOC}', 'B-2', 10)`, [B1, B2]);
// a pre-existing historical movement + a STOCK_CONFLICT-era row that deployment must never touch
await q(`insert into public.stock_movements (item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason, movement_key)
  values ('${ITEM}', '${LOC}', 'B-1', 'BILL', -1, 26, 25, 'BILL-OLD', 'historical', 'VHC:BILL:BILL-OLD:m1')`);

console.log('Deployment');
const before = await checksum();
await q(MIGRATION);
await q(MIGRATION); // idempotent re-run
const after = await checksum();
ok('migration applies twice without error', true);
ok('deployment mutates no stock_batches or stock_movements rows', before.a === after.a && before.b === after.b);
const grants = (await q(`select has_function_privilege('anon','public.apply_bill_stock_movement(jsonb)','execute') anon,
  has_function_privilege('authenticated','public.apply_bill_stock_movement(jsonb)','execute') auth`)).rows[0];
ok('authenticated may execute; anon may not', grants.auth === true && grants.anon === false);

const base = { bill_id: 'BILL-A', stock_batch_id: B1, item_id: ITEM, location_id: LOC, batch_no: 'B-1', movement_type: 'BILL' };

console.log('A. normal BILL movement');
let r = await apply({ ...base, movement_key: 'VHC:BILL:BILL-A:m1', quantity_delta: -3, expected_opening: 25 });
ok('APPLIED, opening 25 -> closing 22', r.status === 'APPLIED' && Number(r.opening) === 25 && Number(r.closing) === 22, JSON.stringify(r));
ok('stock deducted once (25 -> 22)', (await qty(B1)) === 22);
ok('exactly one movement row', (await moves('VHC:BILL:BILL-A:m1')).length === 1);

console.log('C. response lost -> retry');
for (let i = 0; i < 5; i++) r = await apply({ ...base, movement_key: 'VHC:BILL:BILL-A:m1', quantity_delta: -3, expected_opening: 25 });
ok('retries return ALREADY_APPLIED', r.status === 'ALREADY_APPLIED', JSON.stringify(r));
ok('stock NOT deducted again (still 22)', (await qty(B1)) === 22);
ok('movement NOT duplicated', (await moves('VHC:BILL:BILL-A:m1')).length === 1);

console.log('D. existing movement with different values');
r = await apply({ ...base, bill_id: 'BILL-OTHER', movement_key: 'VHC:BILL:BILL-A:m1', quantity_delta: -3 });
ok('different bill on same key -> CONFLICT_MOVEMENT_MISMATCH', r.status === 'CONFLICT_MOVEMENT_MISMATCH', JSON.stringify(r));
r = await apply({ ...base, movement_key: 'VHC:BILL:BILL-A:m1', quantity_delta: -4 });
ok('different qty on same key -> CONFLICT_MOVEMENT_MISMATCH', r.status === 'CONFLICT_MOVEMENT_MISMATCH');
r = await apply({ ...base, stock_batch_id: B2, batch_no: 'B-2', movement_key: 'VHC:BILL:BILL-A:m1', quantity_delta: -3 });
ok('different batch on same key -> CONFLICT_MOVEMENT_MISMATCH', r.status === 'CONFLICT_MOVEMENT_MISMATCH');
ok('conflicts mutate nothing', (await qty(B1)) === 22 && (await qty(B2)) === 10 && (await moves('VHC:BILL:BILL-A:m1')).length === 1);

console.log('Drift (the old cascade cause) is not a conflict');
r = await apply({ ...base, bill_id: 'BILL-B', movement_key: 'VHC:BILL:BILL-B:m1', quantity_delta: -2, expected_opening: 20 });
ok('counter opening 20 vs cloud 22 -> APPLIED on the real quantity', r.status === 'APPLIED' && Number(r.opening) === 22 && Number(r.closing) === 20 && Number(r.drift) === 2, JSON.stringify(r));
ok('drift recorded in the movement reason', /counter opening 20, cloud opening 22/.test((await moves('VHC:BILL:BILL-B:m1'))[0].reason));
ok('next bill on the same batch applies too (no cascade)', (await apply({ ...base, bill_id: 'BILL-C', movement_key: 'VHC:BILL:BILL-C:m1', quantity_delta: -1, expected_opening: 17 })).status === 'APPLIED');
ok('stock 22 -> 20 -> 19', (await qty(B1)) === 19);

console.log('Genuine conflicts are refused without mutation');
r = await apply({ ...base, stock_batch_id: B2, batch_no: 'B-2', bill_id: 'BILL-D', movement_key: 'VHC:BILL:BILL-D:m1', quantity_delta: -11 });
ok('insufficient stock -> CONFLICT_INSUFFICIENT_STOCK', r.status === 'CONFLICT_INSUFFICIENT_STOCK' && (await qty(B2)) === 10 && (await moves('VHC:BILL:BILL-D:m1')).length === 0, JSON.stringify(r));
r = await apply({ ...base, stock_batch_id: '22222222-2222-4222-8222-999999999999', movement_key: 'VHC:BILL:BILL-E:m1', bill_id: 'BILL-E', quantity_delta: -1 });
ok('unknown batch -> CONFLICT_BATCH_NOT_FOUND', r.status === 'CONFLICT_BATCH_NOT_FOUND');
r = await apply({ ...base, item_id: '11111111-1111-4111-8111-999999999999', movement_key: 'VHC:BILL:BILL-F:m1', bill_id: 'BILL-F', quantity_delta: -1 });
ok('batch identity mismatch -> CONFLICT_BATCH_IDENTITY', r.status === 'CONFLICT_BATCH_IDENTITY');
await q(`insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values ('22222222-2222-4222-8222-222222222223', '${ITEM}', '${LOC}', 'B-2', 4)`);
r = await apply({ bill_id: 'BILL-G', item_id: ITEM, location_id: LOC, batch_no: 'B-2', movement_key: 'VHC:BILL:BILL-G:m1', quantity_delta: -1 });
ok('ambiguous fallback batch -> CONFLICT_BATCH_AMBIGUOUS, no mutation', r.status === 'CONFLICT_BATCH_AMBIGUOUS' && (await qty(B2)) === 10);
let threw = false; try { await apply({ ...base, movement_key: 'VHC:BILL:BILL-H:m1', bill_id: 'BILL-H', quantity_delta: 2 }); } catch (e) { threw = true; }
ok('positive delta for a BILL is rejected', threw);

console.log('Multi-line bill (H/I/J)');
r = await apply({ ...base, bill_id: 'BILL-M', movement_key: 'VHC:BILL:BILL-M:line1', quantity_delta: -10, expected_opening: 19 }); // 10 units = 1 strip of 10
const r2 = await apply({ ...base, stock_batch_id: B2, batch_no: 'B-2', bill_id: 'BILL-M', movement_key: 'VHC:BILL:BILL-M:line2', quantity_delta: -3, expected_opening: 10 });
ok('two lines on two batches each applied once', r.status === 'APPLIED' && r2.status === 'APPLIED' && (await qty(B1)) === 9 && (await qty(B2)) === 7);
await apply({ ...base, bill_id: 'BILL-M', movement_key: 'VHC:BILL:BILL-M:line1', quantity_delta: -10 });
await apply({ ...base, stock_batch_id: B2, batch_no: 'B-2', bill_id: 'BILL-M', movement_key: 'VHC:BILL:BILL-M:line2', quantity_delta: -3 });
ok('replaying the whole bill changes nothing', (await qty(B1)) === 9 && (await qty(B2)) === 7);

console.log('M. concurrent retries of the same movement');
const c2 = new Client({ connectionString: url }); await c2.connect();
const c3 = new Client({ connectionString: url }); await c3.connect();
const same = { ...base, bill_id: 'BILL-N', movement_key: 'VHC:BILL:BILL-N:m1', quantity_delta: -2 };
const both = await Promise.all([apply(same, c2), apply(same, c3), apply(same, db)]);
ok('one APPLIED, others ALREADY_APPLIED', both.filter((x) => x.status === 'APPLIED').length === 1 && both.filter((x) => x.status === 'ALREADY_APPLIED').length === 2, JSON.stringify(both.map((x) => x.status)));
ok('stock deducted exactly once under concurrency (9 -> 7)', (await qty(B1)) === 7);
await c2.end(); await c3.end();

console.log('Atomicity: movement insert failure rolls back the stock change');
await q(`create or replace function public.__fail_insert() returns trigger language plpgsql as $$ begin raise exception 'simulated insert failure'; end $$;
  create trigger __fail before insert on public.stock_movements for each row execute function public.__fail_insert();`);
threw = false;
try { await apply({ ...base, bill_id: 'BILL-X', movement_key: 'VHC:BILL:BILL-X:m1', quantity_delta: -1 }); } catch (e) { threw = /simulated/.test(e.message); }
ok('call fails', threw);
ok('stock unchanged (7) and no movement', (await qty(B1)) === 7 && (await moves('VHC:BILL:BILL-X:m1')).length === 0);
await q('drop trigger __fail on public.stock_movements; drop function public.__fail_insert();');
ok('retry after the failure applies once', (await apply({ ...base, bill_id: 'BILL-X', movement_key: 'VHC:BILL:BILL-X:m1', quantity_delta: -1 })).status === 'APPLIED' && (await qty(B1)) === 6);

console.log('Historical rows untouched');
const hist = (await moves('VHC:BILL:BILL-OLD:m1'))[0];
ok('pre-existing movement unchanged', hist && Number(hist.qty) === -1 && Number(hist.opening) === 26 && hist.reason === 'historical');

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
