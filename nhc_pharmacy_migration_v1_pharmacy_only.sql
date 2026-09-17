-- =============================================================================
-- NHC Pharmacy POS — clean initial schema for a brand-new, empty Supabase project
-- (Narpavi's Pharmacy Project — Oceania/Sydney).
--
-- PROPOSED / NOT EXECUTED. Written for review only, per explicit instruction.
--
-- Provenance key used in comments throughout this file:
--   [SOURCE]  — copied/adapted directly from an existing, verified VHC migration
--               file, with the exact file named.
--   [NHC-NEW] — did not exist in any source file; added new for this project.
--   [EXCLUDED-NOTE] — marks something deliberately left out, and why.
--
-- Read in full before running anything. This version is intentionally
-- Pharmacy-only for NHC; Warehouse/transfer objects are excluded.
-- =============================================================================


-- =============================================================================
-- 1. EXTENSIONS
-- [SOURCE] 20260814000100_init_schema.sql
-- =============================================================================
create extension if not exists pgcrypto;


-- =============================================================================
-- 2. PROFILES  (+ auth.users -> profiles trigger)
-- [SOURCE] 20260814000100_init_schema.sql (table, trigger)
-- [SOURCE] 20260902000100_common_vhc_auth.sql (is_platform_admin column)
-- =============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'viewer'
    check (role in ('admin', 'warehouse_manager', 'pharmacist', 'viewer')),
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =============================================================================
-- 3. LOCATIONS
-- [SOURCE] 20260814000100_init_schema.sql
-- =============================================================================
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('warehouse_main', 'warehouse_sub', 'pharmacy_counter')),
  color text,
  created_at timestamptz not null default now()
);


-- =============================================================================
-- 4. ITEMS  (+ product_code column/index)
-- [SOURCE] 20260814000100_init_schema.sql (base table + name index)
-- [SOURCE] VHC Warehouse Source/app-v2/migration_product_code.sql, Step 2 only
--          (Step 3 of that file is EXCLUDED — see report, Conflict 1)
-- =============================================================================
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  hsn_code text,
  units_per_pack numeric,
  product_code text,
  created_at timestamptz not null default now()
);

create index if not exists items_name_idx on public.items (lower(name));

create unique index if not exists items_product_code_unique
  on public.items (product_code)
  where product_code is not null and product_code <> '';

comment on column public.items.category is
  'Free text. Pharmacy POS recognizes medicine|injection|consumable as first-class '
  'values driving its Add/Edit Item form; any other value (including NULL) renders '
  'with the medicine field set. [SOURCE] 20260820000100_items_category_default.sql';


-- =============================================================================
-- 5. STOCK_BATCHES  (+ updated_at trigger, + corrected unique constraint)
-- [SOURCE] 20260814000100_init_schema.sql (base table, indexes, touch trigger)
-- [SOURCE] 20260814000400_phase1_fixes.sql (location_id FK is RESTRICT, not CASCADE)
-- [SOURCE] _DRAFT_20260830000100_stock_batches_unique.sql (the unique constraint
--          itself — see report, Conflict 1, for why this version was chosen over
--          migration_product_code.sql's plain-unique proposal)
-- =============================================================================
create table if not exists public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete restrict,
  batch_no text,
  expiry_date date,
  mrp numeric,
  net_rate numeric,
  gst numeric,
  stockist text,
  qty numeric not null default 0,
  updated_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT (PG15+) so two NULL-batch_no rows for the same item+location
  -- ARE blocked too, unlike a plain UNIQUE. Safe to apply here (unlike on VHC's
  -- live project) because this database starts empty — there is no pre-existing
  -- duplicate data and no concurrent app already relying on duplicates being allowed.
  constraint stock_batches_item_loc_batch_key
    unique nulls not distinct (item_id, location_id, batch_no)
);

create index if not exists stock_batches_location_idx on public.stock_batches (location_id);
create index if not exists stock_batches_expiry_idx on public.stock_batches (expiry_date);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists stock_batches_touch on public.stock_batches;
create trigger stock_batches_touch
  before update on public.stock_batches
  for each row execute function public.touch_updated_at();


