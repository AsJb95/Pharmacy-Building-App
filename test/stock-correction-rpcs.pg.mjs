// Real-PostgreSQL proof for supabase/migrations/20261022000100_stock_correction_rpcs.sql
// (apply_stock_correction / apply_stock_restore / accept_pharmacy_transfer).
// DISPOSABLE localhost database only — refuses anything else, so it can never reach Supabase.
// Two schema shapes, both from read-only inspection on 2026-10-22 (VHC_SCHEMA_SHAPE):
//   test        (default) the TEST project dvscemgqegmfmgrtytal: seq assigned by its trigger with the global advisory
//               lock, stock_batches.created_at present, permissive RLS for every authenticated user.
//   production  the production project: seq GENERATED ALWAYS AS IDENTITY (no trigger), NO stock_batches.created_at,
//               NO stock_movements.patient_name, and production's RLS policies + role functions verbatim
//               (profiles.role: admin / pharmacist / warehouse_manager / viewer).
// Both carry the production movement-type CHECK. auth.uid()/auth.role() are emulated from JWT claims like Supabase.
//   VHC_TEST_PG_URL=postgres://postgres@localhost:5499/<db>  VHC_PG_MODULE=<path to pg>  [VHC_SCHEMA_SHAPE=production]
//   node test/stock-correction-rpcs.pg.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const url = process.env.VHC_TEST_PG_URL || '';
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.error('Refusing: VHC_TEST_PG_URL must point at a disposable localhost database.'); process.exit(2); }
const SHAPE = process.env.VHC_SCHEMA_SHAPE || 'test';
if (!['test', 'production'].includes(SHAPE)) { console.error('VHC_SCHEMA_SHAPE must be test or production'); process.exit(2); }
const PROD = SHAPE === 'production';
console.log('Schema shape: ' + SHAPE);
const require = createRequire(import.meta.url);
const { Client } = require(process.env.VHC_PG_MODULE || 'pg');
const dir = path.join(import.meta.dirname, '..', 'supabase', 'migrations');
const MIGRATION = fs.readFileSync(path.join(dir, '20261022000100_stock_correction_rpcs.sql'), 'utf8');
const BILL_MIGRATION = fs.readFileSync(path.join(dir, '20261015000100_v3193_apply_bill_stock_movement.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); } };
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
// Production shape roles: U1/U2 admin, U3 pharmacist, U4 viewer, U5 warehouse_manager, U6 signed in but no profile.
const U3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', U4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
  U5 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', U6 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
const ITEM = '11111111-1111-4111-8111-111111111111', ITEM2 = '11111111-1111-4111-8111-111111111112';
const PH = '33333333-3333-4333-8333-333333333331', WH = '33333333-3333-4333-8333-333333333332';
const B1 = '22222222-2222-4222-8222-222222222221', B2 = '22222222-2222-4222-8222-222222222222', BW = '22222222-2222-4222-8222-222222222223', BW2 = '22222222-2222-4222-8222-222222222224';
const key = (n) => `req-${String(n).padStart(4, '0')}-0123456789ab`;

const admin = new Client({ connectionString: url }); await admin.connect();
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
const call = (fnName, payload, uid = U1) => as(uid, async (c) => (await c.query(`select public.${fnName}($1::jsonb) r`, [JSON.stringify(payload)])).rows[0].r);
const qty = async (id) => Number((await q('select qty from public.stock_batches where id=$1', [id])).rows[0].qty);
const moves = async (where = 'true', p = []) => (await q(`select * from public.stock_movements where ${where} order by seq`, p)).rows;
const fingerprint = async () => JSON.stringify((await q(`select md5(coalesce((select string_agg(id||':'||qty, ',' order by id) from public.stock_batches),'')) b,
  md5(coalesce((select string_agg(t::text, '|' order by t.seq) from public.stock_movements t),'')) m,
  md5(coalesce((select string_agg(id||':'||status, ',' order by id) from public.transfer_orders),'')) t`)).rows[0]);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
// Shape-independent RLS denial: a RESTRICTIVE policy narrows whatever the shape's permissive policies allow.
const deny = (table, cmd, name) => q(`create policy ${name} on public.${table} as restrictive for ${cmd} to authenticated ${cmd === 'insert' ? 'with check (false)' : 'using (false)'}`);
const undeny = (table, name) => q(`drop policy ${name} on public.${table}`);

// Production RLS, verbatim from pg_policies / pg_get_functiondef (read-only, 2026-10-22).
const PROD_RLS = `
create table public.profiles (id uuid primary key, role text);
insert into public.profiles values ('${U1}', 'admin'), ('${U2}', 'admin'), ('${U3}', 'pharmacist'), ('${U4}', 'viewer'), ('${U5}', 'warehouse_manager');
CREATE OR REPLACE FUNCTION public.current_role_name() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select role from public.profiles where id = auth.uid(); $function$;
CREATE OR REPLACE FUNCTION public.is_known_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager', 'pharmacist', 'viewer'); $function$;
CREATE OR REPLACE FUNCTION public.is_pharmacy_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'pharmacist'); $function$;
CREATE OR REPLACE FUNCTION public.is_warehouse_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager'); $function$;
do $$ declare t text; begin
  foreach t in array array['locations','items','stock_batches','stock_movements','transfer_orders','transfer_order_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant all on public.%I to authenticated, service_role', t);
  end loop; end $$;
-- Production default privileges give anon/authenticated EXECUTE on every new public function: the migration's own
-- revoke must remove anon's.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant select, insert, update, delete on public.stock_movements, public.transfer_orders, public.transfer_order_items to anon;
grant select on public.items, public.stock_batches to anon;
create policy items_insert_pharmacy on public.items for insert with check (is_pharmacy_writer());
create policy items_select_anon on public.items for select to anon using (true);
create policy items_select_known on public.items for select using (is_known_user());
create policy items_write_warehouse on public.items for all using (is_warehouse_writer()) with check (is_warehouse_writer());
create policy locations_select_known on public.locations for select using (is_known_user());
create policy locations_write_warehouse on public.locations for all using (is_warehouse_writer()) with check (is_warehouse_writer());
create policy stock_batches_select_anon on public.stock_batches for select to anon using (true);
create policy stock_batches_select_known on public.stock_batches for select using (is_known_user());
create policy stock_batches_write_warehouse_or_pharmacy on public.stock_batches for all using (is_warehouse_writer() OR is_pharmacy_writer()) with check (is_warehouse_writer() OR is_pharmacy_writer());
create policy stock_movements_insert_pharmacy_or_warehouse on public.stock_movements for insert with check (is_pharmacy_writer() OR is_warehouse_writer());
create policy stock_movements_select_known on public.stock_movements for select using (is_known_user());
create policy to_items_select_known on public.transfer_order_items for select using (is_known_user());
create policy to_items_write_warehouse on public.transfer_order_items for all using (is_warehouse_writer()) with check (is_warehouse_writer());
create policy to_select_known on public.transfer_orders for select using (is_known_user());
create policy to_write_warehouse on public.transfer_orders for all using (is_warehouse_writer()) with check (is_warehouse_writer());`;
await q(`drop schema if exists public cascade; drop schema if exists auth cascade; create schema public; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
insert into auth.users values ('${U1}'), ('${U2}'), ('${U3}'), ('${U4}'), ('${U5}'), ('${U6}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
create table public.locations (id uuid primary key, name text not null, type text not null, ${PROD ? 'color text, ' : ''}created_at timestamptz not null default now());
create table public.items (id uuid primary key, name text not null);
create table public.stock_batches (id uuid primary key default gen_random_uuid(), item_id uuid not null references public.items(id),
  location_id uuid not null references public.locations(id), batch_no text, expiry_date date, mrp numeric, net_rate numeric, gst numeric,
  stockist text, qty numeric not null default 0, ${PROD ? '' : 'created_at timestamptz not null default now(), '}updated_at timestamptz not null default now());
create table public.stock_movements (id uuid primary key default gen_random_uuid(), seq ${PROD ? 'bigint generated always as identity' : 'bigint not null'},
  movement_key text, item_id uuid references public.items(id), location_id uuid references public.locations(id), batch_no text,
  type text not null, qty numeric not null, opening numeric, closing numeric, bill_id text, patient_id uuid, ${PROD ? '' : 'patient_name text, '}
  reason text, created_at timestamptz not null default now(), created_by uuid references auth.users(id),
  constraint stock_movements_type_check check (type = any (array['BILL','RESTORE','EDIT','RECEIVE','TRANSFER','ADJUST','RETURN'])));
create unique index stock_movements_movement_key_uq on public.stock_movements (movement_key) where movement_key is not null;
create unique index stock_movements_seq_uq on public.stock_movements (seq);
${PROD ? '' : `-- TEST's real seq allocation, verbatim (read-only from dvscemgqegmfmgrtytal 2026-10-22): owned sequence + a
-- SECURITY DEFINER trigger that takes a GLOBAL advisory lock on every movement insert.
create sequence public.stock_movements_seq_alloc_seq owned by public.stock_movements.seq;
grant usage, select on sequence public.stock_movements_seq_alloc_seq to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.vhc_stock_movements_assign_seq()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_sequence regclass := pg_get_serial_sequence('public.stock_movements', 'seq')::regclass;
  v_last_seq bigint;
  v_is_called boolean;
begin
  perform pg_advisory_xact_lock(19360721, 3182);
  if new.seq is null then
    new.seq := nextval(v_sequence);
  else
    if exists (select 1 from public.stock_movements where seq = new.seq) then
      raise unique_violation using message = format('stock_movements.seq %s already exists', new.seq);
    end if;
    execute format('select last_value, is_called from %s', v_sequence) into v_last_seq, v_is_called;
    if new.seq > 0 and (not v_is_called or new.seq > v_last_seq) then
      perform setval(v_sequence, new.seq, true);
    end if;
  end if;
  return new;
end;
$function$;
CREATE TRIGGER stock_movements_assign_seq_before_insert BEFORE INSERT ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION vhc_stock_movements_assign_seq();`}
create table public.transfer_orders (id uuid primary key, transfer_number text not null unique, from_location_id uuid, to_location_id uuid,
  status text not null default 'Completed', created_at timestamptz not null default now()${PROD ? ', transfer_date date, notes text' : ''});
create table public.transfer_order_items (id uuid primary key, transfer_order_id uuid not null references public.transfer_orders(id) on delete cascade,
  item_id uuid references public.items(id), name text not null, batch_no text, expiry_date date, qty numeric not null default 0, mrp numeric, net_rate numeric${PROD ? `,
  units_per_pack numeric, transfer_unit text check (transfer_unit = any (array['strips','units']))` : ''});
${PROD ? PROD_RLS : `do $$ declare t text; begin
  foreach t in array array['locations','items','stock_batches','stock_movements','transfer_orders','transfer_order_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy vhc_test_authenticated_all on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('grant all on public.%I to authenticated, service_role', t);
  end loop; end $$;
-- TEST's is_pharmacy_writer (verbatim body: select auth.role() = 'authenticated').
create or replace function public.is_pharmacy_writer() returns boolean language sql stable set search_path to 'public' as $function$select auth.role() = 'authenticated'$function$;`}`);
await q(`insert into public.locations (id, name, type) values ('${PH}', 'VHC Pharmacy Counter', 'pharmacy_counter'), ('${WH}', 'Main', 'warehouse_main');
insert into public.items values ('${ITEM}', 'TEST Paracetamol'), ('${ITEM2}', 'TEST Combo');
insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values
  ('${B1}', '${ITEM}', '${PH}', 'B-1', 25), ('${B2}', '${ITEM}', '${PH}', 'B-2', 10.5),
  ('${BW}', '${ITEM}', '${WH}', 'B-1', 100), ('${BW2}', '${ITEM2}', '${WH}', 'C-1', 3);
insert into public.stock_movements (item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason, movement_key)
  values ('${ITEM}', '${PH}', 'B-1', 'BILL', -1, 26, 25, 'BILL-OLD', 'historical row', 'VHC:BILL:BILL-OLD:m1');`);
await q(BILL_MIGRATION);
const billDef = async () => (await q(`select md5(pg_get_functiondef('public.apply_bill_stock_movement(jsonb)'::regprocedure)) d`)).rows[0].d;

console.log('Deployment');
const billBefore = await billDef(), fpBefore = await fingerprint();
await q(MIGRATION); await q(MIGRATION);
ok('migration applies twice (re-runnable)', true);
ok('deployment changes no batch, movement or transfer row', fpBefore === (await fingerprint()));
ok('apply_bill_stock_movement definition unchanged by deployment', billBefore === (await billDef()));
const g = (await q(`select has_function_privilege('anon','public.apply_stock_correction(jsonb)','execute') a1, has_function_privilege('authenticated','public.apply_stock_correction(jsonb)','execute') a2,
  has_function_privilege('anon','public.apply_stock_restore(jsonb)','execute') a3, has_function_privilege('anon','public.accept_pharmacy_transfer(jsonb)','execute') a4,
  has_function_privilege('authenticated','public.accept_pharmacy_transfer(jsonb)','execute') a5, has_function_privilege('authenticated','public.apply_stock_restore(jsonb)','execute') a6`)).rows[0];
ok('authenticated may execute; anon may not (all three)', g.a2 && g.a5 && g.a6 && !g.a1 && !g.a3 && !g.a4, JSON.stringify(g));

console.log('1. positive and negative corrections / 11. ledger continuity / 9. actor');
let r = await call('apply_stock_correction', { request_key: key(1), stock_batch_id: B1, expected_qty: 25, new_qty: 30, reason: 'Physical count 22-Oct: 5 strips found in back shelf', created_by: U2 });
ok('positive: APPLIED 25 -> 30', r.status === 'APPLIED' && Number(r.opening) === 25 && Number(r.closing) === 30, JSON.stringify(r));
r = await call('apply_stock_correction', { request_key: key(2), stock_batch_id: B1, expected_qty: 30, new_qty: 27.5, reason: 'Damaged: 2.5 strips water-damaged' });
ok('negative + fractional: APPLIED 30 -> 27.5', r.status === 'APPLIED' && Number(r.closing) === 27.5);
ok('batch quantity is 27.5', (await qty(B1)) === 27.5);
let m = await moves(`type='EDIT'`);
ok('two EDIT movements with signed deltas +5 and -2.5', m.length === 2 && Number(m[0].qty) === 5 && Number(m[1].qty) === -2.5);
ok('ledger continuity: next opening == previous closing; opening + qty == closing', Number(m[1].opening) === Number(m[0].closing) && m.every((x) => Math.abs(Number(x.opening) + Number(x.qty) - Number(x.closing)) < 1e-9));
ok('created_by = session user; a created_by in the payload is ignored', m.every((x) => x.created_by === U1));
ok('movement key = VHC:EDIT:<request_key>', m[0].movement_key === 'VHC:EDIT:' + key(1));
ok('movement created_at == batch updated_at (one consistent timestamp)', (await q(`select (select updated_at from public.stock_batches where id=$1) = (select created_at from public.stock_movements where movement_key=$2) e`, [B1, 'VHC:EDIT:' + key(2)])).rows[0].e);

console.log('2. stale opening rejected');
let fp = await fingerprint();
r = await call('apply_stock_correction', { request_key: key(3), stock_batch_id: B1, expected_qty: 25, new_qty: 20, reason: 'Recount after audit' });
ok('CONFLICT_STALE_OPENING reports current qty', r.status === 'CONFLICT_STALE_OPENING' && Number(r.current_qty) === 27.5, JSON.stringify(r));
ok('nothing changed', fp === (await fingerprint()));

console.log('4. duplicate request key');
r = await call('apply_stock_correction', { request_key: key(2), stock_batch_id: B1, expected_qty: 30, new_qty: 27.5, reason: 'Damaged: 2.5 strips water-damaged' });
ok('same key + same content -> ALREADY_APPLIED (not stale), no new row', r.status === 'ALREADY_APPLIED' && (await moves(`type='EDIT'`)).length === 2, JSON.stringify(r));
r = await call('apply_stock_correction', { request_key: key(2), stock_batch_id: B1, expected_qty: 27.5, new_qty: 26, reason: 'Different change entirely' });
ok('same key + different content -> CONFLICT_REQUEST_KEY_REUSED, nothing changed', r.status === 'CONFLICT_REQUEST_KEY_REUSED' && (await qty(B1)) === 27.5);
for (const bad of ['', 'short', 'x'.repeat(81), 'bad key with spaces!!']) {
  const e = await rejects(call('apply_stock_correction', { request_key: bad, stock_batch_id: B1, expected_qty: 27.5, new_qty: 26, reason: 'Recount' }));
  ok(`invalid request_key "${bad.slice(0, 12)}" rejected`, !!e && /request_key/.test(e), e);
}

console.log('3. two concurrent corrections on the same batch');
const c1 = new Client({ connectionString: url }), c2 = new Client({ connectionString: url }); await c1.connect(); await c2.connect();
const sql = 'select public.apply_stock_correction($1::jsonb) r';
await begin(c1, U1); await begin(c2, U1);
const r1 = await c1.query(sql, [JSON.stringify({ request_key: key(10), stock_batch_id: B1, expected_qty: 27.5, new_qty: 40, reason: 'Concurrent A recount' })]);
const p2 = c2.query(sql, [JSON.stringify({ request_key: key(11), stock_batch_id: B1, expected_qty: 27.5, new_qty: 12, reason: 'Concurrent B recount' })]);
await new Promise((res) => setTimeout(res, 300));
const blocked = (await q(`select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and query like '%apply_stock_correction%'`)).rows[0].n;
ok('second session is blocked on the batch row lock while the first is open', blocked >= 1, 'waiting=' + blocked);
await c1.query('commit'); const r2 = await p2; await c2.query('commit');
ok('first APPLIED; second sees 40 and returns CONFLICT_STALE_OPENING (no lost update)', r1.rows[0].r.status === 'APPLIED' && r2.rows[0].r.status === 'CONFLICT_STALE_OPENING' && Number(r2.rows[0].r.current_qty) === 40, JSON.stringify(r2.rows[0].r));
ok('final qty 40; exactly one movement from the race', (await qty(B1)) === 40 && (await moves(`movement_key in ($1,$2)`, ['VHC:EDIT:' + key(10), 'VHC:EDIT:' + key(11)])).length === 1);
await begin(c1, U1); await begin(c2, U1);
const same = JSON.stringify({ request_key: key(12), stock_batch_id: B1, expected_qty: 40, new_qty: 41, reason: 'Double submit recount' });
const s1 = await c1.query(sql, [same]); const s2p = c2.query(sql, [same]);
await new Promise((res) => setTimeout(res, 300)); await c1.query('commit'); const s2 = await s2p; await c2.query('commit');
ok('same request key from two sessions at once: APPLIED then ALREADY_APPLIED; applied once', s1.rows[0].r.status === 'APPLIED' && s2.rows[0].r.status === 'ALREADY_APPLIED' && (await qty(B1)) === 41 && (await moves('movement_key=$1', ['VHC:EDIT:' + key(12)])).length === 1, JSON.stringify(s2.rows[0].r));
await c1.end(); await c2.end();

console.log('5. failure during the movement insert rolls back the quantity');
await q(`create function public.qa_fail_inject() returns trigger language plpgsql as $$ begin if new.reason like '%INJECT-FAIL%' then raise exception 'injected movement failure'; end if; return new; end $$;
  create trigger qa_fail_inject before insert on public.stock_movements for each row execute function public.qa_fail_inject();`);
fp = await fingerprint();
let e = await rejects(call('apply_stock_correction', { request_key: key(20), stock_batch_id: B1, expected_qty: 41, new_qty: 1, reason: 'Recount INJECT-FAIL' }));
ok('EDIT: failure surfaced as an error', !!e && /injected/.test(e), e);
ok('EDIT: batch still 41, no movement (both rolled back)', (await qty(B1)) === 41 && fp === (await fingerprint()));
e = await rejects(call('apply_stock_restore', { bill_id: 'BILL-FAIL', stock_batch_id: B2, quantity_delta: 2, reason: 'Bill deleted INJECT-FAIL' }));
ok('RESTORE: failure surfaced and nothing changed', !!e && fp === (await fingerprint()));
await q(`drop trigger qa_fail_inject on public.stock_movements; drop function public.qa_fail_inject();`);

console.log('8. reasons');
let n = 30;
for (const bad of ['', '  ', 'UPDATE', 'update.', 'Stock Update', 'edit', 'n/a', 'ok', 'Correction', 'x'.repeat(501)]) {
  r = await call('apply_stock_correction', { request_key: key(n++), stock_batch_id: B1, expected_qty: 41, new_qty: 39, reason: bad });
  ok(`reason "${bad.slice(0, 14)}" -> REJECTED_REASON`, r.status === 'REJECTED_REASON', JSON.stringify(r).slice(0, 80));
}
ok('no change after rejected reasons', (await qty(B1)) === 41);
r = await call('apply_stock_correction', { request_key: key(45), stock_batch_id: B1, expected_qty: 41, new_qty: -1, reason: 'Recount negative' });
ok('negative quantity -> REJECTED_NEGATIVE_QTY', r.status === 'REJECTED_NEGATIVE_QTY');
r = await call('apply_stock_correction', { request_key: key(46), stock_batch_id: B1, expected_qty: 41, new_qty: 41, reason: 'Recount same value' });
ok('no-op -> NO_CHANGE and no movement', r.status === 'NO_CHANGE' && (await moves('movement_key=$1', ['VHC:EDIT:' + key(46)])).length === 0);

console.log('9. actor / authorization');
e = await rejects(call('apply_stock_correction', { request_key: key(50), stock_batch_id: B1, expected_qty: 41, new_qty: 40, reason: 'Recount without session' }, ''));
ok('no authenticated user -> rejected', !!e && /authenticated user/.test(e), e);
r = await call('apply_stock_correction', { request_key: key(51), stock_batch_id: B1, expected_qty: 41, new_qty: 40, reason: 'Recount by second user' }, U2);
ok('a different user is recorded as created_by', r.status === 'APPLIED' && (await moves('movement_key=$1', ['VHC:EDIT:' + key(51)]))[0].created_by === U2);
e = await rejects(as(U1, (c) => c.query(`select public.apply_stock_correction('{}'::jsonb)`), 'anon'));
ok('anon role cannot execute', !!e && /permission denied/.test(e), e);
// SECURITY INVOKER: the caller's own RLS decides, exactly like the direct writes these replace.
await deny('stock_batches', 'update', 'qa_no_update');
fp = await fingerprint();
r = await call('apply_stock_correction', { request_key: key(52), stock_batch_id: B1, expected_qty: 40, new_qty: 39, reason: 'Recount without update right' });
ok('EDIT: readable batch whose RLS forbids UPDATE -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
r = await call('apply_stock_restore', { bill_id: 'BILL-RLS', stock_batch_id: B2, quantity_delta: 1, reason: 'Bill deleted — stock restored' });
ok('RESTORE: same -> NOT_PERMITTED, nothing changed (no privilege widening)', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('stock_batches', 'qa_no_update');
// A row the caller cannot READ is reported as not found: NOT_PERMITTED never discloses that it exists.
await deny('stock_batches', 'select', 'qa_no_read');
r = await call('apply_stock_correction', { request_key: key(54), stock_batch_id: B1, expected_qty: 40, new_qty: 39, reason: 'Recount on an invisible batch' });
ok('EDIT: unreadable batch -> CONFLICT_BATCH_NOT_FOUND (existence not disclosed), nothing changed', r.status === 'CONFLICT_BATCH_NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
r = await call('apply_stock_restore', { bill_id: 'BILL-RLS', stock_batch_id: B2, quantity_delta: 1, reason: 'Bill deleted — stock restored' });
ok('RESTORE: unreadable batch -> CONFLICT_BATCH_NOT_FOUND, nothing changed', r.status === 'CONFLICT_BATCH_NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('stock_batches', 'qa_no_read');
// The row can be locked and updated but the ledger insert is refused: the stock change must roll back too.
await deny('stock_movements', 'insert', 'qa_no_ledger');
fp = await fingerprint();
r = await call('apply_stock_correction', { request_key: key(53), stock_batch_id: B1, expected_qty: 40, new_qty: 39, reason: 'Recount without ledger right' });
ok('EDIT: movement insert refused by RLS -> NOT_PERMITTED and the qty update is rolled back', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
r = await call('apply_stock_restore', { bill_id: 'BILL-RLS2', stock_batch_id: B2, quantity_delta: 1, reason: 'Bill deleted — stock restored' });
ok('RESTORE: movement insert refused -> NOT_PERMITTED and the qty update is rolled back', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('stock_movements', 'qa_no_ledger');
const notWriter = (await q(`select prosecdef from pg_proc where proname in ('apply_stock_correction','apply_stock_restore','accept_pharmacy_transfer')`)).rows;
ok('all three functions are SECURITY INVOKER', notWriter.length === 3 && notWriter.every((x) => x.prosecdef === false));

console.log('10. exact batch targeting');
const b2Before = await qty(B2), bwBefore = await qty(BW);
r = await call('apply_stock_correction', { request_key: key(60), stock_batch_id: B1, expected_qty: 40, new_qty: 38, reason: 'Recount exact batch' });
ok('only the named batch changed (same item other batch + warehouse batch untouched)', r.status === 'APPLIED' && (await qty(B2)) === b2Before && (await qty(BW)) === bwBefore && (await qty(B1)) === 38);
r = await call('apply_stock_correction', { request_key: key(61), stock_batch_id: BW, expected_qty: 100, new_qty: 90, reason: 'Recount warehouse' });
ok('warehouse batch refused (CONFLICT_NOT_PHARMACY_BATCH)', r.status === 'CONFLICT_NOT_PHARMACY_BATCH' && (await qty(BW)) === 100);
r = await call('apply_stock_correction', { request_key: key(62), stock_batch_id: '22222222-2222-4222-8222-999999999999', expected_qty: 1, new_qty: 2, reason: 'Recount missing batch' });
ok('unknown batch -> CONFLICT_BATCH_NOT_FOUND', r.status === 'CONFLICT_BATCH_NOT_FOUND');

console.log('RESTORE (bill delete)');
r = await call('apply_stock_restore', { bill_id: 'BILL-9', stock_batch_id: B2, quantity_delta: 2, reason: 'Bill deleted — stock restored to inventory', patient_id: null });
ok('APPLIED 10.5 -> 12.5', r.status === 'APPLIED' && (await qty(B2)) === 12.5, JSON.stringify(r));
const rm = (await moves('movement_key=$1', ['VHC:RESTORE:BILL-9:' + B2]))[0];
ok('RESTORE movement: type, bill id, +2, created_by', rm && rm.type === 'RESTORE' && rm.bill_id === 'BILL-9' && Number(rm.qty) === 2 && rm.created_by === U1);
r = await call('apply_stock_restore', { bill_id: 'BILL-9', stock_batch_id: B2, quantity_delta: 2, reason: 'Bill deleted — stock restored to inventory' });
ok('same bill + batch again -> ALREADY_APPLIED; restored once', r.status === 'ALREADY_APPLIED' && (await qty(B2)) === 12.5);
r = await call('apply_stock_restore', { bill_id: 'BILL-9', stock_batch_id: B2, quantity_delta: 3, reason: 'Bill deleted — stock restored to inventory' });
ok('same bill + batch, different qty -> CONFLICT_MOVEMENT_MISMATCH', r.status === 'CONFLICT_MOVEMENT_MISMATCH' && (await qty(B2)) === 12.5);
e = await rejects(call('apply_stock_restore', { bill_id: 'BILL-10', stock_batch_id: B2, quantity_delta: -1, reason: 'Bill deleted' }));
ok('non-positive restore rejected', !!e);
r = await call('apply_stock_restore', { bill_id: 'BILL-11', stock_batch_id: BW, quantity_delta: 1, reason: 'Bill deleted — stock restored' });
ok('warehouse batch refused for RESTORE', r.status === 'CONFLICT_NOT_PHARMACY_BATCH');
// Legacy (pre-fix) restore rows have no movement_key: the same bill + batch must not be restored a second time.
await q(`insert into public.stock_movements (item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason)
  values ('${ITEM}', '${PH}', 'B-2', 'RESTORE', 3, 9, 12, 'BILL-LEGACY', 'Bill deleted (old app)'),
         ('${ITEM}', '${PH}', 'B-2', 'RETURN', 1, 12, 13, 'BILL-RET', 'Sale return stock restoration')`);
fp = await fingerprint();
r = await call('apply_stock_restore', { bill_id: 'BILL-LEGACY', stock_batch_id: B2, quantity_delta: 3, reason: 'Bill deleted — stock restored to inventory' });
ok('legacy un-keyed RESTORE for same bill+batch -> ALREADY_APPLIED (legacy), nothing changed', r.status === 'ALREADY_APPLIED' && r.legacy === true && fp === (await fingerprint()), JSON.stringify(r));
r = await call('apply_stock_restore', { bill_id: 'BILL-LEGACY', stock_batch_id: B2, quantity_delta: 5, reason: 'Bill deleted — stock restored to inventory' });
ok('legacy RESTORE with a different qty -> CONFLICT_MOVEMENT_MISMATCH, nothing changed', r.status === 'CONFLICT_MOVEMENT_MISMATCH' && fp === (await fingerprint()));
const b2r = await qty(B2);
r = await call('apply_stock_restore', { bill_id: 'BILL-RET', stock_batch_id: B2, quantity_delta: 2, reason: 'Bill deleted — stock restored to inventory' });
ok('a sale RETURN for the same bill does not block a legitimate bill-delete restore', r.status === 'APPLIED' && (await qty(B2)) === b2r + 2, JSON.stringify(r));
r = await call('apply_stock_restore', { bill_id: 'BILL-9', stock_batch_id: B1, quantity_delta: 2, reason: 'Bill deleted — stock restored to inventory' });
ok('same bill, OTHER batch is still restored (key is bill + batch)', r.status === 'APPLIED');

console.log('TRANSFER accept');
const T1 = '44444444-4444-4444-8444-444444444441', T2 = '44444444-4444-4444-8444-444444444442';
await q(`insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values
  ('${T1}', 'TR-1', '${WH}', '${PH}', 'Pending'), ('${T2}', 'TR-2', '${WH}', '${PH}', 'Pending');
  insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty) values
  ('55555555-5555-4555-8555-555555555551', '${T1}', '${ITEM}', 'TEST Paracetamol', 'B-1', 10),
  ('55555555-5555-4555-8555-555555555552', '${T1}', '${ITEM2}', 'TEST Combo', 'C-1', 5),
  ('55555555-5555-4555-8555-555555555553', '${T2}', '${ITEM}', 'TEST Paracetamol', 'B-1', 10),
  ('55555555-5555-4555-8555-555555555554', '${T2}', '${ITEM2}', 'TEST Combo', 'C-1', 2);`);
fp = await fingerprint();
r = await call('accept_pharmacy_transfer', { transfer_id: T1 });
ok('insufficient 2nd line -> CONFLICT_INSUFFICIENT_STOCK', r.status === 'CONFLICT_INSUFFICIENT_STOCK' && r.name === 'TEST Combo', JSON.stringify(r));
ok('all-or-nothing: 1st line NOT moved; order still Pending', fp === (await fingerprint()));
const ph1 = await qty(B1);
r = await call('accept_pharmacy_transfer', { transfer_id: T2 });
ok('APPLIED with 2 lines', r.status === 'APPLIED' && r.lines === 2, JSON.stringify(r));
ok('warehouse 100 -> 90 and 3 -> 1; pharmacy B-1 +10', (await qty(BW)) === 90 && (await qty(BW2)) === 1 && (await qty(B1)) === ph1 + 10);
const newDst = (await q(`select qty from public.stock_batches where item_id=$1 and location_id=$2 and batch_no='C-1'`, [ITEM2, PH])).rows;
ok('missing pharmacy batch created with the transferred qty', newDst.length === 1 && Number(newDst[0].qty) === 2);
const tm = await moves(`movement_key like $1`, ['VHC:TRANSFER:' + T2 + '%']);
ok('4 TRANSFER movements (OUT/IN per line), actor recorded, opening + qty == closing',
  tm.length === 4 && tm.every((x) => x.type === 'TRANSFER' && x.created_by === U1 && Math.abs(Number(x.opening) + Number(x.qty) - Number(x.closing)) < 1e-9), JSON.stringify(tm.map((x) => [x.movement_key.slice(-6), x.qty])));
ok('order Completed', (await q('select status from public.transfer_orders where id=$1', [T2])).rows[0].status === 'Completed');
fp = await fingerprint();
r = await call('accept_pharmacy_transfer', { transfer_id: T2 });
ok('second accept -> ALREADY_COMPLETED; nothing changed', r.status === 'ALREADY_COMPLETED' && fp === (await fingerprint()));
e = await rejects(call('accept_pharmacy_transfer', { transfer_id: T1 }, ''));
ok('transfer without an authenticated user rejected', !!e && /authenticated user/.test(e));
// Concurrent accepts of the same order: exactly one applies.
await q(`update public.stock_batches set qty = 50 where id = '${BW2}'`);
const c3 = new Client({ connectionString: url }), c4 = new Client({ connectionString: url }); await c3.connect(); await c4.connect();
await begin(c3, U1); await begin(c4, U2);
const tq = 'select public.accept_pharmacy_transfer($1::jsonb) r', tp = JSON.stringify({ transfer_id: T1 });
const a1 = await c3.query(tq, [tp]); const a2p = c4.query(tq, [tp]);
await new Promise((res) => setTimeout(res, 300)); await c3.query('commit'); const a2 = await a2p; await c4.query('commit');
ok('two concurrent accepts: APPLIED then ALREADY_COMPLETED', a1.rows[0].r.status === 'APPLIED' && a2.rows[0].r.status === 'ALREADY_COMPLETED', JSON.stringify([a1.rows[0].r.status, a2.rows[0].r.status]));
ok('warehouse deducted once for that order', (await qty(BW2)) === 45 && (await moves(`movement_key like $1`, ['VHC:TRANSFER:' + T1 + '%'])).length === 4);
await c3.end(); await c4.end();
// SECURITY INVOKER keeps the caller's RLS: with UPDATE no longer permitted on stock_batches, an accept must fail
// and change nothing (the row-count checks stop a ledger row from being written without its stock change).
const T3 = '44444444-4444-4444-8444-444444444443';
await q(`insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values ('${T3}', 'TR-3', '${WH}', '${PH}', 'Pending');
  insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty) values ('55555555-5555-4555-8555-555555555555', '${T3}', '${ITEM}', 'TEST Paracetamol', 'B-1', 1);`);
await deny('stock_batches', 'update', 'qa_no_update');
fp = await fingerprint();
r = await call('accept_pharmacy_transfer', { transfer_id: T3 });
ok('TRANSFER: RLS forbids the batch UPDATE -> NOT_PERMITTED; status update rolled back, nothing changed', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('stock_batches', 'qa_no_update');
await deny('transfer_orders', 'update', 'qa_no_order_update');
r = await call('accept_pharmacy_transfer', { transfer_id: T3 });
ok('TRANSFER: readable order the caller may not update -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && r.transfer_number === 'TR-3' && fp === (await fingerprint()), JSON.stringify(r));
r = await call('accept_pharmacy_transfer', { transfer_id: T2 });
ok('TRANSFER: same caller on a Completed order still gets ALREADY_COMPLETED (a status it can read)', r.status === 'ALREADY_COMPLETED' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('transfer_orders', 'qa_no_order_update');
await deny('transfer_orders', 'select', 'qa_no_order_read');
r = await call('accept_pharmacy_transfer', { transfer_id: T3 });
ok('TRANSFER: order the caller cannot read -> NOT_FOUND (existence not disclosed), nothing changed', r.status === 'NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('transfer_orders', 'qa_no_order_read');

// Two accepts that both need to CREATE the same pharmacy batch must not create it twice.
const ITEM3 = '11111111-1111-4111-8111-111111111113', BW3 = '22222222-2222-4222-8222-222222222225';
const T4 = '44444444-4444-4444-8444-444444444444', T5 = '44444444-4444-4444-8444-444444444445';
await q(`insert into public.items values ('${ITEM3}', 'TEST New Item');
  insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values ('${BW3}', '${ITEM3}', '${WH}', 'N-1', 50);
  insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values ('${T4}', 'TR-4', '${WH}', '${PH}', 'Pending'), ('${T5}', 'TR-5', '${WH}', '${PH}', 'Pending');
  insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty) values
   ('55555555-5555-4555-8555-555555555556', '${T4}', '${ITEM3}', 'TEST New Item', 'N-1', 4),
   ('55555555-5555-4555-8555-555555555557', '${T5}', '${ITEM3}', 'TEST New Item', 'N-1', 6);`);
const c5 = new Client({ connectionString: url }), c6 = new Client({ connectionString: url }); await c5.connect(); await c6.connect();
await begin(c5, U1); await begin(c6, U2);
const x1 = await c5.query(tq, [JSON.stringify({ transfer_id: T4 })]);
const x2p = c6.query(tq, [JSON.stringify({ transfer_id: T5 })]);
await new Promise((res) => setTimeout(res, 300));
const waitingAdv = (await q(`select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and query like '%accept_pharmacy_transfer%'`)).rows[0].n;
await c5.query('commit'); const x2 = await x2p; await c6.query('commit'); await c5.end(); await c6.end();
const dup = (await q(`select qty from public.stock_batches where item_id=$1 and location_id=$2 and batch_no='N-1'`, [ITEM3, PH])).rows;
ok('concurrent accepts creating the same new batch: second waits, then adds to it (one batch, 4 + 6 = 10)',
  x1.rows[0].r.status === 'APPLIED' && x2.rows[0].r.status === 'APPLIED' && waitingAdv >= 1 && dup.length === 1 && Number(dup[0].qty) === 10, JSON.stringify({ waitingAdv, dup }));

console.log('TRANSFER: unknown, rejected, rollback, new-batch permission');
const T6 = '44444444-4444-4444-8444-444444444446', T7 = '44444444-4444-4444-8444-444444444447', T8 = '44444444-4444-4444-8444-444444444448';
const T9 = '44444444-4444-4444-8444-444444444449', BW4 = '22222222-2222-4222-8222-222222222226';
await q(`insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values ('${BW4}', '${ITEM3}', '${WH}', 'N-2', 20);
  insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values
   ('${T6}', 'TR-6', '${WH}', '${PH}', 'Pending'), ('${T7}', 'TR-7', '${WH}', '${PH}', 'Rejected'),
   ('${T8}', 'TR-8', '${WH}', '${PH}', 'Pending'), ('${T9}', 'TR-9', '${WH}', '${PH}', 'Pending');
  insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty) values
   ('55555555-5555-4555-8555-555555555558', '${T6}', '${ITEM}', 'TEST Paracetamol', 'B-1', 1),
   ('55555555-5555-4555-8555-555555555559', '${T7}', '${ITEM}', 'TEST Paracetamol', 'B-1', 1),
   ('55555555-5555-4555-8555-55555555555a', '${T8}', '${ITEM}', 'TEST Paracetamol', 'B-1', 2),
   ('55555555-5555-4555-8555-55555555555b', '${T8}', '${ITEM2}', 'TEST Combo', 'C-1', 1),
   ('55555555-5555-4555-8555-55555555555c', '${T9}', '${ITEM3}', 'TEST New Item', 'N-2', 3);`);
fp = await fingerprint();
r = await call('accept_pharmacy_transfer', { transfer_id: '44444444-4444-4444-8444-999999999999' });
ok('unknown transfer -> NOT_FOUND, nothing changed', r.status === 'NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
r = await call('accept_pharmacy_transfer', { transfer_id: T7 });
ok('rejected transfer -> NOT_PENDING (current_status Rejected), nothing changed', r.status === 'NOT_PENDING' && r.current_status === 'Rejected' && fp === (await fingerprint()), JSON.stringify(r));
// Rollback: the 2nd line's IN movement fails after the status update and the 1st line's moves were written.
await q(`create function public.qa_fail_transfer() returns trigger language plpgsql as $$ begin
  if new.movement_key like 'VHC:TRANSFER:${T8}:%5b:IN' then raise exception 'injected transfer failure'; end if; return new; end $$;
  create trigger qa_fail_transfer before insert on public.stock_movements for each row execute function public.qa_fail_transfer();`);
e = await rejects(call('accept_pharmacy_transfer', { transfer_id: T8 }));
ok('failure on the last write -> error; whole transfer rolled back (status Pending, no line moved, no movement)',
  !!e && /injected transfer failure/.test(e) && fp === (await fingerprint()) && (await q('select status from public.transfer_orders where id=$1', [T8])).rows[0].status === 'Pending', e);
await q(`drop trigger qa_fail_transfer on public.stock_movements; drop function public.qa_fail_transfer();`);
r = await call('accept_pharmacy_transfer', { transfer_id: T8 });
ok('after the fault is removed the same transfer applies once', r.status === 'APPLIED' && r.lines === 2, JSON.stringify(r));
// New pharmacy batch needed but the caller may not INSERT batches: RLS error inside Phase 2 -> NOT_PERMITTED, all rolled back.
fp = await fingerprint();
await deny('stock_batches', 'insert', 'qa_no_batch_insert');
r = await call('accept_pharmacy_transfer', { transfer_id: T9 });
ok('new destination batch refused by RLS -> NOT_PERMITTED; warehouse not deducted, order Pending', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
await undeny('stock_batches', 'qa_no_batch_insert');
r = await call('accept_pharmacy_transfer', { transfer_id: T9 });
const n2 = (await q(`select qty from public.stock_batches where item_id=$1 and location_id=$2 and batch_no='N-2'`, [ITEM3, PH])).rows;
ok('then APPLIED: new pharmacy batch created with only production columns (qty 3), warehouse 20 -> 17',
  r.status === 'APPLIED' && n2.length === 1 && Number(n2[0].qty) === 3 && (await qty(BW4)) === 17, JSON.stringify(r));

console.log('TRANSFER unit rule (same as VHC Mobile resolveAcceptedLine / stripsToUnits)');
const dq = async (qty, unit, upp) => (await q(`select public.vhc_transfer_dest_qty($1::numeric, $2::text, $3::numeric) d`, [qty, unit, upp])).rows[0].d;
ok('rule: 5 strips x 10/pack = 50 units', Number(await dq(5, 'strips', 10)) === 50);
ok('rule: entered in units (3.5 strips stored, 10/pack) = 35 units', Number(await dq(3.5, 'units', 10)) === 35);
ok('rule: 1 unit per pack = 1:1', Number(await dq(7, 'strips', 1)) === 7);
ok('rule: legacy line (no unit, no pack size) = 1:1', Number(await dq(2.5, null, null)) === 2.5);
ok('rule: unit without pack size -> refused (NULL)', (await dq(5, 'strips', null)) === null);
ok('rule: pack size without unit -> refused (NULL)', (await dq(5, null, 10)) === null);
ok('rule: unknown unit -> refused (NULL)', (await dq(5, 'boxes', 10)) === null && (await dq(5, '', 10)) === null && (await dq(5, 'Strips', 10)) === null);
ok('rule: zero / negative / NaN pack size -> refused (NULL)', (await dq(5, 'strips', 0)) === null && (await dq(5, 'units', -10)) === null && (await dq(5, 'strips', 'NaN')) === null);
const hd = (await q(`select prosecdef s, provolatile v, has_function_privilege('anon','public.vhc_transfer_dest_qty(numeric,text,numeric)','execute') a from pg_proc where proname='vhc_transfer_dest_qty'`)).rows[0];
ok('rule helper: immutable, invoker, anon cannot execute', hd && hd.s === false && hd.v === 'i' && hd.a === false, JSON.stringify(hd));
if (!PROD) {
  ok('TEST schema has no unit columns: every TEST line is a legacy 1:1 line (QA-E2E-style transfers above moved 1:1)', true);
} else {
  const ITEM4 = '11111111-1111-4111-8111-111111111114', ITEM5 = '11111111-1111-4111-8111-111111111115';
  const BU1 = '22222222-2222-4222-8222-2222222222a1', BU2 = '22222222-2222-4222-8222-2222222222a2', BU3 = '22222222-2222-4222-8222-2222222222a3';
  await q(`insert into public.items values ('${ITEM4}', 'TEST Unit Strip Item'), ('${ITEM5}', 'TEST Unit Vial Item');
    insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values
      ('${BU1}', '${ITEM4}', '${WH}', 'S-10', 100), ('${BU2}', '${ITEM5}', '${WH}', 'V-1', 40), ('${BU3}', '${ITEM4}', '${PH}', 'S-10', 7)`);
  const mkT = async (id, num, lines) => {
    await q(`insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values ($1, $2, '${WH}', '${PH}', 'Pending')`, [id, num]);
    for (const [lid, item, name, batch, qty, unit, upp] of lines)
      await q(`insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty, transfer_unit, units_per_pack) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [lid, id, item, name, batch, qty, unit, upp]);
  };
  const U = (n) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
  const L = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
  // 5 strips x 10 = 50 units into an EXISTING pharmacy batch (7 -> 57); warehouse 100 -> 95 strips.
  await mkT(U(1), 'TU-1', [[L(1), ITEM4, 'TEST Unit Strip Item', 'S-10', 5, 'strips', 10]]);
  r = await call('accept_pharmacy_transfer', { transfer_id: U(1) });
  let um = await moves(`movement_key like $1`, ['VHC:TRANSFER:' + U(1) + '%']);
  ok('5 strips x 10/pack: APPLIED, warehouse 100 -> 95 strips, pharmacy 7 -> 57 units', r.status === 'APPLIED' && (await qty(BU1)) === 95 && (await qty(BU3)) === 57, JSON.stringify(r));
  ok('ledger: OUT -5 (strips, 100->95), IN +50 (units, 7->57), balanced, actor, conversion noted in both reasons',
    um.length === 2 && Number(um[0].qty) === -5 && Number(um[0].opening) === 100 && Number(um[0].closing) === 95 &&
    Number(um[1].qty) === 50 && Number(um[1].opening) === 7 && Number(um[1].closing) === 57 && um.every((x) => x.created_by === U1 && /\[strips entered; 10\/pack conversion applied\]/.test(x.reason)),
    JSON.stringify(um.map((x) => [x.qty, x.opening, x.closing, x.reason])));
  // Entered in units: Mobile stores 3.5 strips for 35 units; pharmacy gets 35 units. Plus 1/pack vial (1:1, no note) and a legacy line in the SAME transfer.
  await mkT(U(2), 'TU-2', [[L(2), ITEM4, 'TEST Unit Strip Item', 'S-10', 3.5, 'units', 10], [L(3), ITEM5, 'TEST Unit Vial Item', 'V-1', 4, 'strips', 1], [L(4), ITEM, 'TEST Paracetamol', 'B-1', 2, null, null]]);
  const ph1b = await qty(B1), wh1b = await qty(BW);
  r = await call('accept_pharmacy_transfer', { transfer_id: U(2) });
  const vial = (await q(`select qty from public.stock_batches where item_id=$1 and location_id=$2`, [ITEM5, PH])).rows;
  um = await moves(`movement_key like $1`, ['VHC:TRANSFER:' + U(2) + '%']);
  ok('mixed transfer APPLIED: units-entered line 3.5 strips -> +35 units (57 -> 92); 1/pack vial 4 -> new batch 4; legacy line 2 -> +2 (1:1)',
    r.status === 'APPLIED' && r.lines === 3 && (await qty(BU1)) === 91.5 && (await qty(BU3)) === 92 && vial.length === 1 && Number(vial[0].qty) === 4 &&
    (await qty(B1)) === ph1b + 2 && (await qty(BW)) === wh1b - 2, JSON.stringify(r));
  ok('mixed transfer ledger: conversion note only on the 10/pack line; vial (1/pack) and legacy lines carry none',
    um.length === 6 && um.filter((x) => /conversion applied/.test(x.reason)).length === 2 && um.filter((x) => /\[units entered; 10\/pack/.test(x.reason)).length === 2, JSON.stringify(um.map((x) => [x.qty, x.reason.slice(-45)])));
  // Malformed lines are refused before any write.
  for (const [n, unit, upp, why] of [[5, 'strips', null, 'unit without pack size'], [6, null, 10, 'pack size without unit'], [7, 'strips', 0, 'zero pack size'], [8, 'units', -1, 'negative pack size']]) {
    await mkT(U(n), 'TU-' + n, [[L(n + 10), ITEM, 'TEST Paracetamol', 'B-1', 1, null, null], [L(n + 20), ITEM4, 'TEST Unit Strip Item', 'S-10', 1, unit, upp]]);
    fp = await fingerprint();
    r = await call('accept_pharmacy_transfer', { transfer_id: U(n) });
    ok(`malformed line (${why}) -> CONFLICT_TRANSFER_UNIT, nothing moved (not even the valid legacy line), still Pending`,
      r.status === 'CONFLICT_TRANSFER_UNIT' && r.name === 'TEST Unit Strip Item' && fp === (await fingerprint()), JSON.stringify(r));
  }
  e = await rejects(q(`insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty, transfer_unit, units_per_pack) values ('${L(99)}', '${U(5)}', '${ITEM4}', 'x', 'S-10', 1, 'boxes', 10)`));
  ok('unknown unit cannot even be stored (production CHECK strips|units); the rule refuses it anyway', !!e && /transfer_unit_check/.test(e), e);
  // Insufficient stock is judged in STRIPS (source native unit), not in converted units.
  await mkT(U(9), 'TU-9', [[L(30), ITEM4, 'TEST Unit Strip Item', 'S-10', 92, 'strips', 10]]);
  fp = await fingerprint();
  r = await call('accept_pharmacy_transfer', { transfer_id: U(9) });
  ok('insufficient warehouse strips (91.5 < 92) -> CONFLICT_INSUFFICIENT_STOCK in strips, nothing changed', r.status === 'CONFLICT_INSUFFICIENT_STOCK' && Number(r.available) === 91.5 && Number(r.needed) === 92 && fp === (await fingerprint()), JSON.stringify(r));
  // Duplicate and concurrent accept of a converted transfer: applied exactly once.
  await mkT(U(10), 'TU-10', [[L(31), ITEM4, 'TEST Unit Strip Item', 'S-10', 2, 'strips', 10]]);
  const ca = new Client({ connectionString: url }), cb = new Client({ connectionString: url }); await ca.connect(); await cb.connect();
  await begin(ca, U1); await begin(cb, U2);
  const k1 = await ca.query(tq, [JSON.stringify({ transfer_id: U(10) })]); const k2p = cb.query(tq, [JSON.stringify({ transfer_id: U(10) })]);
  await new Promise((res) => setTimeout(res, 300)); await ca.query('commit'); const k2 = await k2p; await cb.query('commit'); await ca.end(); await cb.end();
  r = await call('accept_pharmacy_transfer', { transfer_id: U(10) });
  ok('converted transfer: concurrent accepts -> APPLIED + ALREADY_COMPLETED, a third -> ALREADY_COMPLETED; moved once (89.5 strips, +20 units)',
    k1.rows[0].r.status === 'APPLIED' && k2.rows[0].r.status === 'ALREADY_COMPLETED' && r.status === 'ALREADY_COMPLETED' &&
    (await qty(BU1)) === 89.5 && (await qty(BU3)) === 112 && (await moves(`movement_key like $1`, ['VHC:TRANSFER:' + U(10) + '%'])).length === 2,
    JSON.stringify([k1.rows[0].r.status, k2.rows[0].r.status, r.status]));
  // Rollback: fail the converted line's IN ledger row (the last write) -> nothing at all changes.
  await mkT(U(11), 'TU-11', [[L(32), ITEM, 'TEST Paracetamol', 'B-1', 1, null, null], [L(33), ITEM4, 'TEST Unit Strip Item', 'S-10', 1, 'strips', 10]]);
  await q(`create function public.qa_fail_unit() returns trigger language plpgsql as $f$ begin if new.movement_key like 'VHC:TRANSFER:${U(11)}:${L(33)}:IN' then raise exception 'injected unit failure'; end if; return new; end $f$;
    create trigger qa_fail_unit before insert on public.stock_movements for each row execute function public.qa_fail_unit();`);
  fp = await fingerprint();
  e = await rejects(call('accept_pharmacy_transfer', { transfer_id: U(11) }));
  ok('failure on the converted line\'s IN row -> error, whole transfer rolled back (both lines), still Pending', !!e && /injected unit failure/.test(e) && fp === (await fingerprint()), e);
  await q(`drop trigger qa_fail_unit on public.stock_movements; drop function public.qa_fail_unit();`);
  r = await call('accept_pharmacy_transfer', { transfer_id: U(11) });
  ok('after the fault is removed: APPLIED once (88.5 strips, +10 units)', r.status === 'APPLIED' && (await qty(BU1)) === 88.5 && (await qty(BU3)) === 122, JSON.stringify(r));
}

if (PROD) {
  console.log('Production role matrix (verbatim production RLS)');
  const T10 = '44444444-4444-4444-8444-44444444444a';
  await q(`insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status) values ('${T10}', 'TR-10', '${WH}', '${PH}', 'Pending');
    insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty) values ('55555555-5555-4555-8555-55555555555d', '${T10}', '${ITEM}', 'TEST Paracetamol', 'B-1', 1);`);
  let cur = await qty(B1);
  r = await call('apply_stock_correction', { request_key: key(70), stock_batch_id: B1, expected_qty: cur, new_qty: cur + 1, reason: 'Pharmacist recount' }, U3);
  ok('pharmacist: EDIT APPLIED (allowed today by stock_batches + stock_movements policies)', r.status === 'APPLIED', JSON.stringify(r));
  cur = await qty(B1);
  r = await call('apply_stock_correction', { request_key: key(71), stock_batch_id: B1, expected_qty: cur, new_qty: cur - 1, reason: 'Warehouse manager recount' }, U5);
  ok('warehouse_manager: EDIT APPLIED (allowed today)', r.status === 'APPLIED', JSON.stringify(r));
  cur = await qty(B1); fp = await fingerprint();
  r = await call('apply_stock_correction', { request_key: key(72), stock_batch_id: B1, expected_qty: cur, new_qty: cur + 5, reason: 'Viewer attempt' }, U4);
  ok('viewer: EDIT -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('apply_stock_correction', { request_key: key(73), stock_batch_id: B1, expected_qty: cur, new_qty: cur + 5, reason: 'No-profile attempt' }, U6);
  ok('signed in without a profile: EDIT -> CONFLICT_BATCH_NOT_FOUND (cannot read; nothing disclosed), nothing changed', r.status === 'CONFLICT_BATCH_NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('apply_stock_restore', { bill_id: 'BILL-VIEW', stock_batch_id: B2, quantity_delta: 1, reason: 'Bill deleted — stock restored' }, U4);
  ok('viewer: RESTORE -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('apply_stock_restore', { bill_id: 'BILL-NOPROF', stock_batch_id: B2, quantity_delta: 1, reason: 'Bill deleted — stock restored' }, U6);
  ok('no profile: RESTORE -> CONFLICT_BATCH_NOT_FOUND, nothing changed', r.status === 'CONFLICT_BATCH_NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('accept_pharmacy_transfer', { transfer_id: T10 }, U3);
  ok('pharmacist: transfer accept -> NOT_PERMITTED (production lets only warehouse writers update transfer_orders — same as today), nothing changed',
    r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('accept_pharmacy_transfer', { transfer_id: T2 }, U3);
  ok('pharmacist on a Completed transfer -> ALREADY_COMPLETED', r.status === 'ALREADY_COMPLETED', JSON.stringify(r));
  r = await call('accept_pharmacy_transfer', { transfer_id: T10 }, U4);
  ok('viewer: transfer accept -> NOT_PERMITTED, nothing changed', r.status === 'NOT_PERMITTED' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('accept_pharmacy_transfer', { transfer_id: T10 }, U6);
  ok('no profile: transfer accept -> NOT_FOUND (cannot read; nothing disclosed), nothing changed', r.status === 'NOT_FOUND' && fp === (await fingerprint()), JSON.stringify(r));
  r = await call('accept_pharmacy_transfer', { transfer_id: T10 }, U5);
  ok('warehouse_manager: transfer accept APPLIED', r.status === 'APPLIED', JSON.stringify(r));
  e = await rejects(as(U1, (c) => c.query(`select public.accept_pharmacy_transfer('{}'::jsonb)`), 'anon'));
  ok('anon: cannot execute (despite production anon table grants)', !!e && /permission denied/.test(e), e);
} else {
  console.log('(production role matrix runs only with VHC_SCHEMA_SHAPE=production — TEST RLS lets every authenticated user write)');
}

console.log('12. existing BILL path unchanged');
const bBefore = await qty(B2);
r = await call('apply_bill_stock_movement', { movement_key: 'VHC:BILL:BILL-NEW:m1', bill_id: 'BILL-NEW', stock_batch_id: B2, quantity_delta: -1, expected_opening: bBefore });
ok('BILL APPLIED via the existing RPC', r.status === 'APPLIED' && (await qty(B2)) === bBefore - 1, JSON.stringify(r));
r = await call('apply_bill_stock_movement', { movement_key: 'VHC:BILL:BILL-NEW:m1', bill_id: 'BILL-NEW', stock_batch_id: B2, quantity_delta: -1, expected_opening: bBefore });
ok('BILL retry -> ALREADY_APPLIED (idempotency intact)', r.status === 'ALREADY_APPLIED' && (await qty(B2)) === bBefore - 1);
ok('historical movement untouched', (await moves('movement_key=$1', ['VHC:BILL:BILL-OLD:m1'])).length === 1);
ok('apply_bill_stock_movement definition still identical', billBefore === (await billDef()));

await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
