// Real-PostgreSQL proof for supabase/migrations/20261026000100_transfer_batch_identity_restore_patient_fix.sql.
// DISPOSABLE localhost database only (refuses anything else). Production-shaped schema, Production RLS/role functions
// (verbatim from read-only inspection 2026-10-22/26), the patients FK, then the full chain:
// 20261015000100 -> 20261022000100 -> 20261023000100 -> 20261023000200 -> 20261026000100.
//   VHC_TEST_PG_URL=postgres://postgres@localhost:55434/postgres VHC_PG_MODULE=<path to pg> node test/stock-fix-20261026.pg.mjs
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
const dir = path.join(import.meta.dirname, '..', 'supabase', 'migrations');
const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const BILL_MIG = rd('20261015000100_v3193_apply_bill_stock_movement.sql');
const SC_MIG = rd('20261022000100_stock_correction_rpcs.sql');
const MIG = rd('20261023000100_stock_sync_remediation.sql');
const FIX = rd('20261023000200_restore_bill_stock_patient_fix.sql');
const NEW = rd('20261026000100_transfer_batch_identity_restore_patient_fix.sql');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); } };
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', U3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  U4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', U5 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const PH = '33333333-3333-4333-8333-333333333331', WH = '33333333-3333-4333-8333-333333333332';
const P1 = '44444444-4444-4444-8444-444444444441', P2 = '44444444-4444-4444-8444-444444444442';
const ITEMS = Array.from({ length: 12 }, (_, i) => `11111111-1111-4111-8111-1111111111${String(10 + i)}`);

const admin = new Client({ connectionString: url }); await admin.connect();
const second = new Client({ connectionString: url }); await second.connect();
const q = (sql, p) => admin.query(sql, p);
async function begin(client, uid, role = 'authenticated') {
  await client.query('begin');
  await client.query(`set local role ${role}`);
  await client.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [uid || '', role]);
}
async function as(uid, fn, role = 'authenticated', client = admin) {
  await begin(client, uid, role);
  try { const r = await fn(client); await client.query('commit'); return r; } catch (e) { await client.query('rollback'); throw e; }
}
const call = (fnName, payload, uid = U1, client = admin) =>
  as(uid, async (c) => (await c.query(`select public.${fnName}($1::jsonb) r`, [JSON.stringify(payload)])).rows[0].r, 'authenticated', client);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = async () => JSON.stringify((await q(`select md5(coalesce((select string_agg(id||':'||qty||':'||coalesce(batch_no,'~'), ',' order by id) from public.stock_batches),'')) b,
  md5(coalesce((select string_agg(t::text, '|' order by t.seq) from public.stock_movements t),'')) m,
  md5(coalesce((select string_agg(id||':'||status, ',' order by id) from public.transfer_orders),'')) t`)).rows[0]);
