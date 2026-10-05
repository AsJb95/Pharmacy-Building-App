-- REVIEW ONLY: do not apply as part of the packaged-build validation.
-- Adds the v3.18.2 financial-sync contract without replaying sales or stock.

begin;

-- Production may already use a GENERATED ALWAYS identity seq column, while
-- legacy/test schemas may have a required bigint seq with no allocator. Keep
-- identity semantics intact, and install the trigger allocator only for the
-- legacy non-identity shape.
lock table public.stock_movements in access exclusive mode;
alter table public.stock_movements add column if not exists seq bigint;

do $$
declare
  v_sequence regclass;
  v_last_seq bigint;
  v_max_seq bigint;
  v_is_called boolean;
  v_seq_attnum smallint;
  v_attidentity "char";
  v_null_seq_count bigint;
begin
  select a.attidentity into v_attidentity
  from pg_attribute a
  where a.attrelid = 'public.stock_movements'::regclass
    and a.attname = 'seq' and not a.attisdropped;

  if v_attidentity in ('a', 'd') then
    select count(*) into v_null_seq_count from public.stock_movements where seq is null;
    if v_null_seq_count > 0 then
      raise exception 'Identity-backed stock_movements.seq has % NULL value(s); manual review required', v_null_seq_count;
    end if;
  else
    with seq_base as (
      select greatest(coalesce(max(seq), 0), 0)::bigint as last_seq
      from public.stock_movements
    ), missing as (
      select id, row_number() over (order by created_at, id)::bigint as row_no
      from public.stock_movements
      where seq is null
    )
    update public.stock_movements sm
    set seq = seq_base.last_seq + missing.row_no
    from missing cross join seq_base
    where sm.id = missing.id;
  end if;

  alter table public.stock_movements alter column seq set not null;

  select max(seq) into v_max_seq from public.stock_movements;

  if exists (
    select 1 from public.stock_movements group by seq having count(*) > 1
  ) then
    raise exception 'Duplicate stock_movements.seq values require review';
  end if;

  if to_regclass('public.stock_movements_seq_uq') is not null then
    select a.attnum into v_seq_attnum
    from pg_attribute a
    where a.attrelid = 'public.stock_movements'::regclass
      and a.attname = 'seq' and not a.attisdropped;
    if not exists (
      select 1 from pg_index i
      where i.indexrelid = 'public.stock_movements_seq_uq'::regclass
        and i.indrelid = 'public.stock_movements'::regclass
        and i.indisunique and i.indpred is null
        and i.indnkeyatts = 1 and i.indkey::text = v_seq_attnum::text
    ) then
      raise exception 'stock_movements_seq_uq exists with an incompatible definition';
    end if;
  end if;

  v_sequence := pg_get_serial_sequence('public.stock_movements', 'seq')::regclass;
  if v_attidentity in ('a', 'd') then
    if v_sequence is null then
      raise exception 'Identity-backed stock_movements.seq has no owned sequence';
    end if;
  elsif v_sequence is null then
    if to_regclass('public.stock_movements_seq_alloc_seq') is not null then
      raise exception 'stock_movements_seq_alloc_seq exists but is not owned by stock_movements.seq';
    end if;
    create sequence public.stock_movements_seq_alloc_seq as bigint;
    alter sequence public.stock_movements_seq_alloc_seq owned by public.stock_movements.seq;
    v_sequence := 'public.stock_movements_seq_alloc_seq'::regclass;
  end if;

  execute format('select last_value, is_called from %s', v_sequence)
    into v_last_seq, v_is_called;
  if v_max_seq is not null and (not v_is_called or v_last_seq < v_max_seq) then
    perform setval(v_sequence, v_max_seq, true);
  end if;

  if v_attidentity in ('a', 'd') then
    drop trigger if exists stock_movements_assign_seq_before_insert on public.stock_movements;
  end if;
end;
$$;

create unique index if not exists stock_movements_seq_uq
  on public.stock_movements (seq);

do $$
declare
  v_attidentity "char";
