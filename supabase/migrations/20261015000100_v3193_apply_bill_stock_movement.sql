-- v3.19.3: delta-based, idempotent, atomic BILL stock application.
--
-- WHY: reconcile_stock_movement(jsonb) applies a bill's deduction only when the cloud batch
-- quantity EQUALS the opening stock the counter saw at checkout (compare-and-set on an absolute
-- value). Any legitimate concurrent change to that batch (warehouse transfer, inventory edit,
-- another terminal) or any single missed deduction makes the next bill on that batch CONFLICT —
-- and, because every later local opening is lower than the un-deducted cloud quantity, every
-- following bill on that batch conflicts too (cascade). Each needed manual repair.
--
-- WHAT: apply_bill_stock_movement(jsonb) applies the bill's quantity DELTA to the batch's
-- CURRENT quantity. Exactly-once is guaranteed by the immutable movement_key (unique index
-- stock_movements_movement_key_uq, installed by 20260929000100), not by comparing openings:
--   * batch identity validated and row locked (FOR UPDATE) for the whole call;
--   * movement_key already present  -> ALREADY_APPLIED if it is the SAME movement (bill, type,
--     delta, batch identity), else CONFLICT_MOVEMENT_MISMATCH — no mutation either way;
--   * cloud qty would go negative   -> CONFLICT_INSUFFICIENT_STOCK — no mutation;
--   * otherwise stock update + movement insert happen in ONE statement-level transaction and
--     either both commit or neither does; opening/closing are the real cloud values.
-- The counter's frozen opening (expected_opening) is informational only: any drift is returned
-- and written into the movement reason for audit, never a reason to refuse a real sale.
--
-- SAFETY: additive only. Creates one function and its grants; changes no table, no row and no
-- existing function. Re-running it is a no-op (create or replace + idempotent grants).
-- reconcile_stock_movement(jsonb) is left untouched for older app versions.

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
      movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason
    ) values (
      v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, v_type, v_delta, v_opening, v_closing, v_bill_id,
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
