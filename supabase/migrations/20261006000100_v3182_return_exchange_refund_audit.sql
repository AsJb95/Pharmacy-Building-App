-- VHC v3.18.2 return, exchange, refund, and patient-credit audit foundation.
-- Schema-only and idempotent. Existing sales are never rewritten or deleted.

create table if not exists public.sale_returns (
  id uuid primary key default gen_random_uuid(),
  original_sale_id uuid not null references public.sales(id),
  original_bill_id text not null,
  patient_id uuid references public.patients(id),
  return_type text not null default 'RETURN' check (return_type in ('RETURN', 'EXCHANGE')),
  status text not null default 'COMPLETED' check (status in ('DRAFT', 'COMPLETED', 'VOIDED')),
  return_amount numeric(14,2) not null default 0 check (return_amount >= 0),
  refund_amount numeric(14,2) not null default 0 check (refund_amount >= 0),
  credit_amount numeric(14,2) not null default 0 check (credit_amount >= 0),
  refund_method text,
  exchange_sale_id uuid references public.sales(id),
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sale_returns(id) on delete cascade,
  original_sale_item_id uuid not null references public.sale_items(id),
  item_id uuid references public.items(id),
  stock_batch_id uuid references public.stock_batches(id),
  quantity numeric(14,3) not null check (quantity > 0),
  original_quantity numeric(14,3) not null check (original_quantity > 0),
  already_returned_quantity numeric(14,3) not null default 0 check (already_returned_quantity >= 0),
  unit_net_value numeric(14,2) not null default 0 check (unit_net_value >= 0),
  return_amount numeric(14,2) not null default 0 check (return_amount >= 0),
  disposition text not null default 'SALEABLE' check (disposition in ('SALEABLE', 'DAMAGED', 'NON_SALEABLE')),
  restoration_movement_id uuid references public.stock_movements(id),
  created_at timestamptz not null default now(),
  unique (return_id, original_sale_item_id)
);

create table if not exists public.sale_refunds (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sale_returns(id),
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('Cash', 'UPI', 'Card', 'Other')),
  reference text,
  status text not null default 'COMPLETED' check (status in ('PENDING', 'COMPLETED', 'VOIDED')),
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sale_return_credits (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.sale_returns(id),
  applied_sale_id uuid references public.sales(id),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (return_id, applied_sale_id)
);

create index if not exists sale_returns_original_sale_idx on public.sale_returns(original_sale_id);
create index if not exists sale_returns_original_bill_idx on public.sale_returns(original_bill_id);
create index if not exists sale_returns_patient_idx on public.sale_returns(patient_id);
create index if not exists sale_returns_created_at_idx on public.sale_returns(created_at);
create index if not exists sale_return_items_original_item_idx on public.sale_return_items(original_sale_item_id);
create index if not exists sale_return_items_batch_idx on public.sale_return_items(stock_batch_id);
create index if not exists sale_refunds_return_idx on public.sale_refunds(return_id);
create index if not exists sale_return_credits_return_idx on public.sale_return_credits(return_id);

alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
alter table public.sale_refunds enable row level security;
alter table public.sale_return_credits enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_returns' and policyname = 'sale_returns_pharmacy_writer') then
    create policy sale_returns_pharmacy_writer on public.sale_returns for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_return_items' and policyname = 'sale_return_items_pharmacy_writer') then
    create policy sale_return_items_pharmacy_writer on public.sale_return_items for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_refunds' and policyname = 'sale_refunds_pharmacy_writer') then
    create policy sale_refunds_pharmacy_writer on public.sale_refunds for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_return_credits' and policyname = 'sale_return_credits_pharmacy_writer') then
    create policy sale_return_credits_pharmacy_writer on public.sale_return_credits for all using (public.is_pharmacy_writer()) with check (public.is_pharmacy_writer());
  end if;
end;
$$;

comment on table public.sale_returns is 'Auditable return/exchange header; original sales remain immutable.';
comment on table public.sale_return_items is 'Item-level return quantities and stock disposition.';
comment on table public.sale_refunds is 'Money actually refunded, separate from return value.';
comment on table public.sale_return_credits is 'Return value retained as patient credit or applied to an exchange sale.';
