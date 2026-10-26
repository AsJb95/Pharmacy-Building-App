-- Stock-sync incident remediation (PREPARED ONLY — not applied to TEST or Production).
--
-- REQUIRES: 20261022000100_stock_correction_rpcs.sql (v3.19.6) applied first (uses vhc_manual_stock_reason_ok).
--
-- WHY (read-only investigation 2026-10-22, Production yrgtnhvnwkqudxdcrkhm):
--   * Bill stock was deducted ONE LINE PER CALL (apply_bill_stock_movement). The client stopped at the first
--     refused line, so earlier lines stayed deducted and later lines never ran: 45 bills on 21–22 Oct were left
--     missing or partially deducted and parked in STOCK_CONFLICT for good.
--   * Most refusals came from batches that had been deleted / re-created (CONFLICT_BATCH_NOT_FOUND) or batches with
--     too little cloud stock (CONFLICT_INSUFFICIENT_STOCK).
--   * Batch create wrote no ledger row (284 batches have no history); batch delete was a plain DELETE with no
--     ledger row (114 ledger identities now point at no batch).
--   * Bill delete restored the bill's LINE quantities matched by name (whether or not they were ever deducted);
--     delete_sale_and_restore restores nothing for these bills (cloud sale_items carry affects_stock = false).
--   * BILL movements recorded no acting user.
--
-- WHAT (all functions: SECURITY INVOKER except the replaced legacy apply_bill_stock_movement, which keeps its
-- existing SECURITY DEFINER contract; fixed search_path; actor from auth.uid() only):
--   apply_bill_stock_movements(jsonb)  all of a bill's BILL lines in ONE transaction: every line is validated under
--                                      batch row locks first; any conflict -> nothing written. Exactly-once per
--                                      original movement_key ('VHC:BILL:<bill_id>:<local movement id>'), so a retry
--                                      of a fully/partly applied bill only applies what is missing. Re-pointing a
--                                      line at the CURRENT batch of the same item+location+batch number (when the
--                                      original batch was deleted) is admin-only (allow_identity_fallback).
--   restore_bill_stock(jsonb)          bill delete: restores EXACTLY the recorded BILL deductions of that bill, once
--                                      each ('VHC:BILL-RESTORE:<bill_id>:<original key or id>'), and writes a
--                                      'VHC:BILL-DELETED:<bill_id>' marker so a late sync can never deduct a
--                                      deleted bill. Refuses (no change) if the bill has returns or was already
--                                      restored by an older path.
--   create_stock_batch(jsonb)          new batch + RECEIVE opening movement in one transaction; refuses a duplicate
--                                      item+location+batch number (CONFLICT_BATCH_EXISTS).
--   delete_stock_batch(jsonb)          only an EMPTY batch with no stock history may be deleted; the deletion is
--                                      recorded (ADJUST, qty 0). A batch with history stays at zero (closed) so
--                                      bills still syncing from any counter keep finding it.
--   apply_bill_stock_movement(jsonb)   (legacy, older apps) unchanged contract + records created_by + refuses a
--                                      deleted bill.
--   unique index stock_batches_identity_uq on (item_id, location_id, lower(btrim(coalesce(batch_no,'')))) — the
--   migration ABORTS (nothing applied) if duplicates exist. 0 duplicates in Production on 2026-10-22.
--
-- LOCKING: the index build takes a SHARE lock on stock_batches for the build (480 rows: well under a second);
-- function creation takes catalog locks only. Run in ONE transaction. Re-running: functions are create-or-replace,
-- the index is IF NOT EXISTS, grants are idempotent.
-- NO table/column/policy changes, NO data changes, historical movements never rewritten.

-- ── 0. Uniqueness guard + index ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_dups int;
begin
  select count(*) into v_dups from (
    select 1 from public.stock_batches
    group by item_id, location_id, lower(btrim(coalesce(batch_no, '')))
    having count(*) > 1) d;
  if v_dups > 0 then
    raise exception 'stock_batches has % duplicate item+location+batch-number identities. Resolve them (audited corrections, never deletes of batches with history) before applying this migration. Nothing was changed.', v_dups;
  end if;
end $$;
create unique index if not exists stock_batches_identity_uq
  on public.stock_batches (item_id, location_id, lower(btrim(coalesce(batch_no, ''))));

