-- VHC Pharmacy — stock-sync remediation, follow-up 1: bill-delete restore patient fix (T7, 2026-10-23).
-- PREPARED ONLY (not applied to TEST or Production). Requires 20261023000100_stock_sync_remediation.sql.
-- Replaces ONE function; run in one transaction like the other migrations.
-- No table, column, index, policy, grant or data change; no existing row is rewritten.
--
-- Defect (TEST desktop run 3, test T7): restore_bill_stock inserted payload->>'patient_id' into
-- stock_movements.patient_id. The desktop sent the counter's LOCAL patient id (not a cloud patients.id), so
-- stock_movements_patient_id_fkey (FOREIGN KEY (patient_id) REFERENCES patients(id), TEST and Production) failed,
-- the call raised HTTP 409, nothing was restored and no BILL-DELETED marker was written.
-- Fix: the client-supplied patient id is ignored; each RESTORE row carries the patient recorded on the deduction it
-- reverses (NULL when that deduction recorded none). Constraint failures inside the write phase now return
-- {status:'CONFLICT', conflict:'CONFLICT_RESTORE_WRITE_FAILED'} with every write of the call rolled back.
-- Unchanged: invoker rights, permission/reason checks, per-bill advisory lock, returns/old-restore refusals,
-- exact once-only restore keys (VHC:BILL-RESTORE:<bill>:<key>), BILL-DELETED marker, result shape.
-- Rollback: re-run section 2 of 20261023000100_stock_sync_remediation.sql (restores the previous body).

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
  -- 20261023000200: payload->>'patient_id' is IGNORED. Desktop counters sent their LOCAL SQLite patient id, which
  -- is not a cloud patients.id: the insert below violated stock_movements_patient_id_fkey and the whole restore
  -- failed (T7). The restore row now carries the patient recorded on the original deduction (already FK-valid).
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
      -- Patient recorded on the deduction itself: it already satisfied the FK when written and a referenced
      -- patients row cannot be deleted (FK has no ON DELETE action), so it is valid here too.
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
        v_open, v_open + (v_p->>'qty')::numeric, v_bill, nullif(v_p->>'patient_id', '')::uuid,
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
    -- Any other constraint failure: every write of this call is rolled back (no stock, no restore row, no
    -- BILL-DELETED marker) and the caller gets a structured refusal instead of an HTTP error, so it can keep the bill.
    when foreign_key_violation or check_violation or not_null_violation then
      return jsonb_build_object('status', 'CONFLICT', 'conflict', 'CONFLICT_RESTORE_WRITE_FAILED', 'bill_id', v_bill,
        'restored', 0, 'sqlstate', sqlstate, 'error', sqlerrm);
  end;

  return jsonb_build_object(
    'status', case when v_total = 0 then 'NOTHING_TO_RESTORE' when v_pending = 0 then 'ALREADY_APPLIED' else 'APPLIED' end,
    'bill_id', v_bill, 'restored', v_pending, 'already_restored', v_done, 'deductions', v_total, 'lines', v_plan,
    'created_by', v_actor);
end;
$$;
revoke all on function public.restore_bill_stock(jsonb) from public, anon;
grant execute on function public.restore_bill_stock(jsonb) to authenticated, service_role;
