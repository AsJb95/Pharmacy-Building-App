-- VHC Pharmacy POS safe-cloud validation schema.
-- Apply only to a dedicated non-production Supabase project. No production
-- rows, identities, or stock quantities are included in this migration.

create extension if not exists pgcrypto;

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  product_code text,
  category text,
  hsn_code text,
  units_per_pack numeric,
  created_at timestamptz not null default now()
);
create unique index if not exists items_product_code_uq on public.items (lower(product_code)) where product_code is not null;

create table if not exists public.stock_batches (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  location_id uuid not null references public.locations(id),
  batch_no text,
  expiry_date date,
  mrp numeric(14,2),
  net_rate numeric(14,2),
  gst numeric(8,2),
  stockist text,
  qty numeric(14,3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  legacy_patient_id text unique,
  name text not null,
  contact text,
  age numeric,
  sex text,
  address text,
  source text,
  is_manual boolean not null default false,
  merged_into_patient_id uuid references public.patients(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  bill_id text not null unique,
  patient_id uuid references public.patients(id),
  patient_name text,
  patient_snapshot jsonb,
  doctor_name text,
  payment_mode text,
  subtotal numeric(14,2),
  total_tax numeric(14,2),
  total_amount numeric(14,2) not null,
  amount_received numeric(14,2),
  outstanding_amount numeric(14,2),
  payment_status text,
  payment_breakdown jsonb,
  recorded_by text,
  gst_mode text,
  discount numeric(14,2),
  discount_percent numeric(8,3),
  location_id uuid not null references public.locations(id),
  sale_date timestamptz not null default now(),
  deleted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  item_id uuid references public.items(id),
  stock_batch_id uuid references public.stock_batches(id),
  category text,
  drug_name text,
  batch_no text,
  expiry_date date,
  quantity numeric(14,3) not null,
  rate numeric(14,2) not null,
  total numeric(14,2) not null,
  affects_stock boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  logical_key text not null,
  created_at timestamptz not null default now(),
  unique (sale_id, logical_key)
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_key text unique,
  item_id uuid references public.items(id),
  location_id uuid references public.locations(id),
  batch_no text,
  type text not null,
  qty numeric(14,3) not null,
  opening numeric(14,3),
  closing numeric(14,3),
  bill_id text,
  patient_id uuid references public.patients(id),
  patient_name text,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts_config (
  location_id uuid primary key references public.locations(id),
  low_stock_threshold numeric not null default 200,
  expiry_alert_days integer not null default 90,
  updated_at timestamptz not null default now()
);

create table if not exists public.transfer_orders (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null unique,
  transfer_date timestamptz,
  from_location_id uuid references public.locations(id),
  to_location_id uuid references public.locations(id),
  status text not null default 'Pending',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.transfer_order_items (
  id uuid primary key default gen_random_uuid(),
  transfer_order_id uuid not null references public.transfer_orders(id) on delete cascade,
  item_id uuid references public.items(id),
  name text not null,
  batch_no text,
  expiry_date date,
  qty numeric(14,3) not null,
  mrp numeric(14,2),
  net_rate numeric(14,2)
);

insert into public.locations (name, type) values
  ('VHC Pharmacy Counter', 'pharmacy_counter'),
  ('VHC Test Main Warehouse', 'warehouse_main')
on conflict (name) do nothing;

insert into public.alerts_config (location_id)
select id from public.locations where type = 'pharmacy_counter'
on conflict (location_id) do nothing;

create or replace function public.create_sale(payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_key text;
begin
  insert into public.sales (
    bill_id, patient_id, patient_name, patient_snapshot, doctor_name, payment_mode, subtotal,
    total_tax, total_amount, amount_received, outstanding_amount, payment_status,
    payment_breakdown, recorded_by, gst_mode, discount, discount_percent,
    location_id, sale_date
  ) values (
    payload->>'bill_id', nullif(payload->>'patient_id','')::uuid,
    payload->>'patient_name', payload->'patient_snapshot', payload->>'doctor_name', payload->>'payment_mode',
    nullif(payload->>'subtotal','')::numeric, nullif(payload->>'total_tax','')::numeric,
    coalesce(nullif(payload->>'total_amount','')::numeric, 0),
    nullif(payload->>'amount_received','')::numeric,
    nullif(payload->>'outstanding_amount','')::numeric, payload->>'payment_status',
    payload->'payment_breakdown', payload->>'recorded_by', payload->>'gst_mode',
    nullif(payload->>'discount','')::numeric,
    nullif(payload->>'discount_percent','')::numeric,
    (payload->>'location_id')::uuid,
    coalesce(nullif(payload->>'sale_date','')::timestamptz, now())
  )
  on conflict (bill_id) do update set updated_at = now()
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    v_key := md5(concat_ws('|',
      coalesce(v_item->>'item_id',''), coalesce(v_item->>'stock_batch_id',''),
      coalesce(v_item->>'drug_name',''), coalesce(v_item->>'batch_no',''),
      coalesce(v_item->>'quantity',''), coalesce(v_item->>'rate',''),
      coalesce(v_item->>'total',''), coalesce(v_item->>'category','')
    ));
    insert into public.sale_items (
      sale_id, item_id, stock_batch_id, category, drug_name, batch_no,
      expiry_date, quantity, rate, total, affects_stock, metadata, logical_key
    ) values (
      v_sale_id, nullif(v_item->>'item_id','')::uuid,
      nullif(v_item->>'stock_batch_id','')::uuid, v_item->>'category',
      v_item->>'drug_name', v_item->>'batch_no',
      nullif(v_item->>'expiry_date','')::date,
      coalesce(nullif(v_item->>'quantity','')::numeric, 0),
      coalesce(nullif(v_item->>'rate','')::numeric, 0),
      coalesce(nullif(v_item->>'total','')::numeric, 0),
      coalesce((v_item->>'affects_stock')::boolean, false),
      coalesce(v_item->'metadata','{}'::jsonb), v_key
    ) on conflict (sale_id, logical_key) do nothing;
  end loop;
  return v_sale_id;
end;
$$;

create or replace function public.restore_sale_history(payload jsonb)
returns uuid language sql security invoker set search_path = public
as $$ select public.create_sale(payload); $$;

create or replace function public.delete_sale_and_restore(p_sale_id uuid)
returns void language plpgsql security invoker set search_path = public
as $$ begin update public.sales set deleted_at = now(), updated_at = now() where id = p_sale_id; end; $$;

alter table public.locations enable row level security;
alter table public.items enable row level security;
alter table public.stock_batches enable row level security;
alter table public.patients enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.alerts_config enable row level security;
alter table public.transfer_orders enable row level security;
alter table public.transfer_order_items enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'locations', 'items', 'stock_batches', 'patients', 'sales', 'sale_items',
    'stock_movements', 'alerts_config', 'transfer_orders', 'transfer_order_items'
  ] loop
    execute format('drop policy if exists vhc_test_authenticated_all on public.%I', table_name);
    execute format(
      'create policy vhc_test_authenticated_all on public.%I for all to authenticated using (true) with check (true)',
      table_name
    );
  end loop;
end $$;

-- Create only synthetic test users in Authentication > Users. Do not copy
-- production users or identities into this project.