begin
  select a.attidentity into v_attidentity
  from pg_attribute a
  where a.attrelid = 'public.stock_movements'::regclass
    and a.attname = 'seq' and not a.attisdropped;

  if v_attidentity not in ('a', 'd') then
    create or replace function public.vhc_stock_movements_assign_seq()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog, public
    as $fn$
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
        execute format('select last_value, is_called from %s', v_sequence)
          into v_last_seq, v_is_called;
        if new.seq > 0 and (not v_is_called or new.seq > v_last_seq) then
          perform setval(v_sequence, new.seq, true);
        end if;
      end if;

      return new;
    end;
    $fn$;

    alter function public.vhc_stock_movements_assign_seq() owner to postgres;
    revoke all on function public.vhc_stock_movements_assign_seq() from public, anon, authenticated, service_role;
    drop trigger if exists stock_movements_assign_seq_before_insert on public.stock_movements;
    create trigger stock_movements_assign_seq_before_insert
    before insert on public.stock_movements
    for each row execute function public.vhc_stock_movements_assign_seq();
  end if;
end;
$$;

alter table public.sales add column if not exists amount_received numeric(14,2);
alter table public.sales add column if not exists outstanding_amount numeric(14,2);
alter table public.sales add column if not exists payment_status text;
alter table public.sales add column if not exists payment_breakdown jsonb;
alter table public.sales add column if not exists recorded_by text;
alter table public.sales add column if not exists patient_snapshot jsonb;
alter table public.sales add column if not exists updated_at timestamptz not null default now();

alter table public.sale_items add column if not exists stock_batch_id uuid references public.stock_batches(id);
alter table public.sale_items add column if not exists logical_key text;
alter table public.sale_items add column if not exists created_at timestamptz not null default now();

-- Existing rows receive their semantic key. If a historical sale contains
-- repeated identical lines, suffix later occurrences so no row is removed.
with keyed as (
  select id,
    md5(concat_ws('|', coalesce(item_id::text,''), coalesce(stock_batch_id::text,''),
      coalesce(drug_name,''), coalesce(batch_no,''), coalesce(quantity::text,''),
      coalesce(rate::text,''), coalesce(total::text,''), coalesce(category,''))) as base_key,
    row_number() over (
      partition by sale_id, item_id, stock_batch_id, drug_name, batch_no, quantity, rate, total, category
      order by id
    ) as duplicate_number
  from public.sale_items
  where logical_key is null
)
update public.sale_items si
set logical_key = case when keyed.duplicate_number = 1 then keyed.base_key
  else md5(keyed.base_key || '|duplicate|' || keyed.duplicate_number::text) end
from keyed where keyed.id = si.id;

alter table public.sale_items alter column logical_key set not null;
create unique index if not exists sale_items_sale_id_logical_key_uq
  on public.sale_items (sale_id, logical_key);

-- Production metadata captured read-only on 2026-09-27:
--   owner=postgres, return=public.sales, SECURITY DEFINER,
--   search_path=public, EXECUTE=PUBLIC/postgres/anon/authenticated/service_role.
-- Abort instead of guessing if those security-sensitive properties drift.
do $$
declare
  v_proc oid;
  v_owner text;
  v_result text;
  v_security_definer boolean;
  v_config text[];
  v_dependents text;
  v_grants text[];
begin
  select p.oid, pg_get_userbyid(p.proowner), pg_get_function_result(p.oid),
    p.prosecdef, p.proconfig
  into v_proc, v_owner, v_result, v_security_definer, v_config
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='create_sale'
    and pg_get_function_identity_arguments(p.oid)='payload jsonb';

  if v_proc is null then raise exception 'Expected public.create_sale(payload jsonb)'; end if;
  if v_owner <> 'postgres' then raise exception 'Unexpected create_sale owner: %', v_owner; end if;
  if v_result not in ('sales', 'public.sales', 'uuid') then
    raise exception 'Unexpected create_sale return type: %', v_result;
  end if;
  if not v_security_definer then
    raise exception 'Expected create_sale SECURITY DEFINER';
  end if;
  if v_config is distinct from array['search_path=public']::text[] then
    raise exception 'Unexpected create_sale configuration: %', v_config;
  end if;

  select string_agg(pg_describe_object(d.classid,d.objid,d.objsubid), ', ')
  into v_dependents from pg_depend d
  where d.refclassid='pg_proc'::regclass and d.refobjid=v_proc and d.objid<>v_proc;
  if v_result = 'uuid' and v_dependents is not null then
    raise exception 'UUID create_sale has dependents; cannot safely restore its return type: %', v_dependents;
  end if;

  select array_agg((case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)
    order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end))
  into v_grants
  from aclexplode(coalesce((select proacl from pg_proc where oid=v_proc),
    acldefault('f',(select proowner from pg_proc where oid=v_proc)))) a
  where a.privilege_type='EXECUTE' and not a.is_grantable;
  if v_grants is distinct from array['PUBLIC','anon','authenticated','postgres','service_role']::text[] then
    raise exception 'Unexpected create_sale EXECUTE grants: %', v_grants;
  end if;

  if v_result = 'uuid' then
    execute 'drop function public.create_sale(jsonb)';
  end if;
