// Disposable PostgreSQL fixture for public.create_sale_return(jsonb) and
// public.get_sale_return_eligibility(text).
// Runs the REAL migration SQL inside PGlite (real PostgreSQL compiled to WASM), in a
// throwaway in-memory database. No network and no production contact: it never reads a
// connection string, so it cannot reach a live Supabase project even by accident.
//
// The base schema is PRODUCTION-SHAPED (verified against a restored copy of production,
// 2026-10-08): cloud sale_items are record-only (affects_stock = false, stock_batch_id NULL),
// stock was deducted by separate 'BILL' stock_movements, public.sales has no deleted_at /
// cancelled_at, stock_movements.type is CHECK-constrained WITHOUT 'RETURN', and the writer gate
// is profiles.role in ('admin','pharmacist').
//
// HOW TO RUN
//   PGlite is deliberately NOT a dependency of this app (test-only tool; the shipped bundle
//   must not grow). Install it outside the project and put it on NODE_PATH:
//
//     mkdir %TEMP%\vhc-pglite && cd %TEMP%\vhc-pglite && npm init -y && npm i @electric-sql/pglite
//     cd /d "C:\New VHC\unpacked_app"
//     set VHC_PGLITE=%TEMP%\vhc-pglite\node_modules\@electric-sql\pglite\dist\index.js
//     node test\create-sale-return-rpc.pglite.mjs
//
//   (ESM ignores NODE_PATH, hence the explicit VHC_PGLITE pointer. If PGlite happens to be
//   installed in this project, omit VHC_PGLITE and the bare specifier is used instead.)
//
//   test/create-sale-return-rpc.test.cjs is the dependency-free companion that asserts the
//   migration's contract and runs as part of the ordinary suite.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const { PGlite } = await import(
  process.env.VHC_PGLITE ? pathToFileURL(process.env.VHC_PGLITE).href : '@electric-sql/pglite'
);

const REPO = path.join(import.meta.dirname, '..');
const MIG_AUDIT = path.join(REPO, 'supabase/migrations/20261006000100_v3182_return_exchange_refund_audit.sql');
const MIG_RPC = path.join(REPO, 'supabase/migrations/20261008000100_v3190_cloud_sale_return_rpc.sql');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (extra ? ' — ' + extra : '')); fail++; } };
const near = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) < t;

const PROD_TYPE_CHECK = `check (type = any (array['BILL'::text, 'RESTORE'::text, 'EDIT'::text, 'RECEIVE'::text, 'TRANSFER'::text, 'ADJUST'::text]))`;

// ── Production-shaped base schema (only what the RPC touches) ───────────────────────────
// stock_movements.seq is GENERATED ALWAYS AS IDENTITY on purpose: production is identity-backed
// and the RPC must never supply seq itself.
const buildBase = async (db, typeCheck = PROD_TYPE_CHECK) => {
  await db.exec(`
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role noinherit bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.profiles (id uuid primary key references auth.users(id), role text not null);
create table public.locations (id uuid primary key default gen_random_uuid(), name text not null unique, type text not null);
create table public.items (id uuid primary key default gen_random_uuid(), name text not null, units_per_pack numeric);
create table public.patients (id uuid primary key default gen_random_uuid(), name text not null, contact text);
create table public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  location_id uuid not null references public.locations(id),
  batch_no text, expiry_date date, mrp numeric, net_rate numeric, gst numeric, stockist text,
  qty numeric not null default 0, updated_at timestamptz not null default now()
);
create unique index stock_batches_natural_uq on public.stock_batches (item_id, location_id, lower(btrim(coalesce(batch_no, ''))));
create table public.sales (
  id uuid primary key default gen_random_uuid(), bill_id text unique,
  patient_id uuid references public.patients(id), patient_name text, doctor_name text, payment_mode text,
  subtotal numeric, total_tax numeric, total_amount numeric, gst_mode text, discount numeric, discount_percent numeric,
  location_id uuid references public.locations(id), sale_date timestamptz default now(),
  amount_received numeric, outstanding_amount numeric, payment_status text, payment_breakdown jsonb,
  recorded_by text, patient_snapshot jsonb, updated_at timestamptz default now()
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references public.sales(id) on delete cascade,
  item_id uuid references public.items(id), category text, drug_name text, batch_no text, expiry_date text,
  quantity numeric, rate numeric, total numeric, affects_stock boolean default false, metadata jsonb,
  stock_batch_id uuid references public.stock_batches(id), logical_key text, created_at timestamptz default now()
);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  item_id uuid references public.items(id), location_id uuid references public.locations(id),
  batch_no text, type text not null constraint stock_movements_type_check ${typeCheck}, qty numeric not null,
  opening numeric, closing numeric, bill_id text, patient_id uuid references public.patients(id), reason text,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), movement_key text
);
create unique index stock_movements_movement_key_uq on public.stock_movements (movement_key) where movement_key is not null;
create function public.current_role_name() returns text language sql stable security definer set search_path=public
  as 'select role from public.profiles where id = auth.uid()';
create function public.is_pharmacy_writer() returns boolean language sql stable security definer set search_path=public
  as $f$ select public.current_role_name() in ('admin','pharmacist') $f$;
`);
};

