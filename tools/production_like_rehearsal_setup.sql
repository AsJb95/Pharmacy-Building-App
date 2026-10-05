create schema if not exists vhc_prod_rehearsal authorization postgres;

create table if not exists vhc_prod_rehearsal.locations (
  id uuid primary key default gen_random_uuid(), name text not null unique
);
create table if not exists vhc_prod_rehearsal.items (
  id uuid primary key default gen_random_uuid(), name text not null
);
create table if not exists vhc_prod_rehearsal.patients (
  id uuid primary key default gen_random_uuid(), name text not null
);
create table if not exists vhc_prod_rehearsal.stock_batches (
  id uuid primary key default gen_random_uuid(), item_id uuid not null references vhc_prod_rehearsal.items(id),
  location_id uuid not null references vhc_prod_rehearsal.locations(id), batch_no text,
  expiry_date date, qty numeric not null default 0
);
create table if not exists vhc_prod_rehearsal.sales (
  id uuid primary key default gen_random_uuid(), bill_id text not null unique,
  patient_id uuid references vhc_prod_rehearsal.patients(id), patient_name text,
  doctor_name text, payment_mode text, subtotal numeric, total_tax numeric,
  total_amount numeric, gst_mode text, discount numeric, discount_percent numeric,
  location_id uuid references vhc_prod_rehearsal.locations(id),
  sale_date timestamptz not null default now()
);
create table if not exists vhc_prod_rehearsal.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references vhc_prod_rehearsal.sales(id) on delete cascade,
  item_id uuid references vhc_prod_rehearsal.items(id), category text,
  drug_name text not null, batch_no text, expiry_date date, quantity numeric,
  rate numeric, total numeric, affects_stock boolean not null default true,
  metadata jsonb not null default '{}'::jsonb
);
create table if not exists vhc_prod_rehearsal.stock_movements (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  item_id uuid references vhc_prod_rehearsal.items(id),
  location_id uuid references vhc_prod_rehearsal.locations(id), batch_no text,
  type text not null, qty numeric not null, opening numeric, closing numeric,
  bill_id text, patient_id uuid references vhc_prod_rehearsal.patients(id),
  reason text, created_by uuid, created_at timestamptz not null default now()
);

create or replace function vhc_prod_rehearsal.safe_date(value text) returns date
language plpgsql immutable as $$ begin return value::date; exception when others then return null; end $$;
create or replace function vhc_prod_rehearsal.is_pharmacy_writer() returns boolean
language sql stable security definer set search_path=vhc_prod_rehearsal
as $$ select true $$;

create or replace function vhc_prod_rehearsal.create_sale(payload jsonb)
returns vhc_prod_rehearsal.sales language plpgsql security definer
set search_path=vhc_prod_rehearsal as $$
declare v_sale vhc_prod_rehearsal.sales;
begin
  if not coalesce(vhc_prod_rehearsal.is_pharmacy_writer(),false) then raise exception 'Not authorized'; end if;
  select * into v_sale from vhc_prod_rehearsal.sales where bill_id=payload->>'bill_id';
  if found then return v_sale; end if;
  insert into vhc_prod_rehearsal.sales
    (bill_id,patient_id,patient_name,doctor_name,payment_mode,subtotal,total_tax,total_amount,gst_mode,discount,discount_percent,location_id,sale_date)
  values (payload->>'bill_id',nullif(payload->>'patient_id','')::uuid,payload->>'patient_name',payload->>'doctor_name',payload->>'payment_mode',
    (payload->>'subtotal')::numeric,(payload->>'total_tax')::numeric,(payload->>'total_amount')::numeric,payload->>'gst_mode',
    (payload->>'discount')::numeric,(payload->>'discount_percent')::numeric,(payload->>'location_id')::uuid,
    coalesce((payload->>'sale_date')::timestamptz,now())) returning * into v_sale;
  return v_sale;
end $$;
alter function vhc_prod_rehearsal.create_sale(jsonb) owner to postgres;
revoke all on function vhc_prod_rehearsal.create_sale(jsonb) from public,anon,authenticated,service_role;
grant execute on function vhc_prod_rehearsal.create_sale(jsonb) to public,postgres,anon,authenticated,service_role;

insert into vhc_prod_rehearsal.locations(id,name) values ('10000000-0000-0000-0000-000000000001','TEST-VHC Rehearsal Pharmacy') on conflict do nothing;
insert into vhc_prod_rehearsal.items(id,name) values
 ('20000000-0000-0000-0000-000000000001','TEST-VHC Legacy Tablet A'),
 ('20000000-0000-0000-0000-000000000002','TEST-VHC Legacy Tablet B') on conflict do nothing;