-- =============================================================================
-- 6. PATIENTS
-- [SOURCE] 20260814000100_init_schema.sql (base table)
-- [SOURCE] 20260818000100_pharmacy_migration.sql (is_manual, merged_into_patient_id)
-- [SOURCE] 20260819000100_pharmacy_billing_compatibility.sql (legacy_patient_id
--          + its partial unique index)
-- [EXCLUDED-NOTE] patients.uhid (VHC OPD's 0001_init.sql) is NOT included — it
--          belongs to the separate OPD app, never referenced by Pharmacy POS.
-- NOTE ON ORDERING: this table is created here, BEFORE stock_movements, because
-- stock_movements.patient_id has a foreign key to it — reversing the two
-- sections would fail with "relation public.patients does not exist".
-- =============================================================================
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  age int,
  sex text,
  address text,
  source text,
  is_manual boolean not null default false,
  merged_into_patient_id uuid references public.patients(id),
  legacy_patient_id text,
  created_at timestamptz not null default now()
);

create index if not exists patients_merged_into_idx on public.patients (merged_into_patient_id);

create unique index if not exists patients_legacy_patient_id_unique
  on public.patients (legacy_patient_id)
  where legacy_patient_id is not null and legacy_patient_id <> '';


-- =============================================================================
-- 7. STOCK_MOVEMENTS (append-only ledger)
-- [SOURCE] 20260818000100_pharmacy_migration.sql
-- =============================================================================
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  item_id uuid references public.items(id),
  location_id uuid references public.locations(id),
  batch_no text,
  type text not null check (type in ('BILL', 'RESTORE', 'EDIT', 'RECEIVE', 'TRANSFER', 'ADJUST')),
  qty numeric not null,
  opening numeric,
  closing numeric,
  bill_id text,
  patient_id uuid references public.patients(id),
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_item_idx on public.stock_movements (item_id);
create index if not exists stock_movements_location_idx on public.stock_movements (location_id);
create index if not exists stock_movements_bill_idx on public.stock_movements (bill_id);
create index if not exists stock_movements_created_idx on public.stock_movements (created_at);


-- =============================================================================
-- 8. SALES
-- [SOURCE] 20260814000100_init_schema.sql
-- =============================================================================
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  bill_id text unique not null,
  patient_id uuid references public.patients(id),
  patient_name text,
  doctor_name text,
  payment_mode text,
  subtotal numeric,
  total_tax numeric,
  total_amount numeric,
  gst_mode text,
  discount numeric,
  discount_percent numeric,
  location_id uuid references public.locations(id),
  sale_date timestamptz not null default now()
);


-- =============================================================================
-- 9. SALE_ITEMS
-- [SOURCE] 20260814000100_init_schema.sql (base table)
-- [SOURCE] 20260819000100_pharmacy_billing_compatibility.sql (affects_stock, metadata)
-- =============================================================================
create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  item_id uuid references public.items(id),
  category text,
  drug_name text not null,
  batch_no text,
  expiry_date date,
  quantity numeric,
  rate numeric,
  total numeric,
  affects_stock boolean not null default true,
  metadata jsonb not null default '{}'::jsonb
);


-- =============================================================================
-- 10. ALERTS_CONFIG
-- [SOURCE] 20260814000100_init_schema.sql
-- =============================================================================
create table if not exists public.alerts_config (
  id uuid primary key default gen_random_uuid(),
  location_id uuid unique references public.locations(id) on delete cascade,
  low_stock_threshold numeric not null default 200,
  expiry_alert_days int not null default 90
);


-- =============================================================================
-- 11-12. TRANSFER ORDERS / ITEMS — EXCLUDED (NHC has no Warehouse in this project)


-- 11. HELPER FUNCTIONS (role / access checks)
-- [SOURCE] 20260814000200_rls_policies.sql (current_role_name, is_admin,
--          is_warehouse_writer, is_pharmacy_writer, is_known_user)
-- [SOURCE] 20260902000100_common_vhc_auth.sql (is_platform_admin)
-- =============================================================================
create or replace function public.current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select public.current_role_name() = 'admin';
$$;

create or replace function public.is_pharmacy_writer()
returns boolean language sql security definer set search_path = public stable as $$
  select public.current_role_name() in ('admin', 'pharmacist');
$$;

create or replace function public.is_known_user()
returns boolean language sql security definer set search_path = public stable as $$
  select public.current_role_name() is not null;
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql security definer set search_path = public stable
as $$
  select coalesce(
    (select is_platform_admin from public.profiles where id = auth.uid()),
    false
  );
$$;
-- NOTE: Pharmacy POS's own client never calls this function directly — it reads
-- profiles.is_platform_admin via a plain SELECT on its own row (allowed by the
-- profiles_select_own_or_admin policy below). This function is included because
-- it was named in the agreed function list and is the standard reusable helper
-- for any RLS policy that needs the same check later.