const db = await PGlite.create();
const q = async (sql, params) => (await db.query(sql, params)).rows;
await buildBase(db);

const ADMIN = '11111111-1111-1111-1111-111111111111';
const STRANGER = '11111111-1111-1111-1111-111111111112';
await db.exec(`insert into auth.users(id) values ('${ADMIN}'), ('${STRANGER}'); insert into public.profiles(id, role) values ('${ADMIN}', 'admin');`);
const asUser = (id) => db.exec(`set request.jwt.claim.sub = '${id}';`);
await asUser(ADMIN);

console.log('=== 0. Migration application ===');
let threwBefore = null;
try { await db.exec(`insert into public.stock_movements(type, qty) values ('RETURN', 1)`); } catch (e) { threwBefore = e; }
ok('M0 the production constraint rejects a RETURN movement before the migration', !!threwBefore && /stock_movements_type_check/.test(threwBefore.message));
try { await db.exec(fs.readFileSync(MIG_AUDIT, 'utf8')); ok('M1 return/refund audit tables migration applies (20261006000100)', true); }
catch (e) { ok('M1 return/refund audit tables migration applies', false, e.message); }
let rpcCreated = false;
try { await db.exec(fs.readFileSync(MIG_RPC, 'utf8')); rpcCreated = true; ok('M2 RPC migration applies to the production-shaped schema, incl. its own verification block', true); }
catch (e) { ok('M2 RPC migration applies', false, e.message); }
if (!rpcCreated) { console.log('\nRPC not created — aborting behavioural fixtures.'); process.exit(1); }
const conDef = async () => (await q(`select pg_get_constraintdef(oid) d from pg_constraint where conname='stock_movements_type_check'`))[0].d;
const def1 = await conDef();
ok('M2b type constraint now allows RETURN and keeps all six original types', ['BILL', 'RESTORE', 'EDIT', 'RECEIVE', 'TRANSFER', 'ADJUST', 'RETURN'].every((t) => def1.includes(`'${t}'`)), def1);
try { await db.exec(fs.readFileSync(MIG_RPC, 'utf8')); ok('M3 RPC migration is re-runnable', true); } catch (e) { ok('M3 RPC migration is re-runnable', false, e.message); }
const def2 = await conDef();
ok('M3b a re-run leaves the constraint unchanged (RETURN added once)', def2 === def1 && (def2.match(/'RETURN'/g) || []).length === 1, def2);
const sec = await q(`select p.proname, p.prosecdef, p.proconfig from pg_proc p where p.proname in ('create_sale_return','get_sale_return_eligibility','vhc_return_line_allocation','vhc_sale_recorded_outstanding')`);
ok('M4 all four functions are SECURITY DEFINER with search_path pinned', sec.length === 4 && sec.every((r) => r.prosecdef === true && String(r.proconfig).includes('search_path=public')));
{
  const odd = await PGlite.create();
  await buildBase(odd, `check (type = any (array['BILL'::text, 'RESTORE'::text]) and qty <> 0)`);
  await odd.exec(fs.readFileSync(MIG_AUDIT, 'utf8'));
  let t = null; try { await odd.exec(fs.readFileSync(MIG_RPC, 'utf8')); } catch (e) { t = e; }
  ok('M5 an unexpected constraint shape is refused, never rewritten blindly', !!t && /Unexpected stock_movements_type_check shape/.test(t.message), t && t.message);
  await odd.close();
}

// ── Seed one production-shaped cloud bill ───────────────────────────────────────────────
// qtySold units of one item deducted from a batch by a BILL movement; the sale line itself is
// record-only. Plus one non-stock Procedure line.
let seq = 0;
const seed = async ({ billId, paymentMode = 'Cash', total = 300, outstanding = null, breakdown = null, qtySold = 10, batchQty = 100, batchNo = 'AMX-1', lineBatch, extraMovement = false, movementQty }) => {
  seq++;
  const loc = (await q(`insert into public.locations(name,type) values ($1,'PHARMACY') returning id`, ['LOC-' + billId]))[0].id;
  const item = (await q(`insert into public.items(name,units_per_pack) values ('Amoxicillin 500mg',10) returning id`))[0].id;
  // The bill is already completed, so the batch holds the POST-sale quantity.
  const batch = (await q(`insert into public.stock_batches(item_id,location_id,batch_no,qty,mrp) values ($1,$2,$3,$4,100) returning id`, [item, loc, batchNo, batchQty - qtySold]))[0].id;
  const pat = (await q(`insert into public.patients(name,contact) values ('Test Patient','9000000001') returning id`))[0].id;
  const sale = (await q(
    `insert into public.sales(bill_id,patient_id,patient_name,payment_mode,total_amount,outstanding_amount,payment_breakdown,location_id)
     values ($1,$2,'Test Patient',$3,$4,$5,$6::jsonb,$7) returning id`,
    [billId, pat, paymentMode, total, outstanding, breakdown ? JSON.stringify(breakdown) : null, loc]
  ))[0].id;
  const stockLine = (await q(
    `insert into public.sale_items(sale_id,item_id,category,drug_name,batch_no,quantity,rate,total,affects_stock,logical_key)
     values ($1,$2,'Medicine','Amoxicillin 500mg',$3,$4,10,$5,false,'L1') returning id`,
    [sale, item, lineBatch === undefined ? batchNo : lineBatch, qtySold, qtySold * 10]
  ))[0].id;
  const billMovement = (await q(
    `insert into public.stock_movements(item_id,location_id,batch_no,type,qty,opening,closing,bill_id,patient_id,reason)
     values ($1,$2,$3,'BILL',$4,$5,$6,$7,$8,'Sale') returning id`,
    [item, loc, batchNo, -(movementQty ?? qtySold), batchQty, batchQty - qtySold, billId, pat]
  ))[0].id;
  if (extraMovement) {
    await q(`insert into public.stock_batches(item_id,location_id,batch_no,qty) values ($1,$2,'OTHER-B',50)`, [item, loc]);
    await q(`insert into public.stock_movements(item_id,location_id,batch_no,type,qty,bill_id) values ($1,$2,'OTHER-B','BILL',-1,$3)`, [item, loc, billId]);
  }
  const svcLine = (await q(
    `insert into public.sale_items(sale_id,item_id,category,drug_name,quantity,rate,total,affects_stock,logical_key)
     values ($1,null,'Procedure','Consultation',1,200,200,false,'L2') returning id`, [sale]
  ))[0].id;
  return { loc, item, batch, pat, sale, stockLine, svcLine, billMovement };
};