-- ── 1. Atomic bill deduction ────────────────────────────────────────────────────────────────────────────────
create or replace function public.apply_bill_stock_movements(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_bill text := nullif(btrim(payload->>'bill_id'), '');
  v_fallback boolean := coalesce((payload->>'allow_identity_fallback')::boolean, false);
  v_lines jsonb := payload->'movements';
  v_n int;
  v_line jsonb;
  v_key text;
  v_keys text[] := '{}';
  v_prefix text;
  v_delta numeric;
  v_expected numeric;
  v_bid uuid;
  v_item uuid;
  v_loc uuid;
  v_bno text;
  v_ids uuid[];
  v_batch public.stock_batches%rowtype;
  v_existing public.stock_movements%rowtype;
  v_res jsonb := '[]'::jsonb;     -- per line: {i, movement_key, stock_batch_id, fallback, status, ...}
  v_r jsonb;
  v_lock_ids uuid[] := '{}';
  v_running jsonb := '{}'::jsonb; -- batch_id -> running qty while validating
  v_open numeric;
  v_close numeric;
  v_conflict text;
  v_pending int := 0;
  v_rows int;
  v_mid uuid;
  i int;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    return jsonb_build_object('status', 'NOT_PERMITTED', 'reason', 'pharmacy writer role required');
  end if;
  if v_fallback and not coalesce(public.is_admin(), false) then
    return jsonb_build_object('status', 'NOT_PERMITTED', 'reason', 'only an admin may apply a deduction to the current batch');
  end if;
  if v_bill is null then raise exception 'bill_id is required'; end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then raise exception 'movements must be an array'; end if;
  v_n := jsonb_array_length(v_lines);
  if v_n < 1 or v_n > 200 then raise exception 'movements must contain 1..200 lines'; end if;
  v_prefix := 'VHC:BILL:' || v_bill || ':';
  -- Serialise against restore_bill_stock (bill delete) and other deductions of the same bill.
  perform pg_advisory_xact_lock(hashtextextended('vhc-bill-stock:' || v_bill, 0));

  if exists (select 1 from public.stock_movements where movement_key = 'VHC:BILL-DELETED:' || v_bill) then
    return jsonb_build_object('status', 'CONFLICT', 'conflict', 'CONFLICT_BILL_DELETED', 'bill_id', v_bill, 'applied', 0,
      'lines', '[]'::jsonb);
  end if;

  -- Phase 1: validate input and resolve each line's batch (no writes).
  for i in 0 .. v_n - 1 loop
    v_line := v_lines->i;
    v_key := nullif(btrim(v_line->>'movement_key'), '');
    if v_key is null or left(v_key, length(v_prefix)) <> v_prefix or length(v_key) <= length(v_prefix) then
      raise exception 'line %: movement_key must be %<movement id>', i, v_prefix;
    end if;
    if v_key = any(v_keys) then raise exception 'line %: duplicate movement_key %', i, v_key; end if;
    v_keys := v_keys || v_key;
    v_delta := (v_line->>'quantity_delta')::numeric;
    if v_delta is null or v_delta = 'NaN'::numeric or v_delta >= 0 then
      raise exception 'line %: quantity_delta must be a negative number', i;
    end if;
    if coalesce(v_line->>'movement_type', 'BILL') <> 'BILL' then raise exception 'line %: only BILL lines are supported', i; end if;
    v_bid := nullif(v_line->>'stock_batch_id', '')::uuid;
    v_item := nullif(v_line->>'item_id', '')::uuid;
    v_loc := nullif(v_line->>'location_id', '')::uuid;
    v_bno := nullif(btrim(v_line->>'batch_no'), '');
    v_r := jsonb_build_object('i', i, 'movement_key', v_key, 'quantity_delta', v_delta,
      'expected_opening', nullif(v_line->>'expected_opening', '')::numeric, 'reason', nullif(v_line->>'reason', ''),
      'fallback', false);
    v_conflict := null;
    v_batch := null;
    if v_bid is not null then
      select * into v_batch from public.stock_batches where id = v_bid;
      if found then
        if (v_item is not null and v_batch.item_id <> v_item)
           or (v_loc is not null and v_batch.location_id <> v_loc)
           or (v_bno is not null and lower(btrim(coalesce(v_batch.batch_no, ''))) <> lower(v_bno)) then
          v_conflict := 'CONFLICT_BATCH_IDENTITY';
        end if;
      elsif v_fallback and v_item is not null and v_loc is not null then
        select array_agg(id order by id) into v_ids from public.stock_batches
          where item_id = v_item and location_id = v_loc and lower(btrim(coalesce(batch_no, ''))) = lower(coalesce(v_bno, ''));
        if coalesce(array_length(v_ids, 1), 0) = 1 then
          select * into v_batch from public.stock_batches where id = v_ids[1];
          v_r := v_r || jsonb_build_object('fallback', true, 'original_stock_batch_id', v_bid);
        else
          v_conflict := case when coalesce(array_length(v_ids, 1), 0) = 0 then 'CONFLICT_BATCH_NOT_FOUND' else 'CONFLICT_BATCH_AMBIGUOUS' end;
        end if;
      else
        v_conflict := 'CONFLICT_BATCH_NOT_FOUND';
      end if;
    else
      if v_item is null or v_loc is null or v_bno is null then
        raise exception 'line %: stock_batch_id or item_id + location_id + batch_no is required', i;
      end if;
      select array_agg(id order by id) into v_ids from public.stock_batches
        where item_id = v_item and location_id = v_loc and lower(btrim(coalesce(batch_no, ''))) = lower(v_bno);
      if coalesce(array_length(v_ids, 1), 0) = 1 then
        select * into v_batch from public.stock_batches where id = v_ids[1];
      else
        v_conflict := case when coalesce(array_length(v_ids, 1), 0) = 0 then 'CONFLICT_BATCH_NOT_FOUND' else 'CONFLICT_BATCH_AMBIGUOUS' end;
      end if;
    end if;
    if v_conflict is not null then
      v_r := v_r || jsonb_build_object('status', v_conflict, 'stock_batch_id', v_bid);
    else
      v_r := v_r || jsonb_build_object('status', 'RESOLVED', 'stock_batch_id', v_batch.id);
      if not (v_batch.id = any(v_lock_ids)) then v_lock_ids := v_lock_ids || v_batch.id; end if;
    end if;
    v_res := v_res || jsonb_build_array(v_r);
  end loop;

  -- Lock every resolved batch in a fixed order (no deadlock between two bills on the same batches).
  perform 1 from public.stock_batches where id = any(v_lock_ids) order by id for update;

  -- Phase 2 (under the locks): idempotency per key + aggregated stock check. Still no writes.
  for i in 0 .. v_n - 1 loop
    v_r := v_res->i;
    if v_r->>'status' <> 'RESOLVED' then continue; end if;
    select * into v_batch from public.stock_batches where id = (v_r->>'stock_batch_id')::uuid;
    if not found then
      v_res := jsonb_set(v_res, array[i::text, 'status'], '"CONFLICT_BATCH_NOT_FOUND"');
      continue;
    end if;
    v_key := v_r->>'movement_key';
    v_delta := (v_r->>'quantity_delta')::numeric;
    select * into v_existing from public.stock_movements where movement_key = v_key;
    if found then
      if v_existing.bill_id is distinct from v_bill or v_existing.type <> 'BILL'
         or abs(coalesce(v_existing.qty, 0) - v_delta) > 0.0005
         or v_existing.item_id is distinct from v_batch.item_id
         or v_existing.location_id is distinct from v_batch.location_id
         or lower(btrim(coalesce(v_existing.batch_no, ''))) <> lower(btrim(coalesce(v_batch.batch_no, ''))) then
        v_res := jsonb_set(v_res, array[i::text], v_r || jsonb_build_object('status', 'CONFLICT_MOVEMENT_MISMATCH',
          'movement_id', v_existing.id, 'existing_bill_id', v_existing.bill_id, 'existing_qty', v_existing.qty));
      else
        v_res := jsonb_set(v_res, array[i::text], v_r || jsonb_build_object('status', 'ALREADY_APPLIED',
          'movement_id', v_existing.id, 'opening', v_existing.opening, 'closing', v_existing.closing));
      end if;
      continue;
    end if;
    v_open := coalesce((v_running->>(v_batch.id::text))::numeric, v_batch.qty);
    v_close := v_open + v_delta;
    if v_close < -0.0005 then
      v_res := jsonb_set(v_res, array[i::text], v_r || jsonb_build_object('status', 'CONFLICT_INSUFFICIENT_STOCK',
        'actual_opening', v_open, 'requested_qty', v_delta));
      continue;
    end if;
    v_running := v_running || jsonb_build_object(v_batch.id::text, v_close);
    v_res := jsonb_set(v_res, array[i::text], v_r || jsonb_build_object('status', 'PENDING', 'opening', v_open, 'closing', v_close));
    v_pending := v_pending + 1;
  end loop;

  select min(x->>'status') into v_conflict from jsonb_array_elements(v_res) x where x->>'status' like 'CONFLICT_%';
  if v_conflict is not null then
    -- All or nothing: one refused line means NO line of this bill is written.
    return jsonb_build_object('status', 'CONFLICT', 'conflict', v_conflict, 'bill_id', v_bill, 'applied', 0,
      'lines', v_res);
  end if;
  if v_pending = 0 then
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'bill_id', v_bill, 'applied', 0, 'lines', v_res);
  end if;

  -- Phase 3: write every pending line in one block (any failure rolls back all of them).
  begin
    for i in 0 .. v_n - 1 loop
      v_r := v_res->i;
      if v_r->>'status' <> 'PENDING' then continue; end if;
      update public.stock_batches set qty = (v_r->>'closing')::numeric, updated_at = v_now
        where id = (v_r->>'stock_batch_id')::uuid;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'Stock batch % was not updated (not permitted)', v_r->>'stock_batch_id' using errcode = 'insufficient_privilege';
      end if;
      select * into v_batch from public.stock_batches where id = (v_r->>'stock_batch_id')::uuid;
      insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing,
        bill_id, reason, created_by, created_at)
      values (v_r->>'movement_key', v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'BILL',
        (v_r->>'quantity_delta')::numeric, (v_r->>'opening')::numeric, (v_r->>'closing')::numeric, v_bill,
        coalesce(v_r->>'reason', 'Bill:' || v_bill)
          || case when v_r->>'expected_opening' is not null
                   and abs((v_r->>'expected_opening')::numeric - (v_r->>'opening')::numeric) > 0.0005
                  then format(' [counter opening %s, cloud opening %s]', v_r->>'expected_opening', v_r->>'opening') else '' end
          || case when (v_r->>'fallback')::boolean
                  then format(' [admin review: original batch %s no longer exists; applied to current batch %s]',
                              v_r->>'original_stock_batch_id', v_r->>'stock_batch_id') else '' end,
        v_actor, v_now)
      returning id into v_mid;
      v_res := jsonb_set(v_res, array[i::text], v_r || jsonb_build_object('status', 'APPLIED', 'movement_id', v_mid));
    end loop;
  exception
    when unique_violation then
      -- Another call committed one of these keys between our check and insert: nothing of ours is kept.
      return jsonb_build_object('status', 'RETRY', 'bill_id', v_bill, 'applied', 0,
        'reason', 'a concurrent call applied part of this bill; retry to read its result');
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'bill_id', v_bill, 'applied', 0);
  end;
  return jsonb_build_object('status', 'APPLIED', 'bill_id', v_bill, 'applied', v_pending, 'created_by', v_actor,
    'lines', v_res);