-- =============================================================================
-- 12. RPC FUNCTIONS (billing)
-- [SOURCE] 20260819000200_pharmacy_billing_compatibility_patch1.sql
--          — this is the FINAL, superseding version of create_sale and the
--          associated safe_date() helper (supersedes the two earlier versions
--          in 20260818000100 and 20260818000200_patch1, and the version in
--          20260819000100 which had the unsafe expiry cast).
--          delete_sale_and_restore's final version is defined in
--          20260819000100_pharmacy_billing_compatibility.sql (not touched by
--          patch1) — verified that patch1 does not redefine it, so that file's
--          version is the final one.
-- =============================================================================

create or replace function public.safe_date(input text)
returns date
language plpgsql
immutable
as $$
declare
  m text[];
  mon int;
  yr int;
begin
  if input is null or btrim(input) = '' then
    return null;
  end if;

  m := regexp_match(btrim(input), '^(\d{1,2})[/\-](\d{2,4})$');
  if m is not null then
    mon := m[1]::int;
    yr := m[2]::int;
    if yr < 100 then
      yr := yr + 2000;
    end if;
    if mon between 1 and 12 then
      return (make_date(yr, mon, 1) + interval '1 month - 1 day')::date;
    end if;
    return null;
  end if;

  begin
    return input::date;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function public.create_sale(payload jsonb)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_existing public.sales;
  v_item jsonb;
  v_batch record;
  v_remaining numeric;
  v_take numeric;
  v_affects_stock boolean;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to create sales';
  end if;

  select * into v_existing from public.sales where bill_id = payload->>'bill_id';
  if found then return v_existing; end if;

  insert into public.sales (
    bill_id, patient_id, patient_name, doctor_name, payment_mode,
    subtotal, total_tax, total_amount, gst_mode, discount, discount_percent,
    location_id, sale_date
  ) values (
    payload->>'bill_id', nullif(payload->>'patient_id', '')::uuid,
    payload->>'patient_name', payload->>'doctor_name', payload->>'payment_mode',
    (payload->>'subtotal')::numeric, (payload->>'total_tax')::numeric,
    (payload->>'total_amount')::numeric, payload->>'gst_mode',
    (payload->>'discount')::numeric, (payload->>'discount_percent')::numeric,
    (payload->>'location_id')::uuid, coalesce((payload->>'sale_date')::timestamptz, now())
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(coalesce(payload->'items', '[]'::jsonb)) loop
    v_affects_stock := coalesce((v_item->>'affects_stock')::boolean, true)
      and nullif(v_item->>'item_id', '') is not null;

    insert into public.sale_items (
      sale_id, item_id, category, drug_name, batch_no, expiry_date, quantity, rate, total,
      affects_stock, metadata
    ) values (
      v_sale.id, nullif(v_item->>'item_id', '')::uuid, v_item->>'category',
      v_item->>'drug_name', nullif(v_item->>'batch_no', ''),
      public.safe_date(v_item->>'expiry_date'), (v_item->>'quantity')::numeric,
      (v_item->>'rate')::numeric, (v_item->>'total')::numeric,
      v_affects_stock, coalesce(v_item->'metadata', '{}'::jsonb)
    );

    if not v_affects_stock then continue; end if;
    v_remaining := (v_item->>'quantity')::numeric;
    if nullif(v_item->>'stock_batch_id', '') is not null then
      update public.stock_batches set qty = qty - v_remaining
        where id = (v_item->>'stock_batch_id')::uuid;
      if not found then raise exception 'Stock batch % was not found', v_item->>'stock_batch_id'; end if;
      insert into public.stock_movements (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
      select item_id, location_id, batch_no, 'BILL', -v_remaining, v_sale.bill_id, v_sale.patient_id, 'Bill created', auth.uid()
      from public.stock_batches where id = (v_item->>'stock_batch_id')::uuid;
    else
      for v_batch in select id, qty, item_id, location_id, batch_no from public.stock_batches
        where item_id = (v_item->>'item_id')::uuid and location_id = (payload->>'location_id')::uuid and qty > 0
        order by expiry_date nulls last loop
        exit when v_remaining <= 0;
        v_take := least(v_remaining, v_batch.qty);
        update public.stock_batches set qty = qty - v_take where id = v_batch.id;
        insert into public.stock_movements (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
        values (v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'BILL', -v_take, v_sale.bill_id, v_sale.patient_id, 'Bill created', auth.uid());
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'Insufficient stock for item %', v_item->>'drug_name'; end if;
    end if;
  end loop;
  return v_sale;
end;
$$;

create or replace function public.delete_sale_and_restore(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_sale public.sales; v_item record; v_batch_id uuid;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then raise exception 'Not authorized to delete sales'; end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Sale % not found', p_sale_id; end if;
  for v_item in select * from public.sale_items where sale_id = p_sale_id and affects_stock and item_id is not null loop
    select id into v_batch_id from public.stock_batches
      where item_id = v_item.item_id and location_id = v_sale.location_id and batch_no is not distinct from v_item.batch_no limit 1;
    if v_batch_id is not null then
      update public.stock_batches set qty = qty + v_item.quantity where id = v_batch_id;
    else
      insert into public.stock_batches (item_id, location_id, batch_no, expiry_date, qty)
      values (v_item.item_id, v_sale.location_id, v_item.batch_no, v_item.expiry_date, v_item.quantity) returning id into v_batch_id;
    end if;
    insert into public.stock_movements (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
    values (v_item.item_id, v_sale.location_id, v_item.batch_no, 'RESTORE', v_item.quantity, v_sale.bill_id, v_sale.patient_id, 'Bill deleted - stock restored to inventory', auth.uid());
  end loop;
  delete from public.sales where id = p_sale_id;
end;
$$;

create or replace function public.restore_sale_history(payload jsonb)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_existing public.sales;
  v_item jsonb;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to restore sale history';
  end if;

  select * into v_existing from public.sales where bill_id = payload->>'bill_id';
  if found then return v_existing; end if;

  insert into public.sales (
    bill_id, patient_id, patient_name, doctor_name, payment_mode,
    subtotal, total_tax, total_amount, gst_mode, discount, discount_percent,
    location_id, sale_date
  ) values (
    payload->>'bill_id', nullif(payload->>'patient_id', '')::uuid,
    payload->>'patient_name', payload->>'doctor_name', payload->>'payment_mode',
    (payload->>'subtotal')::numeric, (payload->>'total_tax')::numeric,
    (payload->>'total_amount')::numeric, payload->>'gst_mode',
    (payload->>'discount')::numeric, (payload->>'discount_percent')::numeric,
    (payload->>'location_id')::uuid, coalesce((payload->>'sale_date')::timestamptz, now())
  ) returning * into v_sale;

  for v_item in select * from jsonb_array_elements(coalesce(payload->'items', '[]'::jsonb)) loop
    insert into public.sale_items (
      sale_id, item_id, category, drug_name, batch_no, expiry_date, quantity, rate, total,
      affects_stock, metadata
    ) values (
      v_sale.id, nullif(v_item->>'item_id', '')::uuid, v_item->>'category',
      v_item->>'drug_name', nullif(v_item->>'batch_no', ''),
      public.safe_date(v_item->>'expiry_date'), (v_item->>'quantity')::numeric,
      (v_item->>'rate')::numeric, (v_item->>'total')::numeric,
      false, coalesce(v_item->'metadata', '{}'::jsonb)
    );
  end loop;

  return v_sale;
end;
$$;

grant execute on function public.safe_date(text) to authenticated, anon;
grant execute on function public.create_sale(jsonb) to authenticated;
grant execute on function public.delete_sale_and_restore(uuid) to authenticated;
grant execute on function public.restore_sale_history(jsonb) to authenticated;


-- =============================================================================
-- 13. ROW LEVEL SECURITY — enablement + policies
-- [SOURCE] 20260814000200_rls_policies.sql (base policy set)
-- [SOURCE] 20260819000300_pharmacy_items_insert_grant.sql (items_insert_pharmacy)
-- [EXCLUDED-NOTE] items_select_anon / stock_batches_select_anon
--          (20260820000200_public_readonly_items_stock.sql) are DELIBERATELY
--          EXCLUDED per safety rule 7 — no anonymous public-read access.
-- =============================================================================

alter table public.profiles enable row level security;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles_update_admin_only" on public.profiles
  for update using (public.is_admin());
create policy "profiles_insert_admin_only" on public.profiles
  for insert with check (public.is_admin());

alter table public.locations enable row level security;
alter table public.items enable row level security;

create policy "locations_select_known" on public.locations
  for select using (public.is_known_user());
create policy "locations_write_admin" on public.locations
  for all using (public.is_admin()) with check (public.is_admin());

create policy "items_select_known" on public.items
  for select using (public.is_known_user());
create policy "items_write_pharmacy_or_admin" on public.items
  for all
  using (public.is_admin() or public.is_pharmacy_writer())
  with check (public.is_admin() or public.is_pharmacy_writer());
create policy "items_insert_pharmacy" on public.items
  for insert with check (public.is_pharmacy_writer());

alter table public.stock_batches enable row level security;
create policy "stock_batches_select_known" on public.stock_batches
  for select using (public.is_known_user());
create policy "stock_batches_write_pharmacy" on public.stock_batches
  for all
  using (public.is_admin() or public.is_pharmacy_writer())
  with check (public.is_admin() or public.is_pharmacy_writer());

alter table public.stock_movements enable row level security;
create policy "stock_movements_select_known" on public.stock_movements
  for select using (public.is_known_user());
create policy "stock_movements_insert_pharmacy" on public.stock_movements
  for insert with check (public.is_admin() or public.is_pharmacy_writer());
-- Deliberately no update/delete policy: ledger rows are append-only, matching source.

alter table public.patients enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;

create policy "patients_select_known" on public.patients
  for select using (public.is_known_user());
create policy "patients_write_pharmacy" on public.patients
  for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());

create policy "sales_select_known" on public.sales
  for select using (public.is_known_user());
create policy "sales_write_pharmacy" on public.sales
  for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());

create policy "sale_items_select_known" on public.sale_items
  for select using (public.is_known_user());
create policy "sale_items_write_pharmacy" on public.sale_items
  for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());

alter table public.alerts_config enable row level security;
create policy "alerts_config_select_known" on public.alerts_config
  for select using (public.is_known_user());
create policy "alerts_config_write_admin" on public.alerts_config
  for all using (public.is_admin()) with check (public.is_admin());

-- =============================================================================
-- 14. REALTIME PUBLICATION
-- [SOURCE] 20260818000300_pharmacy_migration_patch2_realtime.sql
-- [SOURCE] 20260909000100_transfer_orders_realtime.sql
-- [EXCLUDED-NOTE] `items` is NOT added — VHC added it only for a separate
--          external anon-read consumer app (excluded above), and Pharmacy
--          POS's own realtime channel never subscribes to it.
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_batches') then
    alter publication supabase_realtime add table public.stock_batches;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sales') then
    alter publication supabase_realtime add table public.sales;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sale_items') then
    alter publication supabase_realtime add table public.sale_items;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'patients') then
    alter publication supabase_realtime add table public.patients;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts_config') then
    alter publication supabase_realtime add table public.alerts_config;
  end if;
end $$;


-- =============================================================================
-- 15. SEED DATA
-- [NHC-NEW] name string chosen to match the app's own already-fixed
--           PHARMACY_LOCATION_NAME constant (dist/assets/vhc-cloud-sync.js) —
--           not invented business info, just internal consistency.
-- [EXCLUDED-NOTE] No warehouse_main location is seeded — not requested in this
--           task's instructions. See analysis report, item E: the transfer /
--           "Pending Stock Requests" feature needs one to exist before
--           acceptPharmacyTransfer() will work (ensureMainWarehouseLocation()
--           throws otherwise).
-- [EXCLUDED-NOTE] No auth.users / profiles / staff rows are inserted, per
--           explicit instruction. Create the first real user via Supabase Auth,
--           then run the two manual statements at the very bottom of this file.
-- =============================================================================

insert into public.locations (name, type)
values ('NHC Pharmacy Counter', 'pharmacy_counter')
on conflict do nothing;

insert into public.alerts_config (location_id, low_stock_threshold, expiry_alert_days)
select id, 200, 90 from public.locations where type = 'pharmacy_counter'
on conflict (location_id) do nothing;


-- =============================================================================
-- MANUAL, ONE-TIME, POST-SCHEMA STEP — DO NOT RUN AS PART OF THIS MIGRATION.
-- After the first real NHC admin signs up once through the app / Supabase Auth
-- (which fires on_auth_user_created and creates their profiles row
-- automatically), run this by hand with their real UID:
--
--   update public.profiles
--   set role = 'admin', is_platform_admin = true
--   where id = '<the real new user''s auth.users UID>';
--
-- [SOURCE pattern] mirrors 20260902000100_common_vhc_auth.sql's own seed step,
-- with no hardcoded UUID — that part is intentionally left for you to fill in
-- once the account actually exists, per explicit instruction.
-- =============================================================================