const batchQty = async (id) => Number((await q('select qty from public.stock_batches where id=$1', [id]))[0].qty);
const snapshot = async () => (await q(`select
   (select coalesce(sum(qty),0) from public.stock_batches) as stock,
   (select count(*) from public.stock_movements) as movements,
   (select count(*) from public.sale_returns) as returns,
   (select count(*) from public.sale_return_items) as return_items,
   (select count(*) from public.sale_refunds) as refunds,
   (select count(*) from public.sale_return_credits) as credits,
   (select md5(string_agg(t::text, ',' order by t.id)) from public.sales t) as sales,
   (select md5(string_agg(t::text, ',' order by t.id)) from public.sale_items t) as sale_items`))[0];
const callRpc = async (payload) => (await q('select public.create_sale_return($1::jsonb) as r', [JSON.stringify(payload)]))[0].r;
const elig = async (bill) => (await q('select public.get_sale_return_eligibility($1) as r', [bill]))[0].r;
const cnt = async (sql, params) => Number((await q(sql, params))[0].c);
const expectRefusal = async (name, payload, re) => {
  const before = await snapshot();
  let threw = null;
  try { await callRpc(payload); } catch (e) { threw = e; }
  ok(name, !!threw && re.test(threw.message) && JSON.stringify(await snapshot()) === JSON.stringify(before), threw ? threw.message : 'did not throw');
};

const CASH = await seed({ billId: 'BILL-CLOUD-CASH-1' });
const RID1 = '22222222-2222-2222-2222-222222222221';
const RID2 = '22222222-2222-2222-2222-222222222222';
const RID3 = '22222222-2222-2222-2222-222222222223';
const RID4 = '22222222-2222-2222-2222-222222222224';
const cashBillBefore = (await snapshot());

console.log('\n=== 1. First partial return (record-only line, stock via the BILL movement) ===');
try {
  const r1 = await callRpc({ return_id: RID1, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 3 }] });
  ok('T1 first partial return of 3 of 10 is APPLIED', r1.status === 'APPLIED' && near(r1.return_amount, 30), JSON.stringify(r1));
  ok('T1 binds to the original sale id and bill id (identity preserved)', r1.original_sale_id === CASH.sale && r1.bill_id === 'BILL-CLOUD-CASH-1');
  ok('T1 stock restored into the batch the BILL movement deducted from: 90 -> 93', near(await batchQty(CASH.batch), 93));
  ok('T1 reports the source BILL movement and resolved batch', r1.items[0].source_movement_id === CASH.billMovement && r1.items[0].stock_batch_id === CASH.batch);
  const hdr = (await q('select * from public.sale_returns where id=$1', [RID1]))[0];
  ok('T1 header is COMPLETED with correct amounts', hdr.status === 'COMPLETED' && near(hdr.return_amount, 30) && near(hdr.refund_amount, 30) && near(hdr.credit_amount, 0));
  const li = await q('select * from public.sale_return_items where return_id=$1', [RID1]);
  ok('T1 one return-item row with original/already/unit audit fields and the resolved batch', li.length === 1 && near(li[0].quantity, 3) && near(li[0].original_quantity, 10) && near(li[0].already_returned_quantity, 0) && near(li[0].unit_net_value, 10) && li[0].restoration_movement_id && li[0].stock_batch_id === CASH.batch);
  const after = await snapshot();
  ok('T1 original sale and its lines are byte-identical (no delete/recreate/update)', after.sales === cashBillBefore.sales && after.sale_items === cashBillBefore.sale_items);
  ok('T1 RETURN movement records the acting user', (await q(`select created_by from public.stock_movements where id=$1`, [r1.items[0].movement_id]))[0].created_by === ADMIN);
} catch (e) { ok('T1 first partial return', false, e.message); }

