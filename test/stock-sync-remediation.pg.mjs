// Real-PostgreSQL proof for supabase/migrations/20261023000100_stock_sync_remediation.sql and its follow-up
// 20261023000200_restore_bill_stock_patient_fix.sql (T7: bill-delete restore vs the cloud patients FK).
// DISPOSABLE localhost database only (refuses anything else). Production-shaped schema + production RLS/role
// functions (verbatim from read-only inspection 2026-10-22/23); VHC_SCHEMA_SHAPE=test uses TEST's role rules
// (any authenticated user is a pharmacy writer, no is_warehouse_writer()).
//   VHC_TEST_PG_URL=postgres://postgres@localhost:55434/postgres VHC_PG_MODULE=<path to pg> node test/stock-sync-remediation.pg.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const url = process.env.VHC_TEST_PG_URL || '';
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error('Refusing: VHC_TEST_PG_URL must point at a disposable localhost database.');
  process.exit(2);
}
const SHAPE = process.env.VHC_SCHEMA_SHAPE || 'production';
const PROD = SHAPE === 'production';
console.log('Schema shape: ' + SHAPE);
const require = createRequire(import.meta.url);
const { Client } = require(process.env.VHC_PG_MODULE || 'pg');
const dir = path.join(import.meta.dirname, '..', 'supabase', 'migrations');
const BILL_MIG = fs.readFileSync(path.join(dir, '20261015000100_v3193_apply_bill_stock_movement.sql'), 'utf8');
const SC_MIG = fs.readFileSync(path.join(dir, '20261022000100_stock_correction_rpcs.sql'), 'utf8');
const MIG = fs.readFileSync(path.join(dir, '20261023000100_stock_sync_remediation.sql'), 'utf8');
const FIX = fs.readFileSync(path.join(dir, '20261023000200_restore_bill_stock_patient_fix.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); } };
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', PHARM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  VIEWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', WHM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
const ITEM = '11111111-1111-4111-8111-111111111111', ITEM2 = '11111111-1111-4111-8111-111111111112';
const PH = '33333333-3333-4333-8333-333333333331', WH = '33333333-3333-4333-8333-333333333332';
const B1 = '22222222-2222-4222-8222-222222222221', B2 = '22222222-2222-4222-8222-222222222222', B3 = '22222222-2222-4222-8222-222222222223';
const rk = (n) => `req-${String(n).padStart(4, '0')}-0123456789ab`;

const admin = new Client({ connectionString: url }); await admin.connect();
const second = new Client({ connectionString: url }); await second.connect();
const q = (sql, p) => admin.query(sql, p);
async function as(uid, fn, role = 'authenticated', client = admin) {
  await client.query('begin');
  await client.query(`set local role ${role}`);
  await client.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [uid || '', role]);
  try { const r = await fn(client); await client.query('commit'); return r; } catch (e) { await client.query('rollback'); throw e; }
}
const call = (fn, payload, uid = PHARM, client = admin) => as(uid, async (c) => (await c.query(`select public.${fn}($1::jsonb) r`, [JSON.stringify(payload)])).rows[0].r, 'authenticated', client);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const qty = async (id) => { const r = (await q('select qty from public.stock_batches where id=$1', [id])).rows[0]; return r ? Number(r.qty) : null; };
const mv = async (where, p = []) => (await q(`select * from public.stock_movements where ${where} order by seq`, p)).rows;
const fp = async () => JSON.stringify((await q(`select md5(coalesce((select string_agg(id||':'||qty, ',' order by id) from public.stock_batches),'')) b,
  md5(coalesce((select string_agg(t::text, '|' order by t.seq) from public.stock_movements t),'')) m`)).rows[0]);
const line = (bill, n, batch, delta, extra = {}) => ({ movement_key: `VHC:BILL:${bill}:m${n}`, stock_batch_id: batch, item_id: batch === B3 ? ITEM2 : ITEM, location_id: PH,
  batch_no: extra.batch_no, quantity_delta: delta, expected_opening: extra.expected_opening ?? null, ...extra });

await q(`drop schema if exists public cascade; drop schema if exists auth cascade; create schema public; create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
insert into auth.users values ('${ADMIN}'), ('${PHARM}'), ('${VIEWER}'), ('${WHM}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create table public.profiles (id uuid primary key, role text);
insert into public.profiles values ('${ADMIN}', 'admin'), ('${PHARM}', 'pharmacist'), ('${VIEWER}', 'viewer'), ('${WHM}', 'warehouse_manager');
CREATE FUNCTION public.current_role_name() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select role from public.profiles where id = auth.uid(); $function$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() = 'admin'; $function$;
CREATE FUNCTION public.is_known_user() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager', 'pharmacist', 'viewer'); $function$;
${PROD ? `CREATE FUNCTION public.is_pharmacy_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'pharmacist'); $function$;
CREATE FUNCTION public.is_warehouse_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select public.current_role_name() in ('admin', 'warehouse_manager'); $function$;`
  : `create function public.is_pharmacy_writer() returns boolean language sql stable set search_path to 'public' as $function$select auth.role() = 'authenticated'$function$;`}
create table public.locations (id uuid primary key, name text not null, type text not null, created_at timestamptz not null default now());
create table public.items (id uuid primary key, name text not null);
create table public.stock_batches (id uuid primary key default gen_random_uuid(), item_id uuid not null references public.items(id),
  location_id uuid not null references public.locations(id), batch_no text, expiry_date date, mrp numeric, net_rate numeric, gst numeric,
  stockist text, qty numeric not null default 0, updated_at timestamptz not null default now());
-- Cloud patients + the real FK (TEST and Production: stock_movements_patient_id_fkey FOREIGN KEY (patient_id)
-- REFERENCES patients(id), no ON DELETE action). RLS on with no policy: the restore must not depend on reading it.
create table public.patients (id uuid primary key, name text);
create table public.stock_movements (id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  movement_key text, item_id uuid references public.items(id), location_id uuid references public.locations(id), batch_no text,
  type text not null, qty numeric not null, opening numeric, closing numeric, bill_id text,
  patient_id uuid constraint stock_movements_patient_id_fkey references public.patients(id),
  reason text, created_at timestamptz not null default now(), created_by uuid references auth.users(id),
  constraint stock_movements_type_check check (type = any (array['BILL','RESTORE','EDIT','RECEIVE','TRANSFER','ADJUST','RETURN'])));
create unique index stock_movements_movement_key_uq on public.stock_movements (movement_key) where movement_key is not null;
create table public.sale_items (id uuid primary key default gen_random_uuid(), stock_batch_id uuid references public.stock_batches(id));
create table public.transfer_orders (id uuid primary key, transfer_number text, status text);
create table public.transfer_order_items (id uuid primary key, transfer_order_id uuid);
do $$ declare t text; begin
  foreach t in array array['locations','items','stock_batches','stock_movements','sale_items','transfer_orders','transfer_order_items','patients'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant all on public.%I to authenticated, service_role', t);
  end loop; end $$;
grant select on public.items, public.stock_batches to anon;
create policy items_select_known on public.items for select using (is_known_user());
create policy locations_select_known on public.locations for select using (is_known_user());
create policy stock_batches_select_anon on public.stock_batches for select to anon using (true);
create policy stock_batches_select_known on public.stock_batches for select using (is_known_user());
create policy stock_batches_write on public.stock_batches for all using (${PROD ? 'is_warehouse_writer() OR ' : ''}is_pharmacy_writer()) with check (${PROD ? 'is_warehouse_writer() OR ' : ''}is_pharmacy_writer());
create policy stock_movements_insert on public.stock_movements for insert with check (${PROD ? 'is_warehouse_writer() OR ' : ''}is_pharmacy_writer());
create policy stock_movements_select_known on public.stock_movements for select using (is_known_user());
create policy sale_items_all on public.sale_items for all using (true) with check (true);`);
await q(`insert into public.locations values ('${PH}', 'VHC Pharmacy Counter', 'pharmacy_counter'), ('${WH}', 'Main', 'warehouse_main');
insert into public.items values ('${ITEM}', 'TEST Paracetamol'), ('${ITEM2}', 'TEST Combo');
insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values
  ('${B1}', '${ITEM}', '${PH}', 'B-1', 20), ('${B2}', '${ITEM}', '${PH}', 'B-2', 5), ('${B3}', '${ITEM2}', '${PH}', 'C-1', 8);
insert into public.stock_movements (item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason, movement_key)
  values ('${ITEM}', '${PH}', 'B-1', 'BILL', -1, 21, 20, 'BILL-OLD', 'historical row', 'VHC:BILL:BILL-OLD:m1');`);