end;
$$;
revoke all on function public.apply_bill_stock_movements(jsonb) from public, anon;
grant execute on function public.apply_bill_stock_movements(jsonb) to authenticated, service_role;

-- ── 2. Bill delete: restore exactly the recorded deductions, once ────────────────────────────────────────────
create or replace function public.restore_bill_stock(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_bill text := nullif(btrim(payload->>'bill_id'), '');
  v_reason text := btrim(coalesce(payload->>'reason', ''));
  v_patient uuid;
  v_marker text;
  v_m public.stock_movements%rowtype;
  v_ids uuid[];
  v_batch public.stock_batches%rowtype;
  v_plan jsonb := '[]'::jsonb;
  v_p jsonb;
  v_running jsonb := '{}'::jsonb;
  v_lock_ids uuid[] := '{}';
  v_rkey text;
  v_open numeric;
  v_conflict text;
  v_pending int := 0;
  v_done int := 0;
  v_total int := 0;
  v_rows int;
  i int;
begin
  if v_actor is null or not coalesce(public.is_pharmacy_writer(), false) then
    return jsonb_build_object('status', 'NOT_PERMITTED');
  end if;
  if v_bill is null then raise exception 'bill_id is required'; end if;
  if not public.vhc_manual_stock_reason_ok(v_reason) then
    return jsonb_build_object('status', 'REJECTED_REASON', 'reason', v_reason);
  end if;
  begin v_patient := nullif(payload->>'patient_id', '')::uuid; exception when others then v_patient := null; end;
  v_marker := 'VHC:BILL-DELETED:' || v_bill;

  -- Serialise every restore/deduction decision for this bill.
  perform pg_advisory_xact_lock(hashtextextended('vhc-bill-stock:' || v_bill, 0));

  if exists (select 1 from public.stock_movements where bill_id = v_bill and type = 'RETURN') then
    return jsonb_build_object('status', 'CONFLICT_BILL_HAS_RETURNS', 'bill_id', v_bill,
      'reason', 'this bill has returns; restore the remaining stock with an audited correction instead');
  end if;
  if exists (select 1 from public.stock_movements where bill_id = v_bill and type = 'RESTORE'
             and (movement_key is null or movement_key not like 'VHC:BILL-RESTORE:%')) then
    return jsonb_build_object('status', 'CONFLICT_ALREADY_RESTORED', 'bill_id', v_bill,
      'reason', 'stock for this bill was already restored by an older app path');
  end if;

  -- Plan (no writes): one restore per recorded BILL deduction.
  for v_m in select * from public.stock_movements where bill_id = v_bill and type = 'BILL' order by seq loop
    v_total := v_total + 1;
    v_rkey := 'VHC:BILL-RESTORE:' || v_bill || ':' || coalesce(v_m.movement_key, v_m.id::text);
    if exists (select 1 from public.stock_movements where movement_key = v_rkey) then
      v_plan := v_plan || jsonb_build_array(jsonb_build_object('movement_id', v_m.id, 'restore_key', v_rkey, 'status', 'ALREADY_APPLIED'));
      v_done := v_done + 1;
      continue;
    end if;
    select array_agg(id order by id) into v_ids from public.stock_batches
      where item_id = v_m.item_id and location_id = v_m.location_id
        and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_m.batch_no, '')));
    if coalesce(array_length(v_ids, 1), 0) <> 1 then
      v_plan := v_plan || jsonb_build_array(jsonb_build_object('movement_id', v_m.id, 'restore_key', v_rkey,
        'status', case when coalesce(array_length(v_ids, 1), 0) = 0 then 'CONFLICT_RESTORE_BATCH_MISSING' else 'CONFLICT_BATCH_AMBIGUOUS' end,
        'item_id', v_m.item_id, 'batch_no', v_m.batch_no, 'qty', -v_m.qty));
      continue;
    end if;
    if not (v_ids[1] = any(v_lock_ids)) then v_lock_ids := v_lock_ids || v_ids[1]; end if;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('movement_id', v_m.id, 'restore_key', v_rkey,
      'status', 'PENDING', 'stock_batch_id', v_ids[1], 'qty', -v_m.qty, 'patient_id', v_m.patient_id));
    v_pending := v_pending + 1;
  end loop;

  select min(x->>'status') into v_conflict from jsonb_array_elements(v_plan) x where x->>'status' like 'CONFLICT_%';
  if v_conflict is not null then
    return jsonb_build_object('status', 'CONFLICT', 'conflict', v_conflict, 'bill_id', v_bill, 'restored', 0, 'lines', v_plan);
  end if;

  perform 1 from public.stock_batches where id = any(v_lock_ids) order by id for update;

  begin
    for i in 0 .. coalesce(jsonb_array_length(v_plan), 0) - 1 loop
      v_p := v_plan->i;
      if v_p->>'status' <> 'PENDING' then continue; end if;
      select * into v_batch from public.stock_batches where id = (v_p->>'stock_batch_id')::uuid;
      v_open := coalesce((v_running->>(v_batch.id::text))::numeric, v_batch.qty);
      update public.stock_batches set qty = v_open + (v_p->>'qty')::numeric, updated_at = v_now where id = v_batch.id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'Stock batch % was not updated (not permitted)', v_batch.id using errcode = 'insufficient_privilege'; end if;
      v_running := v_running || jsonb_build_object(v_batch.id::text, v_open + (v_p->>'qty')::numeric);
      insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing,
        bill_id, patient_id, reason, created_by, created_at)
      values (v_p->>'restore_key', v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'RESTORE', (v_p->>'qty')::numeric,
        v_open, v_open + (v_p->>'qty')::numeric, v_bill, coalesce(v_patient, nullif(v_p->>'patient_id', '')::uuid),
        v_reason, v_actor, v_now);
      v_plan := jsonb_set(v_plan, array[i::text], v_p || jsonb_build_object('status', 'APPLIED', 'opening', v_open,
        'closing', v_open + (v_p->>'qty')::numeric));
    end loop;
    if not exists (select 1 from public.stock_movements where movement_key = v_marker) then
      insert into public.stock_movements (movement_key, type, qty, opening, closing, bill_id, reason, created_by, created_at)
      values (v_marker, 'ADJUST', 0, 0, 0, v_bill, 'Bill deleted: ' || v_reason, v_actor, v_now);
    end if;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'RETRY', 'bill_id', v_bill, 'restored', 0);
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'bill_id', v_bill, 'restored', 0);
  end;

  return jsonb_build_object(
    'status', case when v_total = 0 then 'NOTHING_TO_RESTORE' when v_pending = 0 then 'ALREADY_APPLIED' else 'APPLIED' end,
    'bill_id', v_bill, 'restored', v_pending, 'already_restored', v_done, 'deductions', v_total, 'lines', v_plan,
    'created_by', v_actor);
