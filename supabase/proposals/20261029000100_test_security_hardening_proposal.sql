-- =====================================================================================
-- PROPOSAL: VHC Pharmacy POS TEST Database Least-Privilege Security Hardening
-- File: supabase/proposals/20261029000100_test_security_hardening_proposal.sql
-- TARGET: TEST Supabase Project (dvscemgqegmfmgrtytal) ONLY.
-- STATUS: EXPLICITLY UNAPPLIED — DRAFT FOR SECURITY AUDIT & REVIEW ONLY.
-- NEVER APPLY TO PRODUCTION WITHOUT PRIOR INDEPENDENT BACKUP & FORMAL STAGING REVIEW.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. PROFILES TABLE & ROLE-BASED ACCESS CONTROL (RBAC) FOUNDATION
-- -------------------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'viewer' check (role in ('admin', 'pharmacist', 'warehouse_manager', 'viewer')),
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- -------------------------------------------------------------------------------------
-- 2. ROLE RESOLUTION & PRIVILEGE HELPER FUNCTIONS (SECURITY DEFINER)
-- -------------------------------------------------------------------------------------

-- Returns the caller's application role from public.profiles
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.profiles where id = auth.uid()),
    'viewer'
  );
$$;

-- Checks if caller has admin role
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Checks if caller has platform admin privileges
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_platform_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Checks if caller is authorized for pharmacy billing, dispensing, and returns
-- Gated to admin and pharmacist roles (strictly denies 'viewer')
create or replace function public.is_pharmacy_writer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'pharmacist') from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Checks if caller is authorized for warehouse inventory and stock movements
create or replace function public.is_warehouse_writer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'warehouse_manager') from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Grant execution to authenticated users
grant execute on function public.current_user_role() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.is_pharmacy_writer() to authenticated, service_role;
grant execute on function public.is_warehouse_writer() to authenticated, service_role;

-- -------------------------------------------------------------------------------------
-- 3. PROFILES RLS & PRIVILEGE ESCALATION PREVENTION
-- -------------------------------------------------------------------------------------
drop policy if exists profiles_select_all on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete_admin on public.profiles;

-- All authenticated users can view profiles
create policy profiles_select_all on public.profiles
  for select to authenticated
  using (true);

-- New users can only insert their own profile with 'viewer' role and no platform admin
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (
    id = auth.uid()
    and role = 'viewer'
    and is_platform_admin = false
  );

-- Only platform admins or admins can change roles/privileges.
-- Standard users can update their own full_name but cannot elevate role or is_platform_admin.
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    id = auth.uid() or public.is_admin() or public.is_platform_admin()
  )
  with check (
    case
      when public.is_admin() or public.is_platform_admin() then true
      else (
        id = auth.uid()
        and is_platform_admin = false
        and role = (select p.role from public.profiles p where p.id = auth.uid())
      )
    end
  );

-- Only admins can delete profiles
create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- -------------------------------------------------------------------------------------
-- 4. REMOVE PERMISSIVE 'vhc_test_authenticated_all' POLICIES
-- -------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'locations', 'items', 'stock_batches', 'patients', 'sales',
    'sale_items', 'stock_movements', 'alerts_config', 'transfer_orders',
    'transfer_order_items'
  ]) loop
    execute format('drop policy if exists vhc_test_authenticated_all on public.%I', t);
  end loop;
end $$;

-- -------------------------------------------------------------------------------------
-- 5. LEAST-PRIVILEGE RLS POLICIES FOR CORE APPLICATION TABLES
-- -------------------------------------------------------------------------------------

-- TABLE: locations (Counter, Warehouse, etc.)
drop policy if exists locations_read_all on public.locations;
drop policy if exists locations_write_admin on public.locations;
create policy locations_read_all on public.locations
  for select to authenticated using (true);
create policy locations_write_admin on public.locations
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- TABLE: items (Catalog of medicines and products)
drop policy if exists items_read_all on public.items;
drop policy if exists items_insert_writer on public.items;
drop policy if exists items_update_writer on public.items;
drop policy if exists items_delete_admin on public.items;
create policy items_read_all on public.items
  for select to authenticated using (true);
create policy items_insert_writer on public.items
  for insert to authenticated
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());
create policy items_update_writer on public.items
  for update to authenticated
  using (public.is_pharmacy_writer() or public.is_warehouse_writer())
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());
create policy items_delete_admin on public.items
  for delete to authenticated
  using (public.is_admin());

