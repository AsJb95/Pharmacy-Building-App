-- NHC Pharmacy POS v3.18.2 — Inventory RLS hotfix
-- Run in the dedicated NHC Supabase project's SQL Editor.
-- Before running, replace REPLACE_WITH_LOGIN_EMAIL with the intended Pharmacy login.
-- No password is required or stored. Safe to re-run for the same account.

begin;

do $$
declare
  target_email constant text := 'REPLACE_WITH_LOGIN_EMAIL';
begin
  if target_email = 'REPLACE_WITH_LOGIN_EMAIL' then
    raise exception 'Replace REPLACE_WITH_LOGIN_EMAIL before running this hotfix.';
  end if;

  if to_regclass('public.profiles') is null
     or to_regclass('public.items') is null
     or to_regclass('public.stock_batches') is null
     or to_regclass('public.stock_movements') is null then
    raise exception
      'NHC base schema is missing. Apply nhc_pharmacy_migration_v1_pharmacy_only.sql first.';
  end if;

  if not exists (
    select 1 from auth.users where lower(email) = lower(target_email)
  ) then
    raise exception 'No Supabase Auth user exists for %', target_email;
  end if;

  insert into public.profiles (id, full_name, role)
  select
    u.id,
    coalesce(
      nullif(u.raw_user_meta_data->>'full_name', ''),
      split_part(u.email, '@', 1)
    ),
    'pharmacist'
  from auth.users u
  where lower(u.email) = lower(target_email)
  on conflict (id) do update
    set role = excluded.role;
end
$$;

create or replace function public.current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_pharmacy_writer()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.current_role_name() in ('admin', 'pharmacist');
$$;

create or replace function public.is_known_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.current_role_name() is not null;
$$;

grant execute on function public.current_role_name() to authenticated;
grant execute on function public.is_pharmacy_writer() to authenticated;
grant execute on function public.is_known_user() to authenticated;

grant select, insert, update, delete on public.items to authenticated;
grant select, insert, update, delete on public.stock_batches to authenticated;
grant select, insert on public.stock_movements to authenticated;

alter table public.items enable row level security;
alter table public.stock_batches enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists "nhc_items_select" on public.items;
create policy "nhc_items_select" on public.items
  for select to authenticated
  using (public.is_known_user());

drop policy if exists "nhc_items_write" on public.items;
create policy "nhc_items_write" on public.items
  for all to authenticated
  using (public.is_pharmacy_writer())
  with check (public.is_pharmacy_writer());

drop policy if exists "nhc_stock_batches_select" on public.stock_batches;
create policy "nhc_stock_batches_select" on public.stock_batches
  for select to authenticated
  using (public.is_known_user());

drop policy if exists "nhc_stock_batches_write" on public.stock_batches;
create policy "nhc_stock_batches_write" on public.stock_batches
  for all to authenticated
  using (public.is_pharmacy_writer())
  with check (public.is_pharmacy_writer());

drop policy if exists "nhc_stock_movements_select" on public.stock_movements;
create policy "nhc_stock_movements_select" on public.stock_movements
  for select to authenticated
  using (public.is_known_user());

drop policy if exists "nhc_stock_movements_insert" on public.stock_movements;
create policy "nhc_stock_movements_insert" on public.stock_movements
  for insert to authenticated
  with check (public.is_pharmacy_writer());

commit;

-- Expected result: exactly one row with role = pharmacist.
select u.email, p.role, p.is_platform_admin
from auth.users u
join public.profiles p on p.id = u.id
where lower(u.email) = lower('REPLACE_WITH_LOGIN_EMAIL');