end;
$$;
revoke all on function public.restore_bill_stock(jsonb) from public, anon;
grant execute on function public.restore_bill_stock(jsonb) to authenticated, service_role;

-- ── 3. Batch create with an audited opening quantity ────────────────────────────────────────────────────────
create or replace function public.create_stock_batch(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_request text := nullif(btrim(payload->>'request_key'), '');
  v_key text;
  v_item uuid := nullif(payload->>'item_id', '')::uuid;
  v_loc uuid := nullif(payload->>'location_id', '')::uuid;
  v_bno text := nullif(btrim(payload->>'batch_no'), '');
  v_qty numeric := coalesce(nullif(payload->>'opening_qty', '')::numeric, 0);
  v_reason text := coalesce(nullif(btrim(payload->>'reason'), ''), 'New batch opening stock');
  v_batch public.stock_batches%rowtype;
  v_existing public.stock_movements%rowtype;
begin
  if v_actor is null or not coalesce(public.is_pharmacy_writer(), false) then
    return jsonb_build_object('status', 'NOT_PERMITTED');
  end if;
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'request_key is required (16-80 characters: letters, digits, - or _)';
  end if;
  if v_item is null or v_loc is null then raise exception 'item_id and location_id are required'; end if;
  if v_qty = 'NaN'::numeric or v_qty < 0 then
    return jsonb_build_object('status', 'REJECTED_NEGATIVE_QTY', 'requested_qty', v_qty);
  end if;
  v_key := 'VHC:BATCH-OPEN:' || v_request;
  perform pg_advisory_xact_lock(hashtextextended('vhc-batch:' || v_item || ':' || v_loc || ':' || lower(coalesce(v_bno, '')), 0));

  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    select * into v_batch from public.stock_batches
      where item_id = v_existing.item_id and location_id = v_existing.location_id
        and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_existing.batch_no, '')));
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'stock_batch_id', v_batch.id,
      'opening_qty', v_existing.closing);
  end if;
  select * into v_batch from public.stock_batches
    where item_id = v_item and location_id = v_loc and lower(btrim(coalesce(batch_no, ''))) = lower(coalesce(v_bno, ''));
  if found then
    return jsonb_build_object('status', 'CONFLICT_BATCH_EXISTS', 'stock_batch_id', v_batch.id, 'current_qty', v_batch.qty);
  end if;

  begin
    insert into public.stock_batches (item_id, location_id, batch_no, expiry_date, mrp, net_rate, gst, stockist, qty, updated_at)
    values (v_item, v_loc, v_bno, nullif(payload->>'expiry_date', '')::date, nullif(payload->>'mrp', '')::numeric,
      nullif(payload->>'net_rate', '')::numeric, nullif(payload->>'gst', '')::numeric, nullif(btrim(payload->>'stockist'), ''),
      v_qty, v_now)
    returning * into v_batch;
    insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason,
      created_by, created_at)
    values (v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'RECEIVE', v_qty, 0, v_qty,
      'Batch created: ' || v_reason, v_actor, v_now)
    returning * into v_existing;
  exception
    when unique_violation then
      select * into v_batch from public.stock_batches
        where item_id = v_item and location_id = v_loc and lower(btrim(coalesce(batch_no, ''))) = lower(coalesce(v_bno, ''));
      return jsonb_build_object('status', 'CONFLICT_BATCH_EXISTS', 'stock_batch_id', v_batch.id, 'current_qty', v_batch.qty);
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED');
  end;
  return jsonb_build_object('status', 'APPLIED', 'stock_batch_id', v_batch.id, 'movement_id', v_existing.id,
    'opening_qty', v_qty, 'created_by', v_actor);