-- TABLE: stock_batches (Batch stock levels and pricing)
drop policy if exists stock_batches_read_all on public.stock_batches;
drop policy if exists stock_batches_insert_writer on public.stock_batches;
drop policy if exists stock_batches_update_writer on public.stock_batches;
drop policy if exists stock_batches_delete_admin on public.stock_batches;
create policy stock_batches_read_all on public.stock_batches
  for select to authenticated using (true);
create policy stock_batches_insert_writer on public.stock_batches
  for insert to authenticated
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());
create policy stock_batches_update_writer on public.stock_batches
  for update to authenticated
  using (public.is_pharmacy_writer() or public.is_warehouse_writer())
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());
-- Direct batch delete forbidden for regular writers (must use delete_stock_batch RPC)
create policy stock_batches_delete_admin on public.stock_batches
  for delete to authenticated
  using (public.is_admin());

-- TABLE: patients
drop policy if exists patients_read_all on public.patients;
drop policy if exists patients_insert_writer on public.patients;
drop policy if exists patients_update_writer on public.patients;
drop policy if exists patients_delete_admin on public.patients;
create policy patients_read_all on public.patients
  for select to authenticated using (true);
create policy patients_insert_writer on public.patients
  for insert to authenticated
  with check (public.is_pharmacy_writer());
create policy patients_update_writer on public.patients
  for update to authenticated
  using (public.is_pharmacy_writer())
  with check (public.is_pharmacy_writer());
create policy patients_delete_admin on public.patients
  for delete to authenticated
  using (public.is_admin());

-- TABLE: sales (Immutable financial bill ledger)
drop policy if exists sales_read_all on public.sales;
drop policy if exists sales_insert_writer on public.sales;
drop policy if exists sales_update_writer on public.sales;
drop policy if exists sales_delete_forbidden on public.sales;
create policy sales_read_all on public.sales
  for select to authenticated using (true);
-- Direct inserts allowed only for pharmacy writers (typically handled by create_sale RPC)
create policy sales_insert_writer on public.sales
  for insert to authenticated
  with check (public.is_pharmacy_writer());
-- Updates restricted to pharmacy writers (e.g. cancellation timestamp or sync status)
create policy sales_update_writer on public.sales
  for update to authenticated
  using (public.is_pharmacy_writer())
  with check (public.is_pharmacy_writer());
-- Direct DELETION of financial sales records is strictly prohibited
create policy sales_delete_forbidden on public.sales
  for delete to authenticated
  using (false);

-- TABLE: sale_items (Line items of sales)
drop policy if exists sale_items_read_all on public.sale_items;
drop policy if exists sale_items_insert_writer on public.sale_items;
drop policy if exists sale_items_update_forbidden on public.sale_items;
drop policy if exists sale_items_delete_forbidden on public.sale_items;
create policy sale_items_read_all on public.sale_items
  for select to authenticated using (true);
create policy sale_items_insert_writer on public.sale_items
  for insert to authenticated
  with check (public.is_pharmacy_writer());
-- Sale items cannot be tampered with after creation
create policy sale_items_update_forbidden on public.sale_items
  for update to authenticated
  using (false);
-- Direct deletion forbidden (must maintain audit link to sales)
create policy sale_items_delete_forbidden on public.sale_items
  for delete to authenticated
  using (false);

-- TABLE: stock_movements (Immutable audit ledger)
drop policy if exists stock_movements_read_all on public.stock_movements;
drop policy if exists stock_movements_insert_writer on public.stock_movements;
drop policy if exists stock_movements_update_forbidden on public.stock_movements;
drop policy if exists stock_movements_delete_forbidden on public.stock_movements;
create policy stock_movements_read_all on public.stock_movements
  for select to authenticated using (true);
create policy stock_movements_insert_writer on public.stock_movements
  for insert to authenticated
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());
-- Ledger rows are immutable: UPDATES and DELETES are strictly forbidden for all roles
create policy stock_movements_update_forbidden on public.stock_movements
  for update to authenticated
  using (false);
create policy stock_movements_delete_forbidden on public.stock_movements
  for delete to authenticated
  using (false);

-- TABLE: alerts_config
drop policy if exists alerts_config_read_all on public.alerts_config;
drop policy if exists alerts_config_write on public.alerts_config;
create policy alerts_config_read_all on public.alerts_config
  for select to authenticated using (true);
create policy alerts_config_write on public.alerts_config
  for all to authenticated
  using (public.is_pharmacy_writer() or public.is_admin())
  with check (public.is_pharmacy_writer() or public.is_admin());

-- TABLE: transfer_orders & transfer_order_items
drop policy if exists transfer_orders_read_all on public.transfer_orders;
drop policy if exists transfer_orders_write_writer on public.transfer_orders;
drop policy if exists transfer_orders_delete_admin on public.transfer_orders;
create policy transfer_orders_read_all on public.transfer_orders
  for select to authenticated using (true);