await q(BILL_MIG);
await q(SC_MIG);

console.log('Deployment');
// Duplicate identity present -> the whole migration aborts and nothing is created.
await q(`insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values (gen_random_uuid(), '${ITEM2}', '${PH}', ' c-1 ', 0)`);
const dupErr = await rejects(q('begin; ' + MIG + ' commit;'));
await q('rollback').catch(() => {});
ok('D1 duplicates present -> migration aborts with a clear message', /duplicate item\+location\+batch-number/.test(dupErr || ''), dupErr);
ok('D1 nothing created after the abort', (await q(`select to_regprocedure('public.apply_bill_stock_movements(jsonb)') f, to_regclass('public.stock_batches_identity_uq') i`)).rows.every((r) => !r.f && !r.i));
await q(`delete from public.stock_batches where batch_no = ' c-1 '`);
const before = await fp();
await q('begin; ' + MIG + ' commit;');
ok('D2 migration applies in one transaction', !!(await q(`select to_regprocedure('public.apply_bill_stock_movements(jsonb)') f`)).rows[0].f);
ok('D2 deployment changes no stock row or movement', (await fp()) === before);
await q('begin; ' + MIG + ' commit;');
ok('D3 re-running the migration is a no-op', (await fp()) === before);
const grants = (await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u,
  p.prosecdef d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  and p.proname in ('apply_bill_stock_movements','restore_bill_stock','create_stock_batch','delete_stock_batch','apply_bill_stock_movement')`)).rows;
ok('D4 five functions present', grants.length === 5, JSON.stringify(grants));
ok('D4 anon cannot execute any of them; authenticated can', grants.every((g) => !g.a && g.u), JSON.stringify(grants));
ok('D4 new functions are SECURITY INVOKER (legacy keeps DEFINER)', grants.every((g) => g.d === (g.proname === 'apply_bill_stock_movement')));
ok('D5 unique identity index exists', !!(await q(`select to_regclass('public.stock_batches_identity_uq') i`)).rows[0].i);
ok('D5 a direct duplicate insert (case/space variant) is refused', /stock_batches_identity_uq/.test(await rejects(q(`insert into public.stock_batches (item_id, location_id, batch_no, qty) values ('${ITEM}', '${PH}', ' b-1', 1)`)) || ''));

console.log('Atomic bill deduction');
let r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A1', movements: [line('BILL-A1', 1, B1, -2, { expected_opening: 20 }), line('BILL-A1', 2, B2, -1), line('BILL-A1', 3, B1, -3)] });
ok('A1 all lines apply together', r.status === 'APPLIED' && r.applied === 3, JSON.stringify(r));
ok('A1 quantities: B1 20-2-3=15, B2 5-1=4', (await qty(B1)) === 15 && (await qty(B2)) === 4);
let rows = await mv(`bill_id = 'BILL-A1'`);
ok('A1 three BILL movements with the acting user and chained opening/closing on B1',
  rows.length === 3 && rows.every((m) => m.created_by === PHARM) && Number(rows[0].closing) === 18 && Number(rows[2].opening) === 18 && Number(rows[2].closing) === 15, JSON.stringify(rows.map((m) => [m.opening, m.closing, m.created_by])));
let snap = await fp();
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A1', movements: [line('BILL-A1', 1, B1, -2), line('BILL-A1', 2, B2, -1), line('BILL-A1', 3, B1, -3)] });
ok('A2 retry of an applied bill = ALREADY_APPLIED, no change', r.status === 'ALREADY_APPLIED' && (await fp()) === snap, JSON.stringify(r));

snap = await fp();
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A3', movements: [line('BILL-A3', 1, B1, -1), line('BILL-A3', 2, B2, -9), line('BILL-A3', 3, B3, -1)] });
ok('A3 one line short of stock -> CONFLICT and NOTHING written (no partial bill)', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_INSUFFICIENT_STOCK' && (await fp()) === snap, JSON.stringify(r));
ok('A3 per-line reasons returned', r.lines[1].status === 'CONFLICT_INSUFFICIENT_STOCK' && Number(r.lines[1].actual_opening) === 4 && r.lines[0].status === 'PENDING');
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A4', movements: [line('BILL-A4', 1, B2, -3), line('BILL-A4', 2, B2, -3)] });
ok('A4 two lines on one batch are checked together (4 < 3+3) -> CONFLICT, nothing written', r.status === 'CONFLICT' && (await qty(B2)) === 4, JSON.stringify(r));
const GONE = '22222222-2222-4222-8222-999999999999';
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A5', movements: [line('BILL-A5', 1, B1, -1), line('BILL-A5', 2, GONE, -1, { batch_no: 'B-9' })] });
ok('A5 deleted batch -> CONFLICT_BATCH_NOT_FOUND, nothing written', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_BATCH_NOT_FOUND' && (await qty(B1)) === 15, JSON.stringify(r));

// Legacy partial bill (old per-line client applied line 1, stopped at line 2): bulk retry applies ONLY what is missing.
let lr = await call('apply_bill_stock_movement', { movement_key: 'VHC:BILL:BILL-A6:m1', bill_id: 'BILL-A6', stock_batch_id: B1, quantity_delta: -1, expected_opening: 15 });
ok('A6 legacy single-line function records the acting user', lr.status === 'APPLIED' && (await mv(`movement_key = 'VHC:BILL:BILL-A6:m1'`))[0].created_by === PHARM, JSON.stringify(lr));
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A6', movements: [line('BILL-A6', 1, B1, -1), line('BILL-A6', 2, B3, -2)] });
ok('A6 partly applied bill: only the missing line is applied (never double-deducted)', r.status === 'APPLIED' && r.applied === 1 && (await qty(B1)) === 14 && (await qty(B3)) === 6, JSON.stringify(r));
ok('A6 line statuses ALREADY_APPLIED + APPLIED', r.lines[0].status === 'ALREADY_APPLIED' && r.lines[1].status === 'APPLIED');
snap = await fp();
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A6', movements: [line('BILL-A6', 1, B1, -5), line('BILL-A6', 3, B3, -1)] });
ok('A7 same key with a different quantity -> CONFLICT_MOVEMENT_MISMATCH, nothing written', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_MOVEMENT_MISMATCH' && (await fp()) === snap, JSON.stringify(r));
ok('A8 a key that does not belong to the bill is refused', /movement_key must be/.test(await rejects(call('apply_bill_stock_movements', { bill_id: 'BILL-A8', movements: [line('BILL-OTHER', 1, B1, -1)] })) || ''));
ok('A8 a positive delta is refused', /negative/.test(await rejects(call('apply_bill_stock_movements', { bill_id: 'BILL-A8', movements: [line('BILL-A8', 1, B1, 1)] })) || ''));
if (PROD) {
  r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A9', movements: [line('BILL-A9', 1, B1, -1)] }, VIEWER);
  ok('A9 viewer -> NOT_PERMITTED, nothing written', r.status === 'NOT_PERMITTED' && (await qty(B1)) === 14);
  r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A9', movements: [line('BILL-A9', 1, B1, -1)] }, WHM);
  ok('A9 warehouse manager -> NOT_PERMITTED (pharmacy deduction)', r.status === 'NOT_PERMITTED');
}
ok('A9 anon cannot call it at all', /permission denied/.test(await rejects(as('', (c) => c.query(`select public.apply_bill_stock_movements('{}'::jsonb)`), 'anon')) || ''));

// Admin review: original batch deleted and re-created under a new id with the same item + batch number.
const NEWB = '22222222-2222-4222-8222-22222222aaaa';
await q(`insert into public.stock_batches (id, item_id, location_id, batch_no, qty) values ('${NEWB}', '${ITEM}', '${PH}', 'B-7', 10)`);
const fbPayload = { bill_id: 'BILL-A10', allow_identity_fallback: true, movements: [line('BILL-A10', 1, GONE, -2, { batch_no: 'b-7 ' })] };
r = await call('apply_bill_stock_movements', fbPayload, PHARM);
ok('A10 re-pointing to the current batch is admin-only (pharmacist -> NOT_PERMITTED)', r.status === 'NOT_PERMITTED' && (await qty(NEWB)) === 10, JSON.stringify(r));
r = await call('apply_bill_stock_movements', fbPayload, ADMIN);
rows = await mv(`movement_key = 'VHC:BILL:BILL-A10:m1'`);
ok('A10 admin: applied to the current batch, audited in the reason, actor recorded', r.status === 'APPLIED' && (await qty(NEWB)) === 8 && /original batch .* no longer exists/.test(rows[0].reason) && rows[0].created_by === ADMIN, JSON.stringify(r));
r = await call('apply_bill_stock_movements', fbPayload, ADMIN);
ok('A10 repeated admin retry = ALREADY_APPLIED (no double deduction)', r.status === 'ALREADY_APPLIED' && (await qty(NEWB)) === 8);

// Two counters retry the same bill at the same moment: exactly one deduction.
await q(`update public.stock_batches set qty = 10 where id = '${B3}'`);
const conc = { bill_id: 'BILL-A11', movements: [line('BILL-A11', 1, B3, -4)] };
const [c1, c2] = await Promise.all([call('apply_bill_stock_movements', conc, PHARM, admin), call('apply_bill_stock_movements', conc, PHARM, second)]);
ok('A11 concurrent identical calls: one APPLIED, one ALREADY_APPLIED, deducted once',
  [c1.status, c2.status].sort().join() === 'ALREADY_APPLIED,APPLIED' && (await qty(B3)) === 6 && (await mv(`bill_id = 'BILL-A11'`)).length === 1, `${c1.status}/${c2.status}`);

console.log('Bill delete restore');
const reason = 'Bill deleted by admin - stock returned';
snap = await qty(B1);
r = await call('restore_bill_stock', { bill_id: 'BILL-A1', reason });
ok('R1 restores exactly the recorded deductions (B1 +5, B2 +1)', r.status === 'APPLIED' && r.restored === 3 && (await qty(B1)) === snap + 5 && (await qty(B2)) === 5, JSON.stringify(r));
rows = await mv(`bill_id = 'BILL-A1' and type = 'RESTORE'`);
ok('R1 one keyed RESTORE per deduction with the acting user', rows.length === 3 && rows.every((m) => m.created_by === PHARM && m.movement_key.startsWith('VHC:BILL-RESTORE:BILL-A1:')));
ok('R1 deletion marker written', (await mv(`movement_key = 'VHC:BILL-DELETED:BILL-A1'`)).length === 1);
snap = await fp();
r = await call('restore_bill_stock', { bill_id: 'BILL-A1', reason });
ok('R2 restoring again = ALREADY_APPLIED, no change', r.status === 'ALREADY_APPLIED' && (await fp()) === snap, JSON.stringify(r));
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-A1', movements: [line('BILL-A1', 9, B1, -1)] });
ok('R3 a deleted bill can never be deducted afterwards (bulk)', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_BILL_DELETED' && (await fp()) === snap);
lr = await call('apply_bill_stock_movement', { movement_key: 'VHC:BILL:BILL-A1:m9', bill_id: 'BILL-A1', stock_batch_id: B1, quantity_delta: -1 });
ok('R3 ... nor through the legacy single-line function', lr.status === 'CONFLICT_BILL_DELETED' && (await fp()) === snap, JSON.stringify(lr));
r = await call('restore_bill_stock', { bill_id: 'BILL-NEVER', reason });
ok('R4 bill never deducted in the cloud -> NOTHING_TO_RESTORE (no stock invented), marker written',
  r.status === 'NOTHING_TO_RESTORE' && (await fp()) !== snap && (await mv(`bill_id = 'BILL-NEVER' and type <> 'ADJUST'`)).length === 0);
snap = await qty(B1);
r = await call('restore_bill_stock', { bill_id: 'BILL-A6', reason });
ok('R5 restores BOTH legacy (keyed single-line) and bulk deductions of a bill exactly once', r.status === 'APPLIED' && r.restored === 2 && (await qty(B1)) === snap + 1);
await q(`insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason)
  values ('VHC:BILL:BILL-R6:m1', '${ITEM}', '${PH}', 'B-1', 'BILL', -1, 1, 0, 'BILL-R6', 'x'),
         (null, '${ITEM}', '${PH}', 'B-1', 'RETURN', 1, 0, 1, 'BILL-R6', 'partial return')`);
snap = await fp();
r = await call('restore_bill_stock', { bill_id: 'BILL-R6', reason });
ok('R6 bill with returns -> CONFLICT_BILL_HAS_RETURNS, nothing written', r.status === 'CONFLICT_BILL_HAS_RETURNS' && (await fp()) === snap);
await q(`insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason)
  values ('VHC:BILL:BILL-R7:m1', '${ITEM}', '${PH}', 'B-1', 'BILL', -1, 1, 0, 'BILL-R7', 'x'),
         ('VHC:RESTORE:BILL-R7:${B1}', '${ITEM}', '${PH}', 'B-1', 'RESTORE', 1, 0, 1, 'BILL-R7', 'old path')`);
snap = await fp();
r = await call('restore_bill_stock', { bill_id: 'BILL-R7', reason });
ok('R7 already restored by the older path -> CONFLICT_ALREADY_RESTORED, nothing written', r.status === 'CONFLICT_ALREADY_RESTORED' && (await fp()) === snap);
await q(`insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason)
  values ('VHC:BILL:BILL-R8:m1', '${ITEM}', '${PH}', 'B-GONE', 'BILL', -2, 2, 0, 'BILL-R8', 'x')`);
snap = await fp();
r = await call('restore_bill_stock', { bill_id: 'BILL-R8', reason });
ok('R8 batch no longer exists -> CONFLICT_RESTORE_BATCH_MISSING, nothing written (no batch invented, no marker)', r.status === 'CONFLICT' && r.conflict === 'CONFLICT_RESTORE_BATCH_MISSING' && (await fp()) === snap, JSON.stringify(r));
r = await call('restore_bill_stock', { bill_id: 'BILL-R8', reason: 'ok' });
ok('R9 an empty/meaningless reason is refused', r.status === 'REJECTED_REASON');

console.log('T7 regression: bill-delete restore vs the cloud patients FK (20261023000200)');
const CLOUD_PAT = '44444444-4444-4444-8444-444444444441';      // a real cloud patients.id
const LOCAL_PAT = '28ad4342-0000-4000-8000-00000000c0de';      // a counter's LOCAL SQLite patient id (not in patients)
await q(`insert into public.patients values ('${CLOUD_PAT}', 'QA synthetic patient')`);
await q(`update public.stock_batches set qty = 10 where id in ('${B1}', '${B3}')`);
// Bill T7-1: two deductions, one recorded WITH the cloud patient (older path), one without (bulk path records none).
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-T7-1', movements: [line('BILL-T7-1', 1, B1, -2)] });
ok('T7.0 deduction applied (B1 10 -> 8)', r.status === 'APPLIED' && (await qty(B1)) === 8, JSON.stringify(r));
await q(`update public.stock_batches set qty = qty - 4 where id = '${B3}';
  insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason)
  values ('VHC:BILL:BILL-T7-1:m2', '${ITEM2}', '${PH}', 'C-1', 'BILL', -4, 10, 6, 'BILL-T7-1', '${CLOUD_PAT}', 'older path, patient recorded')`);
snap = await fp();
let t7err = await rejects(call('restore_bill_stock', { bill_id: 'BILL-T7-1', reason, patient_id: LOCAL_PAT }));
ok('T7.1 BEFORE the fix: a local patient id makes the restore fail on stock_movements_patient_id_fkey (reproduces T7)',
  /stock_movements_patient_id_fkey/.test(t7err || ''), t7err);
ok('T7.1 ... and nothing was written (no stock, no RESTORE row, no BILL-DELETED marker)',
  (await fp()) === snap && (await mv(`movement_key = 'VHC:BILL-DELETED:BILL-T7-1'`)).length === 0);

await q('begin; ' + FIX + ' commit;');
ok('T7.2 fix migration applies and changes no stock row or movement', (await fp()) === snap);
await q('begin; ' + FIX + ' commit;');
ok('T7.2 re-running the fix migration is a no-op', (await fp()) === snap);
const fixAcl = (await q(`select has_function_privilege('anon', 'public.restore_bill_stock(jsonb)', 'execute') a,
  has_function_privilege('authenticated', 'public.restore_bill_stock(jsonb)', 'execute') u,
  (select prosecdef from pg_proc where oid = 'public.restore_bill_stock(jsonb)'::regprocedure) d`)).rows[0];
ok('T7.2 grants unchanged (anon no, authenticated yes, still SECURITY INVOKER)', !fixAcl.a && fixAcl.u && !fixAcl.d, JSON.stringify(fixAcl));

r = await call('restore_bill_stock', { bill_id: 'BILL-T7-1', reason, patient_id: LOCAL_PAT });
rows = await mv(`bill_id = 'BILL-T7-1' and type = 'RESTORE'`);
ok('T7.3 AFTER the fix: same call (local patient id still sent) restores exactly the recorded deductions (B1 +2, C-1 +4)',
  r.status === 'APPLIED' && r.restored === 2 && (await qty(B1)) === 10 && (await qty(B3)) === 10, JSON.stringify(r));
ok('T7.3 the payload patient id is ignored; each RESTORE carries the patient recorded on its deduction',
  rows.length === 2 && rows.find((m) => m.batch_no === 'B-1').patient_id === null
  && rows.find((m) => m.batch_no === 'C-1').patient_id === CLOUD_PAT && rows.every((m) => m.patient_id !== LOCAL_PAT));
ok('T7.3 BILL-DELETED marker written once', (await mv(`movement_key = 'VHC:BILL-DELETED:BILL-T7-1'`)).length === 1);
r = await call('restore_bill_stock', { bill_id: 'BILL-T7-1', reason: 'Bill deleted - retried from second counter', patient_id: CLOUD_PAT });
snap = await fp();
ok('T7.4 retry (any patient id) = ALREADY_APPLIED, no second restore', r.status === 'ALREADY_APPLIED' && (await qty(B1)) === 10
  && (await mv(`bill_id = 'BILL-T7-1' and type = 'RESTORE'`)).length === 2, JSON.stringify(r));
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-T7-1', movements: [line('BILL-T7-1', 1, B1, -2), line('BILL-T7-1', 3, B1, -1)] });
ok('T7.5 late sync of the deleted bill (bulk, original + new key) -> CONFLICT_BILL_DELETED, nothing written',
  r.status === 'CONFLICT' && r.conflict === 'CONFLICT_BILL_DELETED' && (await fp()) === snap, JSON.stringify(r));
lr = await call('apply_bill_stock_movement', { movement_key: 'VHC:BILL:BILL-T7-1:m4', bill_id: 'BILL-T7-1', stock_batch_id: B1, quantity_delta: -1, patient_id: CLOUD_PAT });
ok('T7.5 ... nor through the legacy single-line function', lr.status === 'CONFLICT_BILL_DELETED' && (await fp()) === snap, JSON.stringify(lr));

// A restore whose write phase hits a constraint: everything rolled back, structured refusal (no HTTP error).
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-T7-2', movements: [line('BILL-T7-2', 1, B3, -3)] });
ok('T7.6 deduction applied (C-1 10 -> 7)', r.status === 'APPLIED' && (await qty(B3)) === 7);
await q(`alter table public.stock_batches add constraint qa_t7_cap check (id <> '${B3}' or qty <= 8)`);
snap = await fp();
r = await call('restore_bill_stock', { bill_id: 'BILL-T7-2', reason });
ok('T7.6 write-phase constraint failure -> CONFLICT_RESTORE_WRITE_FAILED with the SQLSTATE, restored 0',
  r.status === 'CONFLICT' && r.conflict === 'CONFLICT_RESTORE_WRITE_FAILED' && r.sqlstate === '23514' && r.restored === 0, JSON.stringify(r));
ok('T7.6 ... nothing written: stock, RESTORE rows and the BILL-DELETED marker all absent', (await fp()) === snap && (await qty(B3)) === 7
  && (await mv(`movement_key = 'VHC:BILL-DELETED:BILL-T7-2'`)).length === 0);
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-T7-2', movements: [line('BILL-T7-2', 2, B3, -1)] });
ok('T7.6 a failed restore does NOT mark the bill deleted (the bill is still live: further lines can sync)', r.status === 'APPLIED' && (await qty(B3)) === 6, JSON.stringify(r));
await q('alter table public.stock_batches drop constraint qa_t7_cap');
r = await call('restore_bill_stock', { bill_id: 'BILL-T7-2', reason });
ok('T7.7 retry after the cause is fixed restores every recorded deduction once (C-1 6 -> 10)', r.status === 'APPLIED' && r.restored === 2 && (await qty(B3)) === 10, JSON.stringify(r));
r = await call('restore_bill_stock', { bill_id: 'BILL-T7-2', reason });
ok('T7.7 a further retry = ALREADY_APPLIED', r.status === 'ALREADY_APPLIED' && (await qty(B3)) === 10);
// Two counters delete the same bill at the same moment: restored exactly once.
r = await call('apply_bill_stock_movements', { bill_id: 'BILL-T7-3', movements: [line('BILL-T7-3', 1, B1, -5)] });
const [d1, d2] = await Promise.all([
  call('restore_bill_stock', { bill_id: 'BILL-T7-3', reason, patient_id: LOCAL_PAT }, PHARM, admin),
  call('restore_bill_stock', { bill_id: 'BILL-T7-3', reason, patient_id: LOCAL_PAT }, PHARM, second)]);
ok('T7.8 concurrent deletes of one bill: one APPLIED, one ALREADY_APPLIED, restored once',
  [d1.status, d2.status].sort().join() === 'ALREADY_APPLIED,APPLIED' && (await qty(B1)) === 10
  && (await mv(`bill_id = 'BILL-T7-3' and type = 'RESTORE'`)).length === 1, `${d1.status}/${d2.status}`);

console.log('Batch create / delete');
r = await call('create_stock_batch', { request_key: rk(1), item_id: ITEM2, location_id: PH, batch_no: 'N-1', opening_qty: 12, mrp: 50, expiry_date: '2028-12-31', reason: 'Purchase invoice 77' });
rows = await mv(`movement_key = 'VHC:BATCH-OPEN:${rk(1)}'`);
ok('B1 new batch + RECEIVE opening movement (0 -> 12) with the acting user', r.status === 'APPLIED' && (await qty(r.stock_batch_id)) === 12
  && rows.length === 1 && rows[0].type === 'RECEIVE' && Number(rows[0].opening) === 0 && Number(rows[0].closing) === 12 && rows[0].created_by === PHARM, JSON.stringify(r));
const NB = r.stock_batch_id;
r = await call('create_stock_batch', { request_key: rk(1), item_id: ITEM2, location_id: PH, batch_no: 'N-1', opening_qty: 12 });
ok('B2 retry with the same request key = ALREADY_APPLIED (one batch, one movement)', r.status === 'ALREADY_APPLIED' && r.stock_batch_id === NB
  && (await q(`select count(*)::int n from public.stock_batches where batch_no ilike 'n-1'`)).rows[0].n === 1);
r = await call('create_stock_batch', { request_key: rk(2), item_id: ITEM2, location_id: PH, batch_no: ' n-1 ', opening_qty: 3 });
ok('B3 duplicate item+location+batch (case/space variant) -> CONFLICT_BATCH_EXISTS, nothing created', r.status === 'CONFLICT_BATCH_EXISTS' && r.stock_batch_id === NB && (await qty(NB)) === 12);
r = await call('delete_stock_batch', { request_key: rk(3), stock_batch_id: NB, reason: 'Entered by mistake' });
ok('B4 deleting a batch that still holds stock -> CONFLICT_BATCH_NOT_EMPTY', r.status === 'CONFLICT_BATCH_NOT_EMPTY' && (await qty(NB)) === 12);
r = await call('delete_stock_batch', { request_key: rk(4), stock_batch_id: B2, reason: 'Batch finished' });
await q(`update public.stock_batches set qty = 0 where id = '${B2}'`);
r = await call('delete_stock_batch', { request_key: rk(4), stock_batch_id: B2, reason: 'Batch finished' });
ok('B5 an empty batch WITH sales history is kept (closed at zero), not deleted', r.status === 'CONFLICT_BATCH_HAS_HISTORY' && (await qty(B2)) === 0, JSON.stringify(r));
r = await call('create_stock_batch', { request_key: rk(5), item_id: ITEM2, location_id: PH, batch_no: 'TYPO-1', opening_qty: 0, reason: 'Purchase entry' });
const TB = r.stock_batch_id;
r = await call('delete_stock_batch', { request_key: rk(6), stock_batch_id: TB, reason: 'Duplicate entry typed by mistake' });
rows = await mv(`movement_key = 'VHC:BATCH-DELETE:${rk(6)}'`);
ok('B6 an empty, never-used batch is deleted and the deletion is recorded (ADJUST 0, actor, reason)',
  r.status === 'APPLIED' && (await qty(TB)) === null && rows.length === 1 && rows[0].type === 'ADJUST' && rows[0].created_by === PHARM && /Batch deleted: Duplicate entry/.test(rows[0].reason));
r = await call('delete_stock_batch', { request_key: rk(6), stock_batch_id: TB, reason: 'Duplicate entry typed by mistake' });
ok('B6 retry = ALREADY_APPLIED', r.status === 'ALREADY_APPLIED');
r = await call('create_stock_batch', { request_key: rk(7), item_id: ITEM2, location_id: PH, batch_no: 'REF-1', opening_qty: 0 });
await q(`insert into public.sale_items (stock_batch_id) values ('${r.stock_batch_id}')`);
r = await call('delete_stock_batch', { request_key: rk(8), stock_batch_id: r.stock_batch_id, reason: 'Duplicate entry typed by mistake' });
ok('B7 a batch referenced by a sale line -> CONFLICT_BATCH_REFERENCED, nothing deleted or recorded', r.status === 'CONFLICT_BATCH_REFERENCED' && (await mv(`movement_key = 'VHC:BATCH-DELETE:${rk(8)}'`)).length === 0);
r = await call('create_stock_batch', { request_key: rk(9), item_id: ITEM2, location_id: PH, batch_no: 'NEG', opening_qty: -1 });
ok('B8 negative opening refused', r.status === 'REJECTED_NEGATIVE_QTY');
if (PROD) {
  r = await call('create_stock_batch', { request_key: rk(10), item_id: ITEM2, location_id: PH, batch_no: 'V-1', opening_qty: 1 }, VIEWER);
  ok('B9 viewer cannot create or delete batches', r.status === 'NOT_PERMITTED'
    && (await call('delete_stock_batch', { request_key: rk(11), stock_batch_id: NB, reason: 'Entered by mistake' }, VIEWER)).status === 'NOT_PERMITTED');
}

console.log(`\n${pass} passed, ${fail} failed`);
await admin.end(); await second.end();
process.exit(fail ? 1 : 0);