end;
$$;
revoke all on function public.create_stock_batch(jsonb) from public, anon;
grant execute on function public.create_stock_batch(jsonb) to authenticated, service_role;

-- ── 4. Batch delete: only an empty batch with no history; the deletion is recorded ─────────────────────────
create or replace function public.delete_stock_batch(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_request text := nullif(btrim(payload->>'request_key'), '');
  v_key text;
  v_bid uuid := nullif(payload->>'stock_batch_id', '')::uuid;
  v_reason text := btrim(coalesce(payload->>'reason', ''));
  v_batch public.stock_batches%rowtype;
  v_existing public.stock_movements%rowtype;
  v_hist int;
  v_rows int;
begin
  if v_actor is null or not coalesce(public.is_pharmacy_writer(), false) then
    return jsonb_build_object('status', 'NOT_PERMITTED');
  end if;
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'request_key is required (16-80 characters: letters, digits, - or _)';
  end if;
  if v_bid is null then raise exception 'stock_batch_id is required'; end if;
  if not public.vhc_manual_stock_reason_ok(v_reason) then
    return jsonb_build_object('status', 'REJECTED_REASON', 'reason', v_reason);
  end if;
  v_key := 'VHC:BATCH-DELETE:' || v_request;
  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'stock_batch_id', v_bid);
  end if;
  select * into v_batch from public.stock_batches where id = v_bid for update;
  if not found then
    return jsonb_build_object('status', 'CONFLICT_BATCH_NOT_FOUND', 'stock_batch_id', v_bid);
  end if;
  if abs(v_batch.qty) > 0.0005 then
    return jsonb_build_object('status', 'CONFLICT_BATCH_NOT_EMPTY', 'stock_batch_id', v_bid, 'current_qty', v_batch.qty);
  end if;
  select count(*) into v_hist from public.stock_movements
    where item_id = v_batch.item_id and location_id = v_batch.location_id
      and lower(btrim(coalesce(batch_no, ''))) = lower(btrim(coalesce(v_batch.batch_no, '')))
      and not (type = 'RECEIVE' and coalesce(movement_key, '') like 'VHC:BATCH-OPEN:%');
  if v_hist > 0 then
    return jsonb_build_object('status', 'CONFLICT_BATCH_HAS_HISTORY', 'stock_batch_id', v_bid, 'movements', v_hist,
      'reason', 'a batch with stock history is kept at zero (closed) so bills still syncing from any counter can find it');
  end if;
  begin
    delete from public.stock_batches where id = v_bid;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'Stock batch % was not deleted (not permitted)', v_bid using errcode = 'insufficient_privilege'; end if;
    insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason,
      created_by, created_at)
    values (v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'ADJUST', 0, 0, 0,
      'Batch deleted: ' || v_reason, v_actor, v_now)
    returning * into v_existing;
  exception
    when foreign_key_violation then
      return jsonb_build_object('status', 'CONFLICT_BATCH_REFERENCED', 'stock_batch_id', v_bid);
    when insufficient_privilege then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_bid);
  end;
  return jsonb_build_object('status', 'APPLIED', 'stock_batch_id', v_bid, 'movement_id', v_existing.id, 'created_by', v_actor);
