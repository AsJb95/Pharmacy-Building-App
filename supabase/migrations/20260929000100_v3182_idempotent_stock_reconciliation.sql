-- VHC Pharmacy POS v3.18.2 idempotent stock reconciliation.
-- Apply to TEST first. This migration does not replay historical sales or movements.

begin;

do $$
declare
  v_attidentity "char";
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='stock_movements'
      and column_name='seq' and data_type='bigint' and is_nullable='NO'
  ) then
    raise exception 'Expected stock_movements.seq bigint NOT NULL from Migration 1';
  end if;

  select a.attidentity into v_attidentity
  from pg_attribute a
  where a.attrelid = 'public.stock_movements'::regclass
    and a.attname = 'seq' and not a.attisdropped;

  if pg_get_serial_sequence('public.stock_movements','seq') is null then
    raise exception 'Migration 1 stock movement seq allocator is not installed';
  end if;

  if v_attidentity not in ('a', 'd') and (
    to_regprocedure('public.vhc_stock_movements_assign_seq()') is null
    or not exists (
      select 1 from pg_trigger
      where tgrelid='public.stock_movements'::regclass
        and tgname='stock_movements_assign_seq_before_insert'
        and not tgisinternal
    )
  ) then
    raise exception 'Migration 1 stock movement sequence allocator is not installed';
  end if;
  if to_regclass('public.stock_movements_seq_uq') is null then
    raise exception 'Expected stock_movements_seq_uq from Migration 1';
  end if;
end;
$$;

alter table public.stock_movements add column if not exists movement_key text;
create unique index if not exists stock_movements_movement_key_uq
  on public.stock_movements (movement_key)
  where movement_key is not null;

-- The dedicated TEST schema originally used authenticated RLS directly. Production already
-- supplies the stricter clinic-aware function; never replace it when it exists.
do $bootstrap$
begin
  if to_regprocedure('public.is_pharmacy_writer()') is null then
    execute $fn$
      create function public.is_pharmacy_writer()
      returns boolean language sql stable security invoker set search_path=public
      as 'select auth.role() = ''authenticated'''
    $fn$;
  end if;
end;
$bootstrap$;

create or replace function public.reconcile_stock_movement(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.stock_movements%rowtype;
  v_batch public.stock_batches%rowtype;
  v_batch_ids uuid[];
  v_key text := nullif(payload->>'movement_key', '');
  v_bill_id text := nullif(payload->>'bill_id', '');
  v_batch_id uuid := nullif(payload->>'stock_batch_id', '')::uuid;
  v_item_id uuid := nullif(payload->>'item_id', '')::uuid;
  v_location_id uuid := nullif(payload->>'location_id', '')::uuid;
  v_batch_no text := nullif(btrim(payload->>'batch_no'), '');
  v_expected numeric := (payload->>'expected_opening')::numeric;
  v_closing numeric := (payload->>'closing')::numeric;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_type text := coalesce(nullif(payload->>'movement_type', ''), 'BILL');
  v_reason text := nullif(payload->>'reason', '');
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to reconcile pharmacy stock';
  end if;
  if v_key is null or v_bill_id is null then
    raise exception 'movement_key and bill_id are required';
  end if;
  if v_type <> 'BILL' then
    raise exception 'Only BILL stock reconciliation is supported';
  end if;
  if v_expected is null or v_closing is null or v_delta is null then
    raise exception 'expected_opening, closing and quantity_delta are required';
  end if;
  if abs((v_expected + v_delta) - v_closing) > 0.0005 then
    raise exception 'Invalid stock arithmetic: opening % + delta % <> closing %', v_expected, v_delta, v_closing;
  end if;

  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED', 'movement_id', v_existing.id,
      'movement_key', v_existing.movement_key, 'stock_batch_id', v_batch_id,
      'opening', v_existing.opening, 'closing', v_existing.closing
    );
  end if;

  if v_batch_id is not null then
    select * into v_batch from public.stock_batches where id = v_batch_id for update;
    if not found then raise exception 'Cloud stock batch % was not found', v_batch_id; end if;
    if v_item_id is not null and v_batch.item_id <> v_item_id then
      raise exception 'Cloud stock batch item identity mismatch';
    end if;
    if v_location_id is not null and v_batch.location_id <> v_location_id then
      raise exception 'Cloud stock batch location identity mismatch';
    end if;
    if v_batch_no is not null and lower(btrim(coalesce(v_batch.batch_no, ''))) <> lower(v_batch_no) then
      raise exception 'Cloud stock batch number identity mismatch';
    end if;
  else
    if v_item_id is null or v_location_id is null or v_batch_no is null then
      raise exception 'Fallback requires item_id, location_id and batch_no';
    end if;
    select array_agg(id order by id) into v_batch_ids
    from public.stock_batches
    where item_id = v_item_id and location_id = v_location_id
      and lower(btrim(coalesce(batch_no, ''))) = lower(v_batch_no);
    if coalesce(array_length(v_batch_ids, 1), 0) = 0 then
      raise exception 'Fallback stock batch match not found';
    end if;
    if array_length(v_batch_ids, 1) <> 1 then
      raise exception 'Fallback stock batch match is ambiguous (% rows)', array_length(v_batch_ids, 1);
    end if;
    v_batch_id := v_batch_ids[1];
    select * into v_batch from public.stock_batches where id = v_batch_id for update;
  end if;

  -- A concurrent caller may have applied this movement while this call waited
  -- for the batch lock. Recheck the immutable key before validating quantity.
  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED', 'movement_id', v_existing.id,
      'movement_key', v_existing.movement_key, 'stock_batch_id', v_batch.id,
      'opening', v_existing.opening, 'closing', v_existing.closing
    );
  end if;

  if abs(v_batch.qty - v_expected) > 0.0005 then
    return jsonb_build_object(
      'status', 'CONFLICT', 'movement_key', v_key, 'stock_batch_id', v_batch.id,
      'expected_opening', v_expected, 'actual_opening', v_batch.qty,
      'requested_closing', v_closing
    );
  end if;

  update public.stock_batches set qty = v_closing where id = v_batch.id;
  insert into public.stock_movements (
    movement_key, item_id, location_id, batch_no, type, qty,
    opening, closing, bill_id, reason
  ) values (
    v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, v_type, v_delta,
    v_expected, v_closing, v_bill_id, v_reason
  ) returning * into v_existing;

  return jsonb_build_object(
    'status', 'APPLIED', 'movement_id', v_existing.id,
    'movement_key', v_existing.movement_key, 'stock_batch_id', v_batch.id,
    'opening', v_existing.opening, 'closing', v_existing.closing
  );
end;
$$;

alter function public.reconcile_stock_movement(jsonb) owner to postgres;
revoke all on function public.reconcile_stock_movement(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_stock_movement(jsonb) to authenticated, service_role;

commit;