create policy transfer_orders_write_writer on public.transfer_orders
  for all to authenticated
  using (public.is_pharmacy_writer() or public.is_warehouse_writer())
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());

drop policy if exists transfer_order_items_read_all on public.transfer_order_items;
drop policy if exists transfer_order_items_write_writer on public.transfer_order_items;
create policy transfer_order_items_read_all on public.transfer_order_items
  for select to authenticated using (true);
create policy transfer_order_items_write_writer on public.transfer_order_items
  for all to authenticated
  using (public.is_pharmacy_writer() or public.is_warehouse_writer())
  with check (public.is_pharmacy_writer() or public.is_warehouse_writer());

-- -------------------------------------------------------------------------------------
-- 6. RETURNS & REFUNDS AUDIT TABLES (sale_returns, sale_return_items, etc.)
-- -------------------------------------------------------------------------------------
-- Ensure existing policies use the updated is_pharmacy_writer() definition
drop policy if exists sale_returns_pharmacy_writer on public.sale_returns;
drop policy if exists sale_return_items_pharmacy_writer on public.sale_return_items;
drop policy if exists sale_refunds_pharmacy_writer on public.sale_refunds;
drop policy if exists sale_return_credits_pharmacy_writer on public.sale_return_credits;

-- Read policy: all authenticated users can view returns for reporting
create policy sale_returns_read on public.sale_returns for select to authenticated using (true);
create policy sale_return_items_read on public.sale_return_items for select to authenticated using (true);
create policy sale_refunds_read on public.sale_refunds for select to authenticated using (true);
create policy sale_return_credits_read on public.sale_return_credits for select to authenticated using (true);

-- Insert policy: only authorized pharmacy writers (or via create_sale_return RPC)
create policy sale_returns_insert on public.sale_returns for insert to authenticated with check (public.is_pharmacy_writer());
create policy sale_return_items_insert on public.sale_return_items for insert to authenticated with check (public.is_pharmacy_writer());
create policy sale_refunds_insert on public.sale_refunds for insert to authenticated with check (public.is_pharmacy_writer());
create policy sale_return_credits_insert on public.sale_return_credits for insert to authenticated with check (public.is_pharmacy_writer());

-- Modification & deletion forbidden (audit ledger immutability)
create policy sale_returns_modify_forbidden on public.sale_returns for update to authenticated using (false);
create policy sale_returns_delete_forbidden on public.sale_returns for delete to authenticated using (false);
create policy sale_return_items_modify_forbidden on public.sale_return_items for update to authenticated using (false);
create policy sale_return_items_delete_forbidden on public.sale_return_items for delete to authenticated using (false);
create policy sale_refunds_modify_forbidden on public.sale_refunds for update to authenticated using (false);
create policy sale_refunds_delete_forbidden on public.sale_refunds for delete to authenticated using (false);
create policy sale_return_credits_modify_forbidden on public.sale_return_credits for update to authenticated using (false);
create policy sale_return_credits_delete_forbidden on public.sale_return_credits for delete to authenticated using (false);

-- -------------------------------------------------------------------------------------
-- 7. RE-VERIFY RPC SECURITY DEFINER GRANTS & IMMUNITY
-- -------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_sale(jsonb) to authenticated, service_role;
grant execute on function public.restore_sale_history(jsonb) to authenticated, service_role;
grant execute on function public.delete_sale_and_restore(uuid) to authenticated, service_role;
grant execute on function public.reconcile_stock_movement(jsonb) to authenticated, service_role;
grant execute on function public.apply_bill_stock_movement(jsonb) to authenticated, service_role;
grant execute on function public.apply_bill_stock_movements(jsonb) to authenticated, service_role;
grant execute on function public.restore_bill_stock(jsonb) to authenticated, service_role;
grant execute on function public.create_stock_batch(jsonb) to authenticated, service_role;
grant execute on function public.delete_stock_batch(jsonb) to authenticated, service_role;
grant execute on function public.apply_stock_correction(jsonb) to authenticated, service_role;
grant execute on function public.apply_stock_restore(jsonb) to authenticated, service_role;
grant execute on function public.accept_pharmacy_transfer(jsonb) to authenticated, service_role;
grant execute on function public.create_sale_return(jsonb) to authenticated, service_role;
grant execute on function public.get_sale_return_eligibility(text) to authenticated, service_role;
grant execute on function public.vhc_manual_stock_reason_ok(text) to authenticated, service_role;