end;
$$;
revoke all on function public.delete_stock_batch(jsonb) from public, anon;
grant execute on function public.delete_stock_batch(jsonb) to authenticated, service_role;

-- ── 5. Legacy single-line deduction (older apps): same contract; now records the acting user and refuses a
--      deleted bill. Keeps its existing SECURITY DEFINER + grants (create or replace preserves grants).
create or replace function public.apply_bill_stock_movement(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.stock_movements%rowtype;
  v_batch public.stock_batches%rowtype;
  v_batch_ids uuid[];
  v_key text := nullif(btrim(payload->>'movement_key'), '');
  v_bill_id text := nullif(btrim(payload->>'bill_id'), '');
  v_batch_id uuid := nullif(payload->>'stock_batch_id', '')::uuid;
  v_item_id uuid := nullif(payload->>'item_id', '')::uuid;
  v_location_id uuid := nullif(payload->>'location_id', '')::uuid;
  v_batch_no text := nullif(btrim(payload->>'batch_no'), '');
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_expected numeric := nullif(payload->>'expected_opening', '')::numeric;
  v_type text := coalesce(nullif(payload->>'movement_type', ''), 'BILL');
  v_reason text := nullif(payload->>'reason', '');
  v_opening numeric;
  v_closing numeric;
  v_drift numeric;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to apply pharmacy stock';
  end if;
  if v_key is null or v_bill_id is null then
    raise exception 'movement_key and bill_id are required';
  end if;
  -- 20261023: a bill deleted through restore_bill_stock may never be deducted afterwards.
  perform pg_advisory_xact_lock(hashtextextended('vhc-bill-stock:' || v_bill_id, 0));
  if exists (select 1 from public.stock_movements where movement_key = 'VHC:BILL-DELETED:' || v_bill_id) then
    return jsonb_build_object('status', 'CONFLICT_BILL_DELETED', 'movement_key', v_key, 'bill_id', v_bill_id);
  end if;
  if v_type <> 'BILL' then
    raise exception 'Only BILL stock application is supported';
  end if;
  if v_delta is null or v_delta >= 0 then
    raise exception 'quantity_delta must be negative for a BILL movement';
  end if;

  -- Resolve and LOCK the exact target batch (same identity rules as reconcile_stock_movement).
  if v_batch_id is not null then
    select * into v_batch from public.stock_batches where id = v_batch_id for update;
    if not found then
      return jsonb_build_object('status', 'CONFLICT_BATCH_NOT_FOUND', 'movement_key', v_key, 'stock_batch_id', v_batch_id);
    end if;
    if (v_item_id is not null and v_batch.item_id <> v_item_id)
       or (v_location_id is not null and v_batch.location_id <> v_location_id)
       or (v_batch_no is not null and lower(btrim(coalesce(v_batch.batch_no, ''))) <> lower(v_batch_no)) then
      return jsonb_build_object('status', 'CONFLICT_BATCH_IDENTITY', 'movement_key', v_key, 'stock_batch_id', v_batch.id);
    end if;
  else
    if v_item_id is null or v_location_id is null or v_batch_no is null then
      raise exception 'Fallback requires item_id, location_id and batch_no';
    end if;
    select array_agg(id order by id) into v_batch_ids
    from public.stock_batches
    where item_id = v_item_id and location_id = v_location_id
      and lower(btrim(coalesce(batch_no, ''))) = lower(v_batch_no);
    if coalesce(array_length(v_batch_ids, 1), 0) <> 1 then
      return jsonb_build_object('status', 'CONFLICT_BATCH_AMBIGUOUS', 'movement_key', v_key,
        'matches', coalesce(array_length(v_batch_ids, 1), 0));
    end if;
    select * into v_batch from public.stock_batches where id = v_batch_ids[1] for update;
  end if;

  -- Idempotency (checked while holding the batch lock, so a concurrent retry of the same
  -- movement serialises here and sees the first call's committed row).
  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    if v_existing.bill_id is distinct from v_bill_id
       or v_existing.type is distinct from v_type
       or abs(coalesce(v_existing.qty, 0) - v_delta) > 0.0005
       or v_existing.item_id is distinct from v_batch.item_id
       or v_existing.location_id is distinct from v_batch.location_id
       or lower(btrim(coalesce(v_existing.batch_no, ''))) <> lower(btrim(coalesce(v_batch.batch_no, ''))) then
      return jsonb_build_object('status', 'CONFLICT_MOVEMENT_MISMATCH', 'movement_key', v_key,
        'movement_id', v_existing.id, 'existing_bill_id', v_existing.bill_id, 'existing_qty', v_existing.qty,
        'requested_qty', v_delta);
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id,
      'movement_key', v_existing.movement_key, 'stock_batch_id', v_batch.id,
      'opening', v_existing.opening, 'closing', v_existing.closing);
  end if;

  v_opening := v_batch.qty;
  v_closing := v_opening + v_delta;
  if v_closing < -0.0005 then
    return jsonb_build_object('status', 'CONFLICT_INSUFFICIENT_STOCK', 'movement_key', v_key,
      'stock_batch_id', v_batch.id, 'actual_opening', v_opening, 'requested_qty', v_delta);
  end if;
  v_drift := case when v_expected is null then null else v_opening - v_expected end;

  begin
    update public.stock_batches set qty = v_closing, updated_at = now() where id = v_batch.id;
    insert into public.stock_movements (
      movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, created_by, reason
    ) values (
      v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, v_type, v_delta, v_opening, v_closing, v_bill_id, auth.uid(),
      coalesce(v_reason, 'Bill:' || v_bill_id) ||
        case when v_drift is not null and abs(v_drift) > 0.0005
             then format(' [counter opening %s, cloud opening %s]', v_expected, v_opening) else '' end
    ) returning * into v_existing;
  exception when unique_violation then
    -- Same key committed by a concurrent call on another path: the block above is rolled back
    -- (no stock change), and the committed row decides the outcome.
    select * into v_existing from public.stock_movements where movement_key = v_key;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id,
      'movement_key', v_key, 'stock_batch_id', v_batch.id,
      'opening', v_existing.opening, 'closing', v_existing.closing, 'race', true);
  end;

  return jsonb_build_object('status', 'APPLIED', 'movement_id', v_existing.id,
    'movement_key', v_existing.movement_key, 'stock_batch_id', v_batch.id,
    'opening', v_opening, 'closing', v_closing, 'drift', v_drift);
end;
$$;

alter function public.apply_bill_stock_movement(jsonb) owner to postgres;
revoke all on function public.apply_bill_stock_movement(jsonb) from public, anon;
grant execute on function public.apply_bill_stock_movement(jsonb) to authenticated, service_role;