insert into vhc_prod_rehearsal.patients(id,name) values
 ('30000000-0000-0000-0000-000000000001','TEST-VHC Legacy Patient'),
 ('30000000-0000-0000-0000-000000000002','TEST-VHC Credit Patient') on conflict do nothing;
insert into vhc_prod_rehearsal.stock_batches(id,item_id,location_id,batch_no,expiry_date,qty) values
 ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','LEG-A','2029-12-31',87) on conflict do nothing;

insert into vhc_prod_rehearsal.sales(id,bill_id,patient_id,patient_name,doctor_name,payment_mode,subtotal,total_tax,total_amount,gst_mode,discount,discount_percent,location_id,sale_date) values
 ('50000000-0000-0000-0000-000000000001','TEST-VHC-LEGACY-CASH','30000000-0000-0000-0000-000000000001','TEST-VHC Legacy Patient','TEST Doctor','Cash',100,0,100,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-20T10:00:00Z'),
 ('50000000-0000-0000-0000-000000000002','TEST-VHC-LEGACY-UPI',null,'Walk-in','TEST Doctor','UPI',110,0,110,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-21T10:00:00Z'),
 ('50000000-0000-0000-0000-000000000003','TEST-VHC-LEGACY-CARD',null,'Walk-in','TEST Doctor','Card',120,0,120,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-22T10:00:00Z'),
 ('50000000-0000-0000-0000-000000000004','TEST-VHC-LEGACY-CREDIT','30000000-0000-0000-0000-000000000002','TEST-VHC Credit Patient','TEST Doctor','Credit',130,0,130,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-23T10:00:00Z'),
 ('50000000-0000-0000-0000-000000000005','TEST-VHC-LEGACY-SPLIT',null,'Walk-in','TEST Doctor','Split',140,0,140,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-24T10:00:00Z'),
 ('50000000-0000-0000-0000-000000000006','TEST-VHC-LEGACY-MULTI','30000000-0000-0000-0000-000000000001','TEST-VHC Legacy Patient','TEST Doctor','Cash',150,0,150,'regular',0,0,'10000000-0000-0000-0000-000000000001','2026-09-25T10:00:00Z') on conflict do nothing;

insert into vhc_prod_rehearsal.sale_items(id,sale_id,item_id,category,drug_name,batch_no,expiry_date,quantity,rate,total,affects_stock) values
 ('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,100,100,true),
 ('60000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,110,110,true),
 ('60000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,120,120,true),
 ('60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,130,130,true),
 ('60000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,140,140,true),
 ('60000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000001','Medicine','TEST-VHC Legacy Tablet A','LEG-A','2029-12-31',1,75,75,true),
 ('60000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000002','Medicine','TEST-VHC Legacy Tablet B','LEG-B','2029-11-30',1,75,75,true) on conflict do nothing;

insert into vhc_prod_rehearsal.stock_movements(id,item_id,location_id,batch_no,type,qty,opening,closing,bill_id,patient_id,reason,created_at) values
 ('70000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','LEG-A','BILL',-1,88,87,'TEST-VHC-LEGACY-CASH','30000000-0000-0000-0000-000000000001','Legacy synthetic movement','2026-09-20T10:00:00Z') on conflict do nothing;

create table if not exists vhc_prod_rehearsal.rehearsal_snapshots(stage text primary key, snapshot jsonb not null);
insert into vhc_prod_rehearsal.rehearsal_snapshots(stage,snapshot) values ('before',jsonb_build_object(
 'sales',(select count(*) from vhc_prod_rehearsal.sales),'sale_items',(select count(*) from vhc_prod_rehearsal.sale_items),
 'stock_movements',(select count(*) from vhc_prod_rehearsal.stock_movements),'stock_batches',(select count(*) from vhc_prod_rehearsal.stock_batches),
 'patients',(select count(*) from vhc_prod_rehearsal.patients),'bills',(select jsonb_agg(jsonb_build_object('bill_id',bill_id,'total',total_amount,'mode',payment_mode,'date',sale_date,'patient_id',patient_id) order by bill_id) from vhc_prod_rehearsal.sales),
 'stock',(select jsonb_agg(jsonb_build_object('id',id,'qty',qty) order by id) from vhc_prod_rehearsal.stock_batches)
)) on conflict(stage) do update set snapshot=excluded.snapshot;
