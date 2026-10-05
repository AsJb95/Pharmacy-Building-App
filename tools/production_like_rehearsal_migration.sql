-- REVIEW ONLY: do not apply as part of the packaged-build validation.
-- Adds the v3.18.2 financial-sync contract without replaying sales or stock.

begin;

alter table vhc_prod_rehearsal.sales add column if not exists amount_received numeric(14,2);
alter table vhc_prod_rehearsal.sales add column if not exists outstanding_amount numeric(14,2);
alter table vhc_prod_rehearsal.sales add column if not exists payment_status text;
alter table vhc_prod_rehearsal.sales add column if not exists payment_breakdown jsonb;
alter table vhc_prod_rehearsal.sales add column if not exists recorded_by text;
alter table vhc_prod_rehearsal.sales add column if not exists patient_snapshot jsonb;
alter table vhc_prod_rehearsal.sales add column if not exists updated_at timestamptz not null default now();

alter table vhc_prod_rehearsal.sale_items add column if not exists stock_batch_id uuid references vhc_prod_rehearsal.stock_batches(id);
alter table vhc_prod_rehearsal.sale_items add column if not exists logical_key text;
alter table vhc_prod_rehearsal.sale_items add column if not exists created_at timestamptz not null default now();

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
  from vhc_prod_rehearsal.sale_items
  where logical_key is null
)
update vhc_prod_rehearsal.sale_items si
set logical_key = case when keyed.duplicate_number = 1 then keyed.base_key
  else md5(keyed.base_key || '|duplicate|' || keyed.duplicate_number::text) end
from keyed where keyed.id = si.id;

alter table vhc_prod_rehearsal.sale_items alter column logical_key set not null;
create unique index if not exists sale_items_sale_id_logical_key_uq
  on vhc_prod_rehearsal.sale_items (sale_id, logical_key);

-- Production metadata captured read-only on 2026-09-27:
--   owner=postgres, return=vhc_prod_rehearsal.sales, SECURITY DEFINER,
--   search_path=vhc_prod_rehearsal, EXECUTE=PUBLIC/postgres/anon/authenticated/service_role,
--   incoming dependencies=none.
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
  where n.nspname='vhc_prod_rehearsal' and p.proname='create_sale'
    and pg_get_function_identity_arguments(p.oid)='payload jsonb';

  if v_proc is null then raise exception 'Expected vhc_prod_rehearsal.create_sale(payload jsonb)'; end if;
  if v_owner <> 'postgres' then raise exception 'Unexpected create_sale owner: %', v_owner; end if;
  if v_result not in ('vhc_prod_rehearsal.sales','uuid') then raise exception 'Unexpected create_sale return type: %', v_result; end if;
  if v_result = 'vhc_prod_rehearsal.sales' and not v_security_definer then
    raise exception 'Expected legacy create_sale SECURITY DEFINER';
  end if;
  if v_config is distinct from array['search_path=vhc_prod_rehearsal']::text[] then
    raise exception 'Unexpected create_sale configuration: %', v_config;
  end if;

  select string_agg(pg_describe_object(d.classid,d.objid,d.objsubid), ', ')
  into v_dependents from pg_depend d
  where d.refclassid='pg_proc'::regclass and d.refobjid=v_proc and d.objid<>v_proc;
  if v_dependents is not null then
    raise exception 'create_sale has dependents; review before replacement: %', v_dependents;
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
end $$;

-- CREATE OR REPLACE cannot change vhc_prod_rehearsal.sales -> uuid. No CASCADE is used;
-- the preflight above proves there are no incoming dependencies.
drop function vhc_prod_rehearsal.create_sale(jsonb);

