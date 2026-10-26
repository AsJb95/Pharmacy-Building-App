-- VHC Pharmacy — v3.19.7 pre-Production fixes (review 2026-10-26). PREPARED; TEST only until approved.
-- REQUIRES: 20261022000100_stock_correction_rpcs.sql, 20261023000100_stock_sync_remediation.sql (identity index),
--           20261023000200_restore_bill_stock_patient_fix.sql. Run in ONE transaction, after them.
-- Replaces TWO functions. No table, column, index, policy, grant or data change; no existing row is rewritten.
--
-- 1. accept_pharmacy_transfer: batch identity is now lower(btrim(coalesce(batch_no, ''))) — the same rule as
--    stock_batches_identity_uq, apply_bill_stock_movement(s), restore_bill_stock and create_stock_batch.
--    Defect: batches were matched with an EXACT batch_no. A line/batch differing only in case or surrounding spaces
--    (Production: 1 such pharmacy/Main Stock pair on 2026-10-26) found no pharmacy batch, tried to INSERT a second
--    one and hit stock_batches_identity_uq: unhandled unique_violation, HTTP error, transfer stuck Pending.
--    Now: existing batches are found case/space-insensitively; a new pharmacy batch takes the Main Stock batch's
--    own batch_no; the per-identity advisory lock uses create_stock_batch's key ('vhc-batch:<item>:<loc>:<norm>')
--    so a concurrent batch create and a transfer accept serialise; any duplicate that still appears (a write that
--    bypasses that lock) returns CONFLICT_DESTINATION_EXISTS / CONFLICT_MOVEMENT_KEY_EXISTS and other constraint
--    failures CONFLICT_TRANSFER_WRITE_FAILED — every write of the call rolled back, order still Pending.
-- 2. apply_stock_restore: payload->>'patient_id' is IGNORED (same defect and fix as T7 / 20261023000200). The
--    counter may send its LOCAL patient id: not a cloud patients.id (stock_movements_patient_id_fkey failure) or
--    not even a uuid (cast error). The RESTORE row now carries the patient recorded on this bill's BILL
--    deduction(s) of the same batch identity when exactly one is recorded, else NULL. Constraint failures in the
--    write block return {status:'CONFLICT', conflict:'CONFLICT_RESTORE_WRITE_FAILED'} with the block rolled back.
-- Unchanged: SECURITY INVOKER (caller's RLS decides), fixed search_path, actor from auth.uid(), status names and
-- result shape used by v3.19.7, movement keys, unit conversion (vhc_transfer_dest_qty), EXECUTE grants.
-- Rollback: re-run the two function bodies from 20261022000100_stock_correction_rpcs.sql.

create or replace function public.apply_stock_restore(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_bill_id text := nullif(btrim(payload->>'bill_id'), '');
  v_batch_id uuid := nullif(payload->>'stock_batch_id', '')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_reason text := btrim(coalesce(payload->>'reason', ''));
  v_patient uuid;
  v_patients uuid[];
  v_key text;
  v_batch public.stock_batches%rowtype;
  v_loc_type text;
  v_existing public.stock_movements%rowtype;
  v_rows int;
begin
  if v_actor is null then
    raise exception 'An authenticated user is required for a stock restore';
  end if;
  if v_bill_id is null or v_batch_id is null then
    raise exception 'bill_id and stock_batch_id are required';
  end if;
  if v_delta is null or v_delta = 'NaN'::numeric or v_delta <= 0 then
    raise exception 'quantity_delta must be a positive number for a RESTORE movement';
  end if;
  if not public.vhc_manual_stock_reason_ok(v_reason) then
    return jsonb_build_object('status', 'REJECTED_REASON', 'reason', v_reason);
  end if;
  -- 20261026000100: payload->>'patient_id' is IGNORED (never read, never cast).
  v_key := 'VHC:RESTORE:' || v_bill_id || ':' || v_batch_id::text;

  select * into v_batch from public.stock_batches where id = v_batch_id for update;
  if not found then
    if exists (select 1 from public.stock_batches where id = v_batch_id) then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_batch_id);
    end if;
    return jsonb_build_object('status', 'CONFLICT_BATCH_NOT_FOUND', 'stock_batch_id', v_batch_id);
  end if;
  select type into v_loc_type from public.locations where id = v_batch.location_id;
  if v_loc_type is distinct from 'pharmacy_counter' then
    return jsonb_build_object('status', 'CONFLICT_NOT_PHARMACY_BATCH', 'stock_batch_id', v_batch.id);
  end if;

  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    if v_existing.type <> 'RESTORE' or abs(coalesce(v_existing.qty, 0) - v_delta) > 0.0005
       or v_existing.bill_id is distinct from v_bill_id then
      return jsonb_build_object('status', 'CONFLICT_MOVEMENT_MISMATCH', 'movement_key', v_key, 'movement_id', v_existing.id,
        'existing_qty', v_existing.qty, 'requested_qty', v_delta);
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
      'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing);
  end if;
  -- Restores written by older app versions carry no movement_key (unchanged rule).
  select * into v_existing from public.stock_movements
   where movement_key is null and type = 'RESTORE' and bill_id = v_bill_id
     and item_id = v_batch.item_id and location_id = v_batch.location_id
     and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_batch.batch_no, '')))
   order by created_at limit 1;
  if found then
    if abs(coalesce(v_existing.qty, 0) - v_delta) > 0.0005 then
      return jsonb_build_object('status', 'CONFLICT_MOVEMENT_MISMATCH', 'movement_id', v_existing.id, 'legacy', true,
        'existing_qty', v_existing.qty, 'requested_qty', v_delta);
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'legacy', true,
      'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing);
  end if;

  -- Patient = the one recorded on this bill's deduction(s) of this batch identity (already FK-valid; a referenced
  -- patients row cannot be deleted). None or several different ones -> NULL (never guessed).
  select array_agg(distinct patient_id) filter (where patient_id is not null) into v_patients
    from public.stock_movements
   where bill_id = v_bill_id and type = 'BILL'
     and item_id = v_batch.item_id and location_id = v_batch.location_id
     and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_batch.batch_no, '')));
  if coalesce(array_length(v_patients, 1), 0) = 1 then v_patient := v_patients[1]; end if;

  begin
    update public.stock_batches set qty = v_batch.qty + v_delta, updated_at = v_now where id = v_batch.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'Stock batch % was not updated (not permitted); nothing was changed', v_batch.id using errcode = 'insufficient_privilege';
    end if;
    insert into public.stock_movements (
      movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason, created_by, created_at
    ) values (
      v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'RESTORE', v_delta, v_batch.qty, v_batch.qty + v_delta,
      v_bill_id, v_patient, v_reason, v_actor, v_now
    ) returning * into v_existing;
  exception
    when unique_violation then
      select * into v_existing from public.stock_movements where movement_key = v_key;
      return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
        'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing, 'race', true);
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_batch.id);
    when foreign_key_violation or check_violation or not_null_violation then
      return jsonb_build_object('status', 'CONFLICT', 'conflict', 'CONFLICT_RESTORE_WRITE_FAILED', 'stock_batch_id', v_batch.id,
        'sqlstate', sqlstate, 'error', sqlerrm);
  end;

  return jsonb_build_object('status', 'APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
    'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing, 'created_by', v_actor);
end;
$$;
revoke all on function public.apply_stock_restore(jsonb) from public, anon;
grant execute on function public.apply_stock_restore(jsonb) to authenticated, service_role;

create or replace function public.accept_pharmacy_transfer(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_id uuid := nullif(payload->>'transfer_id', '')::uuid;
  v_t public.transfer_orders%rowtype;
  v_main uuid;
  v_pharm uuid;
  v_count int;
  v_line record;
  v_src public.stock_batches%rowtype;
  v_dst public.stock_batches%rowtype;
  v_src_ids uuid[];
  v_dst_ids uuid[];
  v_need jsonb := '{}'::jsonb;
  v_lines int := 0;
  v_rows int;
  v_locked boolean;
  v_unit text;
  v_upp numeric;
  v_dest numeric;
  v_note text;
  v_cons text;
begin
  if v_actor is null then
    raise exception 'An authenticated user is required to accept a transfer';
  end if;
  if v_id is null then
    raise exception 'transfer_id is required';
  end if;

  select * into v_t from public.transfer_orders where id = v_id for update;
  v_locked := found;
  if not v_locked then
    select * into v_t from public.transfer_orders where id = v_id;
    if not found then
      return jsonb_build_object('status', 'NOT_FOUND', 'transfer_id', v_id);
    end if;
  end if;
  if v_t.status is distinct from 'Pending' then
    return jsonb_build_object('status', case when v_t.status = 'Completed' then 'ALREADY_COMPLETED' else 'NOT_PENDING' end,
      'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number, 'current_status', v_t.status);
  end if;
  if not v_locked then
    return jsonb_build_object('status', 'NOT_PERMITTED', 'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number);
  end if;

  select count(*), min(id::text)::uuid into v_count, v_main from public.locations where type = 'warehouse_main';
  if v_count <> 1 then return jsonb_build_object('status', 'CONFLICT_LOCATION_AMBIGUOUS', 'location_type', 'warehouse_main', 'matches', v_count); end if;
  select count(*), min(id::text)::uuid into v_count, v_pharm from public.locations where type = 'pharmacy_counter';
  if v_count <> 1 then return jsonb_build_object('status', 'CONFLICT_LOCATION_AMBIGUOUS', 'location_type', 'pharmacy_counter', 'matches', v_count); end if;
  if (v_t.from_location_id is not null and v_t.from_location_id <> v_main) or (v_t.to_location_id is not null and v_t.to_location_id <> v_pharm) then
    return jsonb_build_object('status', 'CONFLICT_LOCATION_MISMATCH', 'transfer_id', v_t.id);
  end if;

  -- Serialise against create_stock_batch and other accepts on every pharmacy batch identity this order may create.
  -- Same key format as create_stock_batch; fixed order; transaction-scoped.
  for v_line in select distinct item_id, lower(btrim(coalesce(batch_no, ''))) as nb from public.transfer_order_items
                where transfer_order_id = v_t.id and qty > 0 and item_id is not null order by 1, 2 loop
    perform pg_advisory_xact_lock(hashtextextended('vhc-batch:' || v_line.item_id || ':' || v_pharm || ':' || v_line.nb, 0));
  end loop;

  -- Phase 1: resolve and lock every batch (id order), validate. No writes.
  select array_agg(distinct b.id order by b.id) into v_src_ids
  from public.transfer_order_items l
  join public.stock_batches b on b.item_id = l.item_id and b.location_id = v_main
       and lower(btrim(coalesce(b.batch_no, ''))) = lower(btrim(coalesce(l.batch_no, '')))
  where l.transfer_order_id = v_t.id and l.qty > 0;
  select array_agg(distinct b.id order by b.id) into v_dst_ids
  from public.transfer_order_items l
  join public.stock_batches b on b.item_id = l.item_id and b.location_id = v_pharm
       and lower(btrim(coalesce(b.batch_no, ''))) = lower(btrim(coalesce(l.batch_no, '')))
  where l.transfer_order_id = v_t.id and l.qty > 0;
  perform 1 from public.stock_batches where id = any(coalesce(v_src_ids, '{}') || coalesce(v_dst_ids, '{}')) order by id for update;

  for v_line in select * from public.transfer_order_items where transfer_order_id = v_t.id and qty > 0 order by id loop
    v_lines := v_lines + 1;
    if v_line.item_id is null then
      return jsonb_build_object('status', 'CONFLICT_LINE_WITHOUT_ITEM', 'line_id', v_line.id, 'name', v_line.name);
    end if;
    v_unit := to_jsonb(v_line)->>'transfer_unit';
    v_upp := (to_jsonb(v_line)->>'units_per_pack')::numeric;
    if public.vhc_transfer_dest_qty(v_line.qty, v_unit, v_upp) is null then
      return jsonb_build_object('status', 'CONFLICT_TRANSFER_UNIT', 'line_id', v_line.id, 'name', v_line.name,
        'transfer_unit', v_unit, 'units_per_pack', v_upp);
    end if;
    select count(*) into v_count from public.stock_batches
      where item_id = v_line.item_id and location_id = v_main
        and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_line.batch_no, '')));
    if v_count <> 1 then
      return jsonb_build_object('status', case when v_count = 0 then 'CONFLICT_SOURCE_NOT_FOUND' else 'CONFLICT_SOURCE_AMBIGUOUS' end,
        'line_id', v_line.id, 'name', v_line.name, 'matches', v_count);
    end if;
    select * into v_src from public.stock_batches
      where item_id = v_line.item_id and location_id = v_main
        and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_line.batch_no, '')));
    v_need := jsonb_set(v_need, array[v_src.id::text], to_jsonb(coalesce((v_need->>v_src.id::text)::numeric, 0) + v_line.qty));
    if (v_need->>v_src.id::text)::numeric > v_src.qty + 0.0005 then
      return jsonb_build_object('status', 'CONFLICT_INSUFFICIENT_STOCK', 'line_id', v_line.id, 'name', v_line.name,
        'available', v_src.qty, 'needed', (v_need->>v_src.id::text)::numeric);
    end if;
    select count(*) into v_count from public.stock_batches
      where item_id = v_line.item_id and location_id = v_pharm
        and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_line.batch_no, '')));
    if v_count > 1 then
      return jsonb_build_object('status', 'CONFLICT_DESTINATION_AMBIGUOUS', 'line_id', v_line.id, 'name', v_line.name, 'matches', v_count);
    end if;
  end loop;
  if v_lines = 0 then
    return jsonb_build_object('status', 'CONFLICT_NO_LINES', 'transfer_id', v_t.id);
  end if;

  -- Phase 2: all writes in one block; any failure rolls back every write of this call (order stays Pending).
  begin
    update public.transfer_orders set status = 'Completed' where id = v_t.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'Transfer % could not be marked Completed (not permitted); nothing was changed', v_t.transfer_number using errcode = 'insufficient_privilege'; end if;
    for v_line in select * from public.transfer_order_items where transfer_order_id = v_t.id and qty > 0 order by id loop
      v_unit := to_jsonb(v_line)->>'transfer_unit';
      v_upp := (to_jsonb(v_line)->>'units_per_pack')::numeric;
      v_dest := public.vhc_transfer_dest_qty(v_line.qty, v_unit, v_upp);
      v_note := case when v_unit is not null and v_upp <> 1
                     then format(' [%s entered; %s/pack conversion applied]', v_unit, trim_scale(v_upp)) else '' end;
      select * into v_src from public.stock_batches
        where item_id = v_line.item_id and location_id = v_main
          and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_line.batch_no, '')));
      update public.stock_batches set qty = qty - v_line.qty, updated_at = v_now where id = v_src.id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'Main Stock batch for % was not updated (not permitted); nothing was changed', v_line.name using errcode = 'insufficient_privilege'; end if;
      insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
      values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':OUT', v_line.item_id, v_main, v_src.batch_no, 'TRANSFER', -v_line.qty,
              v_src.qty, v_src.qty - v_line.qty,
              format('Pharmacy transfer %s accepted (out of Main Stock)', v_t.transfer_number) || v_note, v_actor, v_now);

      select * into v_dst from public.stock_batches
        where item_id = v_line.item_id and location_id = v_pharm
          and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_line.batch_no, '')));
      if found then
        update public.stock_batches set qty = qty + v_dest, updated_at = v_now where id = v_dst.id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'Pharmacy batch for % was not updated (not permitted); nothing was changed', v_line.name using errcode = 'insufficient_privilege'; end if;
        insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
        values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':IN', v_line.item_id, v_pharm, v_dst.batch_no, 'TRANSFER', v_dest,
                v_dst.qty, v_dst.qty + v_dest,
                format('Pharmacy transfer %s accepted (into Pharmacy)', v_t.transfer_number) || v_note, v_actor, v_now);
      else
        -- New pharmacy batch takes the Main Stock batch's own batch_no (no created_at: production has no such column).
        insert into public.stock_batches (item_id, location_id, batch_no, expiry_date, mrp, net_rate, gst, stockist, qty, updated_at)
        values (v_line.item_id, v_pharm, v_src.batch_no, v_line.expiry_date, v_line.mrp, v_line.net_rate, v_src.gst, v_src.stockist,
                v_dest, v_now);
        insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
        values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':IN', v_line.item_id, v_pharm, v_src.batch_no, 'TRANSFER', v_dest,
                0, v_dest,
                format('Pharmacy transfer %s accepted (into Pharmacy, new batch)', v_t.transfer_number) || v_note, v_actor, v_now);
      end if;
    end loop;
  exception
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number);
    when unique_violation then
      get stacked diagnostics v_cons = constraint_name;
      return jsonb_build_object('status', case when v_cons = 'stock_batches_identity_uq' then 'CONFLICT_DESTINATION_EXISTS'
                                               else 'CONFLICT_MOVEMENT_KEY_EXISTS' end,
        'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number, 'constraint', v_cons,
        'reason', 'a matching record was written concurrently; nothing was transferred and the request is still Pending — retry');
    when foreign_key_violation or check_violation or not_null_violation then
      return jsonb_build_object('status', 'CONFLICT_TRANSFER_WRITE_FAILED', 'transfer_id', v_t.id,
        'transfer_number', v_t.transfer_number, 'sqlstate', sqlstate, 'error', sqlerrm);
  end;

  return jsonb_build_object('status', 'APPLIED', 'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number,
    'lines', v_lines, 'created_by', v_actor, 'completed_at', v_now);
end;
$$;
revoke all on function public.accept_pharmacy_transfer(jsonb) from public, anon;
grant execute on function public.accept_pharmacy_transfer(jsonb) to authenticated, service_role;