console.log('\n=== 2. Replay of the same return_id (idempotency) ===');
try {
  const before = await snapshot();
  const replay = await callRpc({ return_id: RID1, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 3 }] });
  ok('T2 replay returns ALREADY_APPLIED', replay.status === 'ALREADY_APPLIED', JSON.stringify(replay));
  ok('T2 replay reports the original amounts', near(replay.return_amount, 30) && near(replay.refund_amount, 30));
  ok('T2 replay wrote nothing at all (full snapshot identical)', JSON.stringify(await snapshot()) === JSON.stringify(before));
  ok('T2 stock NOT restored twice (still 93)', near(await batchQty(CASH.batch), 93));
} catch (e) { ok('T2 replay', false, e.message); }

console.log('\n=== 3. Second valid partial return ===');
try {
  const r = await callRpc({ return_id: RID2, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 2 }] });
  ok('T3 second partial return of 2 is APPLIED', r.status === 'APPLIED' && near(r.return_amount, 20));
  ok('T3 stock now 95', near(await batchQty(CASH.batch), 95));
  const li = (await q('select * from public.sale_return_items where return_id=$1', [RID2]))[0];
  ok('T3 already_returned_quantity recorded as 3 from the prior return', near(li.already_returned_quantity, 3));
} catch (e) { ok('T3 second partial return', false, e.message); }

console.log('\n=== 4. Over-return rejection ===');
await expectRefusal('T4 5 returned + 6 more vs 10 sold is rejected with zero trace', { return_id: RID3, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 6 }] }, /exceeds remaining sold quantity/i);
ok('T4 no orphan header row for the rejected return_id', await cnt('select count(*) c from public.sale_returns where id=$1', [RID3]) === 0);

console.log('\n=== 5. Full remaining return ===');
try {
  const r = await callRpc({ return_id: RID3, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 5 }] });
  ok('T5 remaining 5 is APPLIED', r.status === 'APPLIED' && near(r.return_amount, 50));
  ok('T5 stock back to the pre-sale 100 exactly (never more than was deducted)', near(await batchQty(CASH.batch), 100));
} catch (e) { ok('T5 full remaining return', false, e.message); }

console.log('\n=== 6. Post-full-return rejection ===');
await expectRefusal('T6 any further return after full return is rejected', { return_id: RID4, bill_id: 'BILL-CLOUD-CASH-1', items: [{ sale_item_id: CASH.stockLine, quantity: 1 }] }, /exceeds remaining sold quantity/i);
ok('T6 stock still exactly 100 (no over-restoration)', near(await batchQty(CASH.batch), 100));

console.log('\n=== 7. Stock restored exactly once / deterministic movement_key ===');
try {
  const mv = await q(`select movement_key, type, qty, opening, closing, seq from public.stock_movements where bill_id='BILL-CLOUD-CASH-1' and type='RETURN' order by seq`);
  ok('T7 exactly 3 RETURN movements (real RETURN type, not disguised as RESTORE) for 3 applied returns', mv.length === 3);
  ok('T7 movement_key is VHC:RETURN:<return_id>:<sale_item_id>:<source BILL movement id>', mv.every((m) => m.movement_key.endsWith(':' + CASH.stockLine + ':' + CASH.billMovement) && /^VHC:RETURN:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(m.movement_key)));
  ok('T7 opening/closing form an unbroken 90->93->95->100 ledger', near(mv[0].opening, 90) && near(mv[0].closing, 93) && near(mv[1].opening, 93) && near(mv[1].closing, 95) && near(mv[2].opening, 95) && near(mv[2].closing, 100));
  ok('T7 identity seq allocated itself (RPC never supplies seq)', mv.every((m) => Number(m.seq) > 0));
  ok('T7 the original BILL movement is untouched', (await q(`select qty from public.stock_movements where id=$1`, [CASH.billMovement]))[0].qty == -10);
} catch (e) { ok('T7 stock exactly once', false, e.message); }

console.log('\n=== 8. Refund audit ===');
try {
  const refs = await q(`select r.amount, r.method, r.status from public.sale_refunds r join public.sale_returns s on s.id=r.return_id where s.original_bill_id='BILL-CLOUD-CASH-1' order by r.amount`);
  ok('T8 one COMPLETED Cash refund row per applied return (20/30/50)', refs.length === 3 && refs.every((r) => r.method === 'Cash' && r.status === 'COMPLETED') && near(refs[0].amount, 20) && near(refs[1].amount, 30) && near(refs[2].amount, 50));
  ok('T8 a Cash bill without payment detail books no credit', await cnt(`select count(*) c from public.sale_return_credits rc join public.sale_returns s on s.id=rc.return_id where s.original_bill_id='BILL-CLOUD-CASH-1'`) === 0);
  const upi = await seed({ billId: 'BILL-CLOUD-UPI-1', paymentMode: 'UPI' });
  const ru = await callRpc({ return_id: '33333333-3333-3333-3333-333333333331', bill_id: 'BILL-CLOUD-UPI-1', items: [{ sale_item_id: upi.stockLine, quantity: 1 }] });
  ok('T8 a UPI bill refunds by UPI', ru.refund_method === 'UPI' && (await q(`select method from public.sale_refunds where return_id='33333333-3333-3333-3333-333333333331'`))[0].method === 'UPI');
  const card = await seed({ billId: 'BILL-CLOUD-CARD-1', paymentMode: 'Card' });
  const rc = await callRpc({ return_id: '33333333-3333-3333-3333-333333333332', bill_id: 'BILL-CLOUD-CARD-1', items: [{ sale_item_id: card.stockLine, quantity: 1 }] });
  ok('T8 a Card bill refunds by Card', rc.refund_method === 'Card');
} catch (e) { ok('T8 refund audit', false, e.message); }