end $$;

-- Production's existing RETURNS public.sales contract is retained in place.
-- Only a database previously changed to UUID needs an exact-signature drop;
-- that repair is guarded by the dependency check above and never uses CASCADE.
create or replace function public.create_sale(payload jsonb)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_sale_id uuid;
  v_item jsonb;
  v_key text;
  v_batch record;
  v_remaining numeric;
  v_take numeric;
  v_affects_stock boolean;
  v_expiry date;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to create sales';
  end if;

  insert into public.sales (
    bill_id, patient_id, patient_name, patient_snapshot, doctor_name, payment_mode,
    subtotal, total_tax, total_amount, amount_received, outstanding_amount,
    payment_status, payment_breakdown, recorded_by, gst_mode, discount,
    discount_percent, location_id, sale_date
  ) values (
    payload->>'bill_id', nullif(payload->>'patient_id','')::uuid,
    payload->>'patient_name', payload->'patient_snapshot', payload->>'doctor_name',
    payload->>'payment_mode', nullif(payload->>'subtotal','')::numeric,
    nullif(payload->>'total_tax','')::numeric,
    coalesce(nullif(payload->>'total_amount','')::numeric,0),
    nullif(payload->>'amount_received','')::numeric,
    nullif(payload->>'outstanding_amount','')::numeric, payload->>'payment_status',
    payload->'payment_breakdown', payload->>'recorded_by', payload->>'gst_mode',
    nullif(payload->>'discount','')::numeric,
    nullif(payload->>'discount_percent','')::numeric,
    (payload->>'location_id')::uuid,
    coalesce(nullif(payload->>'sale_date','')::timestamptz,now())
  ) on conflict (bill_id) do update set updated_at=now()
  returning * into v_sale;
  v_sale_id := v_sale.id;

  for v_item in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    v_key := md5(concat_ws('|', coalesce(v_item->>'item_id',''),
      coalesce(v_item->>'stock_batch_id',''), coalesce(v_item->>'drug_name',''),
      coalesce(v_item->>'batch_no',''), coalesce(v_item->>'quantity',''),
      coalesce(v_item->>'rate',''), coalesce(v_item->>'total',''),
      coalesce(v_item->>'category','')));
    v_affects_stock := coalesce((v_item->>'affects_stock')::boolean, true)
      and nullif(v_item->>'item_id','') is not null;

    if to_regprocedure('public.safe_date(text)') is not null then
      execute 'select public.safe_date($1)' into v_expiry using v_item->>'expiry_date';
    else
      begin
        v_expiry := nullif(v_item->>'expiry_date','')::date;
      exception when others then
        v_expiry := null;
      end;
    end if;

    insert into public.sale_items (
      sale_id, item_id, stock_batch_id, category, drug_name, batch_no,
      expiry_date, quantity, rate, total, affects_stock, metadata, logical_key
    ) values (
      v_sale_id, nullif(v_item->>'item_id','')::uuid,
      nullif(v_item->>'stock_batch_id','')::uuid, v_item->>'category',
      v_item->>'drug_name', nullif(v_item->>'batch_no',''),
      v_expiry,
      coalesce(nullif(v_item->>'quantity','')::numeric, 0),
      coalesce(nullif(v_item->>'rate','')::numeric, 0),
      coalesce(nullif(v_item->>'total','')::numeric, 0),
      v_affects_stock, coalesce(v_item->'metadata','{}'::jsonb), v_key
    ) on conflict (sale_id, logical_key) do nothing;

    if not found or not v_affects_stock then continue; end if;
    v_remaining := coalesce(nullif(v_item->>'quantity','')::numeric, 0);
    if nullif(v_item->>'stock_batch_id','') is not null then
      update public.stock_batches set qty = qty - v_remaining
      where id = (v_item->>'stock_batch_id')::uuid;
      if not found then raise exception 'Stock batch % was not found', v_item->>'stock_batch_id'; end if;
      if exists (select 1 from information_schema.columns
        where table_schema='public' and table_name='stock_movements' and column_name='created_by') then
        insert into public.stock_movements
          (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
        select item_id, location_id, batch_no, 'BILL', -v_remaining, payload->>'bill_id',
          nullif(payload->>'patient_id','')::uuid, 'Bill created', auth.uid()
        from public.stock_batches where id = (v_item->>'stock_batch_id')::uuid;
      else
        insert into public.stock_movements
          (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason)
        select item_id, location_id, batch_no, 'BILL', -v_remaining, payload->>'bill_id',
          nullif(payload->>'patient_id','')::uuid, 'Bill created'
        from public.stock_batches where id = (v_item->>'stock_batch_id')::uuid;
      end if;
    else
      for v_batch in select id, qty, item_id, location_id, batch_no
        from public.stock_batches where item_id = (v_item->>'item_id')::uuid
          and location_id = (payload->>'location_id')::uuid and qty > 0
        order by expiry_date nulls last
      loop
        exit when v_remaining <= 0;
        v_take := least(v_remaining, v_batch.qty);
        update public.stock_batches set qty = qty - v_take where id = v_batch.id;
        insert into public.stock_movements
          (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
        values (v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'BILL', -v_take,
          payload->>'bill_id', nullif(payload->>'patient_id','')::uuid, 'Bill created', auth.uid());
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'Insufficient stock for item %', v_item->>'drug_name'; end if;
    end if;
  end loop;
  return v_sale;
end;
$$;

alter function public.create_sale(jsonb) owner to postgres;
revoke all on function public.create_sale(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_sale(jsonb) to public, postgres, anon, authenticated, service_role;

-- Keep restore_sale_history's pre-existing return type and security mode. Its
-- payload still marks every restored line record-only, so no stock is deducted.
do $restore$
declare
  v_restore_oid oid;
  v_result text;
  v_return_type text;
  v_return_expression text;
  v_security_clause text;
  v_security_definer boolean;
begin
  select p.oid, pg_get_function_result(p.oid), p.prosecdef
  into v_restore_oid, v_result, v_security_definer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='restore_sale_history'
    and pg_get_function_identity_arguments(p.oid)='payload jsonb';

  if v_restore_oid is null then
    v_result := 'sales';
    v_security_definer := true;
  end if;
  if v_result not in ('uuid', 'sales', 'public.sales') then
    raise exception 'Unsupported restore_sale_history return type: %', v_result;
  end if;

  if v_result = 'uuid' then
    v_return_type := 'uuid';
    v_return_expression := 'v_sale.id';
  else
    v_return_type := 'public.sales';
    v_return_expression := 'v_sale';
  end if;
  v_security_clause := case when v_security_definer then 'SECURITY DEFINER' else 'SECURITY INVOKER' end;

  execute format($ddl$
    create or replace function public.restore_sale_history(payload jsonb)
    returns %s language plpgsql %s set search_path = public
    as $body$
    declare v_sale public.sales; v_sale_id uuid;
    begin
      v_sale := public.create_sale(payload || jsonb_build_object('items',
        (select coalesce(jsonb_agg(value || jsonb_build_object('affects_stock', false)), '[]'::jsonb)
         from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)))));
      v_sale_id := v_sale.id;
      return %s;
    end;
    $body$;
  $ddl$, v_return_type, v_security_clause, v_return_expression);
end;
$restore$;

do $$
declare
  v_result text;
  v_owner text;
  v_security_definer boolean;
  v_config text[];
  v_grants text[];
begin
  select pg_get_function_result(p.oid), pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  into v_result, v_owner, v_security_definer, v_config
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='create_sale'
    and pg_get_function_identity_arguments(p.oid)='payload jsonb';
  if v_result is null or v_result not in ('sales', 'public.sales')
    or v_owner <> 'postgres' or not v_security_definer
    or v_config is distinct from array['search_path=public']::text[] then
    raise exception 'create_sale postflight metadata verification failed';
  end if;

  select array_agg((case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)
    order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end))
  into v_grants
  from aclexplode(coalesce((select proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='create_sale'
      and pg_get_function_identity_arguments(p.oid)='payload jsonb'),
    acldefault('f',(select p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='create_sale'
        and pg_get_function_identity_arguments(p.oid)='payload jsonb')))) a
  where a.privilege_type='EXECUTE' and not a.is_grantable;
  if v_grants is distinct from array['PUBLIC','anon','authenticated','postgres','service_role']::text[] then
    raise exception 'create_sale postflight EXECUTE grants verification failed: %', v_grants;
  end if;
end $$;

commit;