create function vhc_prod_rehearsal.create_sale(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = vhc_prod_rehearsal
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_key text;
  v_batch record;
  v_remaining numeric;
  v_take numeric;
  v_affects_stock boolean;
begin
  if not coalesce(vhc_prod_rehearsal.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to create sales';
  end if;

  insert into vhc_prod_rehearsal.sales (
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
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb)) loop
    v_key := md5(concat_ws('|', coalesce(v_item->>'item_id',''),
      coalesce(v_item->>'stock_batch_id',''), coalesce(v_item->>'drug_name',''),
      coalesce(v_item->>'batch_no',''), coalesce(v_item->>'quantity',''),
      coalesce(v_item->>'rate',''), coalesce(v_item->>'total',''),
      coalesce(v_item->>'category','')));
    v_affects_stock := coalesce((v_item->>'affects_stock')::boolean, true)
      and nullif(v_item->>'item_id','') is not null;

    insert into vhc_prod_rehearsal.sale_items (
      sale_id, item_id, stock_batch_id, category, drug_name, batch_no,
      expiry_date, quantity, rate, total, affects_stock, metadata, logical_key
    ) values (
      v_sale_id, nullif(v_item->>'item_id','')::uuid,
      nullif(v_item->>'stock_batch_id','')::uuid, v_item->>'category',
      v_item->>'drug_name', nullif(v_item->>'batch_no',''),
      vhc_prod_rehearsal.safe_date(v_item->>'expiry_date'),
      coalesce(nullif(v_item->>'quantity','')::numeric, 0),
      coalesce(nullif(v_item->>'rate','')::numeric, 0),
      coalesce(nullif(v_item->>'total','')::numeric, 0),
      v_affects_stock, coalesce(v_item->'metadata','{}'::jsonb), v_key
    ) on conflict (sale_id, logical_key) do nothing;

    if not found or not v_affects_stock then continue; end if;
    v_remaining := coalesce(nullif(v_item->>'quantity','')::numeric, 0);
    if nullif(v_item->>'stock_batch_id','') is not null then
      update vhc_prod_rehearsal.stock_batches set qty = qty - v_remaining
      where id = (v_item->>'stock_batch_id')::uuid;
      if not found then raise exception 'Stock batch % was not found', v_item->>'stock_batch_id'; end if;
      insert into vhc_prod_rehearsal.stock_movements
        (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
      select item_id, location_id, batch_no, 'BILL', -v_remaining, payload->>'bill_id',
        nullif(payload->>'patient_id','')::uuid, 'Bill created', auth.uid()
      from vhc_prod_rehearsal.stock_batches where id = (v_item->>'stock_batch_id')::uuid;
    else
      for v_batch in select id, qty, item_id, location_id, batch_no
        from vhc_prod_rehearsal.stock_batches where item_id = (v_item->>'item_id')::uuid
          and location_id = (payload->>'location_id')::uuid and qty > 0
        order by expiry_date nulls last
      loop
        exit when v_remaining <= 0;
        v_take := least(v_remaining, v_batch.qty);
        update vhc_prod_rehearsal.stock_batches set qty = qty - v_take where id = v_batch.id;
        insert into vhc_prod_rehearsal.stock_movements
          (item_id, location_id, batch_no, type, qty, bill_id, patient_id, reason, created_by)
        values (v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'BILL', -v_take,
          payload->>'bill_id', nullif(payload->>'patient_id','')::uuid, 'Bill created', auth.uid());
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'Insufficient stock for item %', v_item->>'drug_name'; end if;
    end if;
  end loop;
  return v_sale_id;
end;
$$;

alter function vhc_prod_rehearsal.create_sale(jsonb) owner to postgres;
revoke all on function vhc_prod_rehearsal.create_sale(jsonb) from public, anon, authenticated, service_role;
grant execute on function vhc_prod_rehearsal.create_sale(jsonb) to public, postgres, anon, authenticated, service_role;

create or replace function vhc_prod_rehearsal.restore_sale_history(payload jsonb)
returns vhc_prod_rehearsal.sales
language sql
security definer
set search_path = vhc_prod_rehearsal
as $$
  with created as (
    select vhc_prod_rehearsal.create_sale(payload || jsonb_build_object('items',
      (select coalesce(jsonb_agg(value || jsonb_build_object('affects_stock', false)), '[]'::jsonb)
       from jsonb_array_elements(coalesce(payload->'items','[]'::jsonb))))) as id
  )
  select s.* from vhc_prod_rehearsal.sales s join created on created.id=s.id;
$$;

do $$
declare
  v_result text;
  v_owner text;
  v_security_definer boolean;
  v_config text[];
begin
  select pg_get_function_result(p.oid), pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  into v_result, v_owner, v_security_definer, v_config
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='vhc_prod_rehearsal' and p.proname='create_sale'
    and pg_get_function_identity_arguments(p.oid)='payload jsonb';
  if v_result <> 'uuid' or v_owner <> 'postgres' or not v_security_definer
    or v_config is distinct from array['search_path=vhc_prod_rehearsal']::text[] then
    raise exception 'create_sale postflight metadata verification failed';
  end if;
end $$;

commit;