console.log('\n=== 9. Credit adjustment audit ===');
try {
  const CR = await seed({ billId: 'BILL-CLOUD-CREDIT-1', paymentMode: 'Credit', outstanding: 60, breakdown: { credit: 60, cash: 240 } });
  const r = await callRpc({ return_id: '44444444-4444-4444-4444-444444444441', bill_id: 'BILL-CLOUD-CREDIT-1', items: [{ sale_item_id: CR.stockLine, quantity: 4 }] });
  ok('T9 return value 40 is fully absorbed by the recorded 60 outstanding (no refund)', near(r.return_amount, 40) && near(r.credit_amount, 40) && near(r.refund_amount, 0) && r.refund_method === null, JSON.stringify(r));
  ok('T9 a credit audit row is written and no refund row is', await cnt(`select count(*) c from public.sale_return_credits where return_id='44444444-4444-4444-4444-444444444441'`) === 1 && await cnt(`select count(*) c from public.sale_refunds where return_id='44444444-4444-4444-4444-444444444441'`) === 0);
  ok('T9 credit return still restored stock exactly once', near(await batchQty(CR.batch), 94));
  const r2 = await callRpc({ return_id: '44444444-4444-4444-4444-444444444442', bill_id: 'BILL-CLOUD-CREDIT-1', items: [{ sale_item_id: CR.stockLine, quantity: 6 }] });
  ok('T9 next return splits: remaining 20 credit first, only the 40 excess refunded', near(r2.return_amount, 60) && near(r2.credit_amount, 20) && near(r2.refund_amount, 40), JSON.stringify(r2));
  ok('T9 total credit booked never exceeds the original outstanding 60', near((await q(`select coalesce(sum(credit_amount),0) s from public.sale_returns where original_bill_id='BILL-CLOUD-CREDIT-1'`))[0].s, 60));
  const CR2 = await seed({ billId: 'BILL-CLOUD-CREDIT-2', paymentMode: 'Credit', outstanding: 100, breakdown: { credit: 100 } });
  const r3 = await callRpc({ return_id: '44444444-4444-4444-4444-444444444443', bill_id: 'BILL-CLOUD-CREDIT-2', items: [{ sale_item_id: CR2.stockLine, quantity: 5 }], outstanding_amount: 10 });
  ok('T9 outstanding hint lowers absorbed credit (10 credit / 40 refund)', near(r3.credit_amount, 10) && near(r3.refund_amount, 40), JSON.stringify(r3));
  const r4 = await callRpc({ return_id: '44444444-4444-4444-4444-444444444444', bill_id: 'BILL-CLOUD-CREDIT-2', items: [{ sale_item_id: CR2.stockLine, quantity: 1 }], outstanding_amount: 99999 });
  ok('T9 an inflated hint cannot absorb more than the cloud knows', near(r4.credit_amount, 10) && near(r4.refund_amount, 0), JSON.stringify(r4));
  // Production rows carry NO payment detail. Credit without detail = fully owed (app convention).
  const CR3 = await seed({ billId: 'BILL-CLOUD-CREDIT-NODETAIL', paymentMode: 'Credit', total: 300 });
  const r5 = await callRpc({ return_id: '44444444-4444-4444-4444-444444444445', bill_id: 'BILL-CLOUD-CREDIT-NODETAIL', items: [{ sale_item_id: CR3.stockLine, quantity: 10 }] });
  ok('T9 Credit bill without payment detail: return reduces credit, no cash leaves the till', near(r5.credit_amount, 100) && near(r5.refund_amount, 0), JSON.stringify(r5));
  const SP = await seed({ billId: 'BILL-CLOUD-SPLIT-NODETAIL', paymentMode: 'Split', total: 300 });
  await expectRefusal('T9 Split bill without breakdown is refused (PAYMENT_STATE_UNKNOWN), zero mutation',
    { return_id: '44444444-4444-4444-4444-444444444446', bill_id: 'BILL-CLOUD-SPLIT-NODETAIL', items: [{ sale_item_id: SP.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[PAYMENT_STATE_UNKNOWN\]/);
  const SP2 = await seed({ billId: 'BILL-CLOUD-SPLIT-DETAIL', paymentMode: 'Split', total: 300, breakdown: { cash: 250, upi: 50 } });
  const r6 = await callRpc({ return_id: '44444444-4444-4444-4444-444444444447', bill_id: 'BILL-CLOUD-SPLIT-DETAIL', items: [{ sale_item_id: SP2.stockLine, quantity: 1 }] });
  ok('T9 Split bill WITH a breakdown and no credit part refunds normally', near(r6.refund_amount, 10) && near(r6.credit_amount, 0), JSON.stringify(r6));
} catch (e) { ok('T9 credit adjustment audit', false, e.message); }

console.log('\n=== 10. Duplicate-safe movement_key ===');
try {
  const DUP = await seed({ billId: 'BILL-CLOUD-DUP-1' });
  const rid = '55555555-5555-5555-5555-555555555551';
  await callRpc({ return_id: rid, bill_id: 'BILL-CLOUD-DUP-1', items: [{ sale_item_id: DUP.stockLine, quantity: 2 }] });
  const qtyAfter = await batchQty(DUP.batch);
  const key = 'VHC:RETURN:' + rid + ':' + DUP.stockLine + ':' + DUP.billMovement;
  ok('T10 the movement_key is exactly the documented deterministic string', await cnt('select count(*) c from public.stock_movements where movement_key=$1', [key]) === 1);
  let threw = null;
  try { await db.query(`insert into public.stock_movements(movement_key,type,qty,bill_id) values ($1,'RETURN',2,'BILL-CLOUD-DUP-1')`, [key]); } catch (e) { threw = e; }
  ok('T10 a second movement with the same key is refused by the unique index', !!threw && /duplicate key|unique/i.test(threw.message));
  // Losing the audit header and replaying re-enters the loop; the movement_key guard must then
  // adopt the existing movement instead of restoring the quantity again.
  await db.exec(`delete from public.sale_return_items where return_id='${rid}'; delete from public.sale_refunds where return_id='${rid}'; delete from public.sale_returns where id='${rid}';`);
  const re = await callRpc({ return_id: rid, bill_id: 'BILL-CLOUD-DUP-1', items: [{ sale_item_id: DUP.stockLine, quantity: 2 }] });
  ok('T10 replay after audit loss re-books audit but does NOT restore stock twice', re.status === 'APPLIED' && near(await batchQty(DUP.batch), qtyAfter), 'qty=' + (await batchQty(DUP.batch)));
  ok('T10 the adopted movement is still the single original movement', await cnt('select count(*) c from public.stock_movements where movement_key=$1', [key]) === 1);
} catch (e) { ok('T10 duplicate-safe movement_key', false, e.message); }

console.log('\n=== 11. Unauthorized caller rejected ===');
try {
  const AUTHZ = await seed({ billId: 'BILL-CLOUD-AUTH-1' });
  await asUser(STRANGER);
  await expectRefusal('T11 a signed-in user without a pharmacy role is refused by is_pharmacy_writer()', { return_id: '66666666-6666-6666-6666-666666666661', bill_id: 'BILL-CLOUD-AUTH-1', items: [{ sale_item_id: AUTHZ.stockLine, quantity: 1 }] }, /Not authorized to record pharmacy returns/i);
  let t = null; try { await elig('BILL-CLOUD-AUTH-1'); } catch (e) { t = e; }
  ok('T11 the same user cannot read eligibility either', !!t && /Not authorized/.test(t.message));
  await asUser(ADMIN);
  const r = await callRpc({ return_id: '66666666-6666-6666-6666-666666666661', bill_id: 'BILL-CLOUD-AUTH-1', items: [{ sale_item_id: AUTHZ.stockLine, quantity: 1 }] });
  ok('T11 the same call succeeds for an admin', r.status === 'APPLIED');
} catch (e) { ok('T11 authorization gate', false, e.message); }

console.log('\n=== 12. Reconstruction rules and refusals (all zero-mutation) ===');
try {
  const G = await seed({ billId: 'BILL-CLOUD-GUARD-1' });
  await expectRefusal('G1 a non-stock (Procedure) line is refused as NON_STOCK, like the local path', { return_id: '77777777-7777-7777-7777-777777777770', bill_id: 'BILL-CLOUD-GUARD-1', items: [{ sale_item_id: G.svcLine, quantity: 1 }] }, /RETURN_REFUSED\[NON_STOCK\]/);
  await expectRefusal('G3 a sale item from another bill is refused', { return_id: '77777777-7777-7777-7777-777777777772', bill_id: 'BILL-CLOUD-GUARD-1', items: [{ sale_item_id: CASH.stockLine, quantity: 1 }] }, /does not belong to bill/i);
  await expectRefusal('G4 a duplicated sale item in one payload is refused', { return_id: '77777777-7777-7777-7777-777777777773', bill_id: 'BILL-CLOUD-GUARD-1', items: [{ sale_item_id: G.stockLine, quantity: 5 }, { sale_item_id: G.stockLine, quantity: 5 }] }, /only once per return/i);
  await expectRefusal('G5 a non-positive quantity is refused', { return_id: '77777777-7777-7777-7777-777777777774', bill_id: 'BILL-CLOUD-GUARD-1', items: [{ sale_item_id: G.stockLine, quantity: 0 }] }, /positive quantity/i);
  await expectRefusal('G6 an unknown bill is refused', { return_id: '77777777-7777-7777-7777-777777777775', bill_id: 'BILL-DOES-NOT-EXIST', items: [{ sale_item_id: G.stockLine, quantity: 1 }] }, /was not found/i);
  await expectRefusal('G7 an empty item list is refused', { return_id: '77777777-7777-7777-7777-777777777776', bill_id: 'BILL-CLOUD-GUARD-1', items: [] }, /At least one return line/i);
  const dmgQty = await batchQty(G.batch);
  const dmg = await callRpc({ return_id: '77777777-7777-7777-7777-777777777777', bill_id: 'BILL-CLOUD-GUARD-1', items: [{ sale_item_id: G.stockLine, quantity: 1, disposition: 'DAMAGED' }] });
  ok('G8 a DAMAGED return books value but restores no saleable stock', dmg.items[0].stock_restored === false && near(await batchQty(G.batch), dmgQty));
  ok('G10 return_id reuse across a different bill is refused', await (async () => {
    let threw = null;
    try { await callRpc({ return_id: '77777777-7777-7777-7777-777777777777', bill_id: 'BILL-CLOUD-UPI-1', items: [{ sale_item_id: G.stockLine, quantity: 1 }] }); } catch (e) { threw = e; }
    return !!threw && /already used by bill/i.test(threw.message);
  })());
  // A deleted bill: production deletes are HARD deletes (delete_sale_and_restore); no sale row.
  const DEL = await seed({ billId: 'BILL-CLOUD-DELETED' });
  await db.exec(`delete from public.sales where bill_id='BILL-CLOUD-DELETED'`);
  await expectRefusal('G9 a deleted bill (sale row gone, BILL movement left) is refused', { return_id: '77777777-7777-7777-7777-777777777778', bill_id: 'BILL-CLOUD-DELETED', items: [{ sale_item_id: DEL.stockLine, quantity: 1 }] }, /was not found/i);

  const GONE = await seed({ billId: 'BILL-CLOUD-BATCH-GONE' });
  await db.exec(`delete from public.stock_batches where id='${GONE.batch}'`);
  await expectRefusal('G11 original batch no longer exists → BATCH_GONE, never re-created or guessed', { return_id: '77777777-7777-7777-7777-777777777779', bill_id: 'BILL-CLOUD-BATCH-GONE', items: [{ sale_item_id: GONE.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[BATCH_GONE\]/);
  const MIX = await seed({ billId: 'BILL-CLOUD-MIXED' });
  const MIXGONE = await q(`insert into public.items(name) values ('Gone item') returning id`);
  const mixLine = (await q(`insert into public.sale_items(sale_id,item_id,category,drug_name,batch_no,quantity,rate,total,logical_key) values ($1,$2,'Medicine','Gone item','GX',1,5,5,'L3') returning id`, [MIX.sale, MIXGONE[0].id]))[0].id;
  await q(`insert into public.stock_movements(item_id,location_id,batch_no,type,qty,bill_id) values ($1,$2,'GX','BILL',-1,'BILL-CLOUD-MIXED')`, [MIXGONE[0].id, MIX.loc]);
  await expectRefusal('G12 a request mixing a returnable and an unreconstructable line is refused as a whole', { return_id: '77777777-7777-7777-7777-77777777777a', bill_id: 'BILL-CLOUD-MIXED', items: [{ sale_item_id: MIX.stockLine, quantity: 1 }, { sale_item_id: mixLine, quantity: 1 }] }, /RETURN_REFUSED\[BATCH_GONE\]/);
  const NOH = await seed({ billId: 'BILL-CLOUD-NO-HISTORY' });
  await db.exec(`delete from public.stock_movements where bill_id='BILL-CLOUD-NO-HISTORY'`);
  await expectRefusal('G13 a line with no recorded stock deduction → NO_STOCK_HISTORY', { return_id: '77777777-7777-7777-7777-77777777777b', bill_id: 'BILL-CLOUD-NO-HISTORY', items: [{ sale_item_id: NOH.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[NO_STOCK_HISTORY\]/);
  const QM = await seed({ billId: 'BILL-CLOUD-QTY-MISMATCH', movementQty: 7 });
  await expectRefusal('G14 sold quantity differing from the deducted quantity → QTY_MISMATCH', { return_id: '77777777-7777-7777-7777-77777777777c', bill_id: 'BILL-CLOUD-QTY-MISMATCH', items: [{ sale_item_id: QM.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[QTY_MISMATCH\]/);
  const NA = await seed({ billId: 'BILL-CLOUD-NA-BATCH', batchNo: '', lineBatch: 'N/A' });
  const rna = await callRpc({ return_id: '77777777-7777-7777-7777-77777777777d', bill_id: 'BILL-CLOUD-NA-BATCH', items: [{ sale_item_id: NA.stockLine, quantity: 10 }] });
  ok("G15 line batch 'N/A' resolves through the bill's ONLY BILL movement for that item", rna.status === 'APPLIED' && rna.items[0].stock_batch_id === NA.batch && near(await batchQty(NA.batch), 100));
  const AMB = await seed({ billId: 'BILL-CLOUD-NA-AMBIGUOUS', lineBatch: 'N/A', extraMovement: true });
  await expectRefusal("G16 line batch 'N/A' with two candidate movements → AMBIGUOUS, never guessed", { return_id: '77777777-7777-7777-7777-77777777777e', bill_id: 'BILL-CLOUD-NA-AMBIGUOUS', items: [{ sale_item_id: AMB.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[AMBIGUOUS\]/);
  const WRONG = await seed({ billId: 'BILL-CLOUD-WRONG-BATCH', lineBatch: 'ZZZ-9' });
  await expectRefusal('G17 a line batch that matches no deduction → AMBIGUOUS', { return_id: '77777777-7777-7777-7777-77777777777f', bill_id: 'BILL-CLOUD-WRONG-BATCH', items: [{ sale_item_id: WRONG.stockLine, quantity: 1 }] }, /RETURN_REFUSED\[AMBIGUOUS\]/);
  // Same item sold from two batches on one bill (none in production yet, but the rule must hold).
  const MB = await seed({ billId: 'BILL-CLOUD-MULTI-BATCH', batchNo: 'MB-1', qtySold: 4 });
  const b2 = (await q(`insert into public.stock_batches(item_id,location_id,batch_no,qty) values ($1,$2,'MB-2',20) returning id`, [MB.item, MB.loc]))[0].id;
  const l2 = (await q(`insert into public.sale_items(sale_id,item_id,category,drug_name,batch_no,quantity,rate,total,logical_key) values ($1,$2,'Medicine','Amoxicillin 500mg','MB-2',3,10,30,'L4') returning id`, [MB.sale, MB.item]))[0].id;
  await q(`insert into public.stock_movements(item_id,location_id,batch_no,type,qty,bill_id) values ($1,$2,'MB-2','BILL',-3,'BILL-CLOUD-MULTI-BATCH')`, [MB.item, MB.loc]);
  const rmb = await callRpc({ return_id: '77777777-7777-7777-7777-777777777780', bill_id: 'BILL-CLOUD-MULTI-BATCH', items: [{ sale_item_id: MB.stockLine, quantity: 4 }, { sale_item_id: l2, quantity: 3 }] });
  ok('G18 same item across two batches: each line restores exactly its own batch', rmb.status === 'APPLIED' && near(await batchQty(MB.batch), 100) && near(await batchQty(b2), 23) && new Set(rmb.items.map((i) => i.movement_key)).size === 2);
} catch (e) { ok('T12 reconstruction rules', false, e.message); }

console.log('\n=== 13. Eligibility (read-only, same rules) ===');
try {
  const before = await snapshot();
  const e1 = await elig('BILL-CLOUD-CASH-1');
  const stock = e1.lines.find((l) => l.sale_item_id === CASH.stockLine), svc = e1.lines.find((l) => l.sale_item_id === CASH.svcLine);
  ok('E1 every line of the bill is listed, record-only lines included', e1.status === 'OK' && e1.lines.length === 2);
  ok('E1 a fully returned medicine line reports remaining 0 and is not returnable', stock.status === 'RETURNABLE' && near(stock.already_returned, 10) && near(stock.remaining, 0) && stock.returnable === false);
  ok('E1 the non-stock line is listed with status NON_STOCK and a reason', svc.status === 'NON_STOCK' && svc.returnable === false && /not a stock item/.test(svc.reason));
  const e2 = await elig('BILL-CLOUD-MULTI-BATCH');
  ok('E2 partially/fully returned lines on another bill report correctly', e2.lines.filter((l) => l.status === 'RETURNABLE').every((l) => l.returnable === false));
  const e3 = await elig('BILL-CLOUD-BATCH-GONE');
  ok('E3 BATCH_GONE is reported, not hidden', e3.lines.some((l) => l.status === 'BATCH_GONE' && l.returnable === false));
  const e4 = await elig('BILL-CLOUD-SPLIT-NODETAIL');
  ok('E4 a Split bill without breakdown → PAYMENT_STATE_UNKNOWN with every line non-returnable', e4.status === 'PAYMENT_STATE_UNKNOWN' && e4.lines.length === 2 && e4.lines.every((l) => l.returnable === false));
  ok('E5 an unknown/deleted bill → NOT_FOUND', (await elig('BILL-CLOUD-DELETED')).status === 'NOT_FOUND');
  const e6 = await elig('BILL-CLOUD-NA-AMBIGUOUS');
  ok('E6 AMBIGUOUS is reported with a reason', e6.lines.some((l) => l.status === 'AMBIGUOUS' && l.reason));
  ok('E7 eligibility wrote nothing', JSON.stringify(await snapshot()) === JSON.stringify(before));
} catch (e) { ok('T13 eligibility', false, e.message); }

console.log('\n' + (fail === 0 ? 'ALL RPC FIXTURE TESTS PASSED (' + pass + ')' : fail + ' FAILED / ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