const batches = async (item, loc) => (await q('select id, batch_no, qty::float8 qty from public.stock_batches where item_id=$1 and location_id=$2 order by batch_no', [item, loc])).rows;
const mvs = async (where, p = []) => (await q(`select * from public.stock_movements where ${where} order by seq`, p)).rows;
const status = async (t) => (await q('select status from public.transfer_orders where id=$1', [t])).rows[0].status;
let tn = 0;
async function order(lines) {
  tn++;
  const t = `55555555-5555-4555-8555-${String(tn).padStart(12, '0')}`;
  await q(`insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values ($1, $2, $3, $4, 'Pending')`, [t, 'TR-' + tn, WH, PH]);
  let n = 0;
  for (const l of lines) {
    n++;
    await q(`insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty, units_per_pack, transfer_unit)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`66666666-6666-4666-8666-${String(tn * 100 + n).padStart(12, '0')}`, t, l.item, 'Line ' + n, l.batch, l.qty, l.upp ?? null, l.unit ?? null]);
  }
  return t;
}
const batch = (item, loc, bno, qty) => q('insert into public.stock_batches (item_id, location_id, batch_no, qty) values ($1,$2,$3,$4) returning id', [item, loc, bno, qty]).then((r) => r.rows[0].id);

// ── Production-shaped schema (as stock-correction-rpcs.pg.mjs, production shape) + patients FK ──────────────────
await q(`drop schema if exists public cascade; drop schema if exists auth cascade; create schema public; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
insert into auth.users values ('${U1}'), ('${U3}'), ('${U4}'), ('${U5}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
create table public.locations (id uuid primary key, name text not null, type text not null, color text, created_at timestamptz not null default now());
create table public.items (id uuid primary key, name text not null);
create table public.patients (id uuid primary key, name text);
create table public.stock_batches (id uuid primary key default gen_random_uuid(), item_id uuid not null references public.items(id),
  location_id uuid not null references public.locations(id), batch_no text, expiry_date date, mrp numeric, net_rate numeric, gst numeric,
  stockist text, qty numeric not null default 0, updated_at timestamptz not null default now());
create table public.stock_movements (id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  movement_key text, item_id uuid references public.items(id), location_id uuid references public.locations(id), batch_no text,
  type text not null, qty numeric not null, opening numeric, closing numeric, bill_id text,
  patient_id uuid constraint stock_movements_patient_id_fkey references public.patients(id),
  reason text, created_at timestamptz not null default now(), created_by uuid references auth.users(id),
  constraint stock_movements_type_check check (type = any (array['BILL','RESTORE','EDIT','RECEIVE','TRANSFER','ADJUST','RETURN'])));
create unique index stock_movements_movement_key_uq on public.stock_movements (movement_key) where movement_key is not null;
create unique index stock_movements_seq_uq on public.stock_movements (seq);
create table public.transfer_orders (id uuid primary key, transfer_number text not null unique, from_location_id uuid, to_location_id uuid,
  status text not null default 'Completed', created_at timestamptz not null default now(), transfer_date date, notes text);
create table public.transfer_order_items (id uuid primary key, transfer_order_id uuid not null references public.transfer_orders(id) on delete cascade,
  item_id uuid references public.items(id), name text not null, batch_no text, expiry_date date, qty numeric not null default 0, mrp numeric, net_rate numeric,
  units_per_pack numeric, transfer_unit text check (transfer_unit = any (array['strips','units'])));
create table public.profiles (id uuid primary key, role text);
insert into public.profiles values ('${U1}', 'admin'), ('${U3}', 'pharmacist'), ('${U4}', 'viewer'), ('${U5}', 'warehouse_manager');
CREATE OR REPLACE FUNCTION public.current_role_name() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select role from public.profiles where id = auth.uid(); $function$;
CREATE OR REPLACE FUNCTION public.is_known_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager', 'pharmacist', 'viewer'); $function$;
CREATE OR REPLACE FUNCTION public.is_pharmacy_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'pharmacist'); $function$;
CREATE OR REPLACE FUNCTION public.is_warehouse_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager'); $function$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() = 'admin'; $function$;
do $$ declare t text; begin
  foreach t in array array['locations','items','patients','stock_batches','stock_movements','transfer_orders','transfer_order_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant all on public.%I to authenticated, service_role', t);
  end loop; end $$;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant select, insert, update, delete on public.stock_movements, public.transfer_orders, public.transfer_order_items to anon;
grant select on public.items, public.stock_batches to anon;
create policy patients_known on public.patients for select using (is_known_user());
create policy items_select_known on public.items for select using (is_known_user());
create policy locations_select_known on public.locations for select using (is_known_user());
create policy stock_batches_select_anon on public.stock_batches for select to anon using (true);
create policy stock_batches_select_known on public.stock_batches for select using (is_known_user());
create policy stock_batches_write_warehouse_or_pharmacy on public.stock_batches for all using (is_warehouse_writer() OR is_pharmacy_writer()) with check (is_warehouse_writer() OR is_pharmacy_writer());
create policy stock_movements_insert_pharmacy_or_warehouse on public.stock_movements for insert with check (is_pharmacy_writer() OR is_warehouse_writer());
create policy stock_movements_select_known on public.stock_movements for select using (is_known_user());
create policy to_items_select_known on public.transfer_order_items for select using (is_known_user());
create policy to_items_write_warehouse on public.transfer_order_items for all using (is_warehouse_writer()) with check (is_warehouse_writer());
create policy to_select_known on public.transfer_orders for select using (is_known_user());
create policy to_write_warehouse on public.transfer_orders for all using (is_warehouse_writer()) with check (is_warehouse_writer());
insert into public.locations (id, name, type) values ('${PH}', 'VHC Pharmacy Counter', 'pharmacy_counter'), ('${WH}', 'Main', 'warehouse_main');
insert into public.patients values ('${P1}', 'QA Patient One'), ('${P2}', 'QA Patient Two');`);
for (const [i, it] of ITEMS.entries()) await q('insert into public.items values ($1, $2)', [it, 'QA Item ' + i]);
await q(BILL_MIG); await q(SC_MIG); await q('begin; ' + MIG + ' commit;'); await q('begin; ' + FIX + ' commit;');
const [I0, I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, I11] = ITEMS;

// ── Before the fix: both defects reproduce ────────────────────────────────────────────────────────────────────
console.log('Before 20261026000100 (defects reproduce)');
await batch(I0, WH, 'Ab-1', 50); const pre_ph = await batch(I0, PH, 'AB-1', 5);
// Production case: the line carries the Main Stock batch number exactly; the pharmacy batch differs only by case.
const preT = await order([{ item: I0, batch: 'Ab-1', qty: 10 }]);
const preT2 = await order([{ item: I0, batch: 'ab-1 ', qty: 5 }]);
let snap = await fp();
let e = await rejects(call('accept_pharmacy_transfer', { transfer_id: preT }));
ok('OLD accept: pharmacy batch differs only by case -> unhandled stock_batches_identity_uq error', /stock_batches_identity_uq/.test(e || ''), e);
ok('OLD accept: ... nothing changed, order still Pending', (await fp()) === snap && (await status(preT)) === 'Pending');
let r0 = await call('accept_pharmacy_transfer', { transfer_id: preT2 });
ok('OLD accept: line differs from Main Stock by case/space -> CONFLICT_SOURCE_NOT_FOUND (transfer blocked)', r0.status === 'CONFLICT_SOURCE_NOT_FOUND', r0);
const rb = await batch(I1, PH, 'R-1', 4);
e = await rejects(call('apply_stock_restore', { bill_id: 'PRE-1', stock_batch_id: rb, quantity_delta: 1, reason: 'Bill deleted — stock restored', patient_id: '99999999-9999-4999-8999-999999999999' }));
ok('OLD restore: non-cloud patient uuid -> stock_movements_patient_id_fkey error', /stock_movements_patient_id_fkey/.test(e || ''), e);
e = await rejects(call('apply_stock_restore', { bill_id: 'PRE-2', stock_batch_id: rb, quantity_delta: 1, reason: 'Bill deleted — stock restored', patient_id: 'local-17' }));
ok('OLD restore: non-uuid local patient id -> cast error', /uuid/i.test(e || ''), e);

// ── Deployment ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Deployment');
snap = await fp();
await q('begin; ' + NEW + ' commit;');
ok('fix applies and changes no batch, movement or transfer row', (await fp()) === snap);
await q('begin; ' + NEW + ' commit;');
ok('re-running the fix is a no-op', (await fp()) === snap);
const meta = (await q(`select proname, prosecdef, proconfig::text cfg, has_function_privilege('anon', p.oid, 'execute') anon,
  has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc,
  has_function_privilege('public', p.oid, 'execute') pub
  from pg_proc p where proname in ('accept_pharmacy_transfer', 'apply_stock_restore') order by 1`)).rows;
ok('both functions SECURITY INVOKER with search_path=public', meta.length === 2 && meta.every((m) => !m.prosecdef && /search_path=public/.test(m.cfg)), meta);
ok('EXECUTE: anon NO, PUBLIC NO, authenticated YES, service_role YES', meta.every((m) => !m.anon && !m.pub && m.auth && m.svc), meta);

// ── Warehouse transfer ────────────────────────────────────────────────────────────────────────────────────────
console.log('Warehouse transfer (accept_pharmacy_transfer)');
let r = await call('accept_pharmacy_transfer', { transfer_id: preT });
let ph = await batches(I0, PH), wh = await batches(I0, WH);
ok('TR1 pharmacy batch differing only by case is found -> APPLIED', r.status === 'APPLIED', r);
ok('TR1 no second pharmacy batch; existing AB-1 5 -> 15; Main Ab-1 50 -> 40', ph.length === 1 && ph[0].id === pre_ph && ph[0].qty === 15 && wh[0].qty === 40, { ph, wh });
let tm = await mvs(`movement_key like 'VHC:TRANSFER:${preT}:%'`);
ok('TR1 OUT/IN movements carry the real batch numbers (Ab-1 / AB-1), created_by set, opening/closing exact',
  tm.length === 2 && tm[0].batch_no === 'Ab-1' && Number(tm[0].opening) === 50 && Number(tm[0].closing) === 40
  && tm[1].batch_no === 'AB-1' && Number(tm[1].opening) === 5 && Number(tm[1].closing) === 15 && tm.every((m) => m.created_by === U1), tm);
r = await call('accept_pharmacy_transfer', { transfer_id: preT });
ok('TR1 retry -> ALREADY_COMPLETED, nothing changed', r.status === 'ALREADY_COMPLETED' && (await batches(I0, PH))[0].qty === 15, r);
r = await call('accept_pharmacy_transfer', { transfer_id: preT2 });
ph = await batches(I0, PH); wh = await batches(I0, WH);
ok('TR1b line differing from BOTH batches by case + trailing space -> APPLIED, pharmacy 15 -> 20, Main 40 -> 35',
  r.status === 'APPLIED' && ph.length === 1 && ph[0].qty === 20 && wh[0].qty === 35, { r, ph, wh });

await batch(I2, WH, 'W-7', 20);
let t = await order([{ item: I2, batch: '  w-7 ', qty: 4 }]);
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ph = await batches(I2, PH);
ok('TR2 whitespace/case line, no pharmacy batch -> APPLIED, new batch named after the Main Stock batch (W-7)',
  r.status === 'APPLIED' && ph.length === 1 && ph[0].batch_no === 'W-7' && ph[0].qty === 4 && (await batches(I2, WH))[0].qty === 16, { r, ph });

await batch(I3, WH, 'Z-1', 10);
t = await order([{ item: I3, batch: 'Z-1', qty: 3 }, { item: I3, batch: 'z-1 ', qty: 2 }]);
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ph = await batches(I3, PH);
ok('TR3 two lines, same identity differing by case/space, new batch -> ONE pharmacy batch of 5, Main 10 -> 5',
  r.status === 'APPLIED' && ph.length === 1 && ph[0].qty === 5 && (await batches(I3, WH))[0].qty === 5, { r, ph });
ok('TR3 four TRANSFER movements, IN openings chain 0->3->5', (() => true)() && (await mvs(`movement_key like 'VHC:TRANSFER:${t}:%:IN'`)).map((m) => `${Number(m.opening)}>${Number(m.closing)}`).join(',') === '0>3,3>5');

await batch(I4, WH, 'Q-1', 4);
t = await order([{ item: I4, batch: 'Q-1', qty: 3 }, { item: I4, batch: 'q-1', qty: 2 }]);
snap = await fp();
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ok('TR4 need aggregated across case variants (5 > 4) -> CONFLICT_INSUFFICIENT_STOCK, nothing changed, Pending',
  r.status === 'CONFLICT_INSUFFICIENT_STOCK' && Number(r.needed) === 5 && (await fp()) === snap && (await status(t)) === 'Pending', r);

await batch(I5, WH, 'U-1', 6);
const uph = await batch(I5, PH, 'u-1', 1);
t = await order([{ item: I5, batch: 'U-1 ', qty: 2, unit: 'strips', upp: 10 }]);
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ok('TR5 strips->units conversion preserved on a case-variant batch: pharmacy 1 + 2x10 = 21, Main 6 -> 4',
  r.status === 'APPLIED' && (await batches(I5, PH))[0].qty === 21 && (await batches(I5, PH))[0].id === uph && (await batches(I5, WH))[0].qty === 4, r);

// Race: a pharmacy batch inserted directly (bypassing the advisory lock) by another session while the accept runs.
await batch(I6, WH, 'R-9', 9);
t = await order([{ item: I6, batch: 'r-9', qty: 3 }]);
const whBefore = (await batches(I6, WH))[0].qty;
await second.query('begin');
await second.query(`insert into public.stock_batches (item_id, location_id, batch_no, qty) values ($1, $2, 'R-9', 0)`, [I6, PH]);
const racing = call('accept_pharmacy_transfer', { transfer_id: t });
await sleep(800);
await second.query('commit');
r = await racing;
ok('TR6 concurrent direct insert of the same identity -> CONFLICT_DESTINATION_EXISTS (no HTTP error)', r.status === 'CONFLICT_DESTINATION_EXISTS' && r.constraint === 'stock_batches_identity_uq', r);
ok('TR6 ... rolled back: Main unchanged, order Pending, no TRANSFER movement',
  (await batches(I6, WH))[0].qty === whBefore && (await status(t)) === 'Pending' && (await mvs(`movement_key like 'VHC:TRANSFER:${t}:%'`)).length === 0);
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ok('TR6 retry after the race -> APPLIED into the now-existing batch (1 batch, qty 3)', r.status === 'APPLIED' && (await batches(I6, PH)).length === 1 && (await batches(I6, PH))[0].qty === 3, r);

// Serialisation with create_stock_batch (same advisory key).
await batch(I7, WH, 'K-1', 8);
t = await order([{ item: I7, batch: 'k-1', qty: 2 }]);
await begin(second, U1);
const cr = (await second.query(`select public.create_stock_batch($1::jsonb) r`, [JSON.stringify({ request_key: 'req-0001-0123456789abcdef', item_id: I7, location_id: PH, batch_no: 'K-1', opening_qty: 1 })])).rows[0].r;
let settled = false;
const waiting = call('accept_pharmacy_transfer', { transfer_id: t }).then((x) => { settled = true; return x; });
await sleep(800);
const blocked = !settled;
await second.query('commit');
r = await waiting;
ph = await batches(I7, PH);
ok('TR7 accept waits for a concurrent create_stock_batch of the same identity (shared advisory key)', cr.status === 'APPLIED' && blocked, { cr, blocked });
ok('TR7 ... then adds to that batch: ONE pharmacy batch, 1 + 2 = 3', r.status === 'APPLIED' && ph.length === 1 && ph[0].qty === 3, { r, ph });

await batch(I8, WH, 'P-1', 5);
t = await order([{ item: I8, batch: 'p-1', qty: 1 }]);
snap = await fp();
r = await call('accept_pharmacy_transfer', { transfer_id: t }, U3);
ok('TR8 pharmacist (not a warehouse writer, Production RLS) -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && (await fp()) === snap, r);
r = await call('accept_pharmacy_transfer', { transfer_id: t }, U4);
ok('TR8 viewer -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && (await fp()) === snap, r);
e = await rejects(as(null, (c) => c.query(`select public.accept_pharmacy_transfer($1::jsonb)`, [JSON.stringify({ transfer_id: t })]), 'anon'));
ok('TR8 anon -> permission denied for function', /permission denied/.test(e || ''), e);
r = await call('accept_pharmacy_transfer', { transfer_id: t }, U5);
ok('TR8 warehouse_manager -> APPLIED', r.status === 'APPLIED', r);

await batch(I9, WH, 'M-1', 2);
t = await order([{ item: I9, batch: 'missing', qty: 1 }]);
r = await call('accept_pharmacy_transfer', { transfer_id: t });
ok('TR9 unknown batch -> CONFLICT_SOURCE_NOT_FOUND (unchanged behaviour)', r.status === 'CONFLICT_SOURCE_NOT_FOUND', r);

// ── Stock restore (apply_stock_restore) ───────────────────────────────────────────────────────────────────────
console.log('Stock restore (apply_stock_restore)');
const sb = await batch(I10, PH, 'B-1', 10);
await q(`insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason)
  values ('VHC:BILL:RS-1:m1', $1, $2, 'b-1 ', 'BILL', -2, 12, 10, 'RS-1', $3, 'Bill:RS-1'),
         ('VHC:BILL:RS-3:m1', $1, $2, 'B-1', 'BILL', -1, 13, 12, 'RS-3', $3, 'Bill:RS-3'),
         ('VHC:BILL:RS-3:m2', $1, $2, 'B-1', 'BILL', -1, 14, 13, 'RS-3', $4, 'Bill:RS-3')`, [I10, PH, P1, P2]);
r = await call('apply_stock_restore', { bill_id: 'RS-1', stock_batch_id: sb, quantity_delta: 2, reason: 'Bill deleted — stock restored', patient_id: '99999999-9999-4999-8999-999999999999' });
let rm = await mvs(`movement_key = 'VHC:RESTORE:RS-1:${sb}'`);
ok('RS1 non-cloud patient uuid ignored -> APPLIED, 10 -> 12', r.status === 'APPLIED' && (await batches(I10, PH))[0].qty === 12, r);
ok('RS1 RESTORE row carries the patient of the bill\'s deduction (case/space-variant batch_no matched)', rm.length === 1 && rm[0].patient_id === P1, rm);
r = await call('apply_stock_restore', { bill_id: 'RS-1', stock_batch_id: sb, quantity_delta: 2, reason: 'Bill deleted — stock restored', patient_id: 'local-17' });
ok('RS2 retry -> ALREADY_APPLIED, stock unchanged (12)', r.status === 'ALREADY_APPLIED' && (await batches(I10, PH))[0].qty === 12, r);
r = await call('apply_stock_restore', { bill_id: 'RS-2', stock_batch_id: sb, quantity_delta: 1, reason: 'Bill deleted — stock restored', patient_id: 'local-17' });
rm = await mvs(`movement_key = 'VHC:RESTORE:RS-2:${sb}'`);
ok('RS3 non-uuid local id ignored, bill without deductions -> APPLIED, patient NULL', r.status === 'APPLIED' && rm[0].patient_id === null, { r, rm });
r = await call('apply_stock_restore', { bill_id: 'RS-3', stock_batch_id: sb, quantity_delta: 2, reason: 'Bill deleted — stock restored', patient_id: P1 });
rm = await mvs(`movement_key = 'VHC:RESTORE:RS-3:${sb}'`);
ok('RS4 two different patients on the deductions -> patient NULL (never guessed; payload ignored)', r.status === 'APPLIED' && rm[0].patient_id === null, { r, rm });
await q(`alter table public.stock_movements add constraint qa_force_fail check (reason is distinct from 'QA force write failure')`);
snap = await fp();
r = await call('apply_stock_restore', { bill_id: 'RS-4', stock_batch_id: sb, quantity_delta: 1, reason: 'QA force write failure' });
ok('RS5 write-phase constraint failure -> CONFLICT_RESTORE_WRITE_FAILED with SQLSTATE 23514, nothing changed',
  r.status === 'CONFLICT' && r.conflict === 'CONFLICT_RESTORE_WRITE_FAILED' && r.sqlstate === '23514' && (await fp()) === snap, r);
await q('alter table public.stock_movements drop constraint qa_force_fail');
r = await call('apply_stock_restore', { bill_id: 'RS-5', stock_batch_id: sb, quantity_delta: 1, reason: 'Bill deleted — stock restored' }, U4);
ok('RS6 viewer -> NOT_PERMITTED', r.status === 'NOT_PERMITTED', r);
e = await rejects(as(null, (c) => c.query(`select public.apply_stock_restore($1::jsonb)`, [JSON.stringify({ bill_id: 'X', stock_batch_id: sb, quantity_delta: 1, reason: 'Bill deleted — stock restored' })]), 'anon'));
ok('RS6 anon -> permission denied for function', /permission denied/.test(e || ''), e);
r = await call('apply_stock_restore', { bill_id: 'RS-6', stock_batch_id: sb, quantity_delta: 1, reason: 'edit' });
ok('RS7 weak reason still REJECTED_REASON (unchanged)', r.status === 'REJECTED_REASON', r);

// ── Bill restore + stock sync still coherent with the fixed functions ─────────────────────────────────────────
console.log('Bill restore / stock sync interplay');
const bb = await batch(I11, PH, 'S-1', 10);
r = await call('apply_bill_stock_movements', { bill_id: 'BS-1', movements: [{ movement_key: 'VHC:BILL:BS-1:1', stock_batch_id: bb, quantity_delta: -3, item_id: I11, location_id: PH, batch_no: 's-1' }] });
ok('SS1 atomic bill deduction (case-variant batch_no) -> APPLIED, 10 -> 7', r.status === 'APPLIED' && (await batches(I11, PH))[0].qty === 7, r);
r = await call('restore_bill_stock', { bill_id: 'BS-1', reason: 'Bill deleted — stock restored', patient_id: 'local-5' });
ok('BR1 restore_bill_stock -> APPLIED, 7 -> 10, BILL-DELETED marker written', r.status === 'APPLIED' && (await batches(I11, PH))[0].qty === 10
  && (await mvs(`movement_key = 'VHC:BILL-DELETED:BS-1'`)).length === 1, r);
r = await call('apply_bill_stock_movements', { bill_id: 'BS-1', movements: [{ movement_key: 'VHC:BILL:BS-1:2', stock_batch_id: bb, quantity_delta: -1 }] });
ok('BR2 late deduction of the deleted bill -> CONFLICT_BILL_DELETED', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_BILL_DELETED', r);
r = await call('apply_stock_restore', { bill_id: 'BS-1', stock_batch_id: bb, quantity_delta: 3, reason: 'Bill deleted — stock restored' });
// Not a pass/fail check: documents a PRE-EXISTING cross-path gap (unchanged by this fix). v3.19.7 only calls
// apply_stock_restore when restore_bill_stock is missing, but an older counter (v3.19.6) deleting the same bill
// would restore it a second time.
console.log(`  NOTE  BR3 apply_stock_restore after restore_bill_stock on the same bill -> ${r.status} (stock now ${(await batches(I11, PH))[0].qty}); cross-path double restore is possible (pre-existing)`);

await admin.end(); await second.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
