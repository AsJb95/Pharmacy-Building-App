-- Manual stock correction: atomic, concurrency-safe, idempotent EDIT / RESTORE / TRANSFER writes.
--
-- WHY (verified in cloud-src/vhc-cloud-sync.js, v3.19.5):
--   * Edit Item / backup restore (updateInventoryItem): stock_batches UPDATE, then a separate EDIT
--     stock_movements INSERT whose error is ignored; the reason is validated only AFTER the update; the
--     opening quantity comes from the client cache with no compare-and-set, so a concurrent change is
--     silently overwritten; no created_by; no request key (a retried save can apply twice).
--   * Bill-delete stock restore (adjustStockBulk, positive deltas -> RESTORE): same update-then-insert
--     pattern, insert error ignored, no created_by, no idempotency (deleting twice restores twice).
--   * Warehouse -> pharmacy transfer accept (acceptPharmacyTransfer): marks the order Completed first,
--     then moves each line in separate requests; a mid-way failure leaves a Completed order with only
--     part of its stock moved; movement inserts unchecked; no created_by.
--
-- WHAT: three functions. Each runs as ONE transaction: every stock_batches change and its
-- stock_movements row commit together or not at all. Each takes the actor from auth.uid() (never from
-- the payload) and rejects a call without an authenticated user.
--   apply_stock_correction(jsonb)  EDIT     absolute new quantity, compare-and-set on expected_qty, keyed by
--                                           client request_key (movement_key 'VHC:EDIT:<request_key>').
--   apply_stock_restore(jsonb)     RESTORE  positive delta, keyed by bill + batch
--                                           (movement_key 'VHC:RESTORE:<bill_id>:<batch_id>').
--   accept_pharmacy_transfer(jsonb) TRANSFER all lines + status in one transaction; idempotent via the
--                                           Pending -> Completed status under row lock; per-line movement keys.
--                                           Main Stock is kept in STRIPS and Pharmacy in UNITS: each line is
--                                           converted exactly as VHC Mobile does (vhc_transfer_dest_qty).
-- Idempotency: the movement_key is checked while holding the batch row lock (a concurrent retry of the
-- same request serialises and sees the committed row); the existing unique index on movement_key is
-- the backstop (unique_violation -> ALREADY_APPLIED). Same key with different content -> conflict.
--
-- SECURITY: all three run as SECURITY INVOKER with a fixed search_path. The caller's existing RLS on
-- stock_batches / stock_movements / transfer_orders / locations decides who may write — exactly as for the
-- direct writes they replace — so no access is widened and no user who may write today is newly blocked
-- (checked against the production policies, read-only, 2026-10-22).
-- Under RLS an UPDATE that is not permitted affects 0 rows WITHOUT an error, so every UPDATE is row-count
-- checked and raises insufficient_privilege, rolling the whole write block back. EDIT/RESTORE additionally
-- refuse non-pharmacy_counter batches (the pharmacy app only shows those). EXECUTE: authenticated + service_role.
-- Permission failures return status NOT_PERMITTED (nothing changed). A row the caller cannot even READ is
-- reported as not found, so NOT_PERMITTED never reveals the existence of a record the caller could not see.
-- SCHEMA: written for the production columns (production stock_batches has no created_at; production seq is an
-- identity column, TEST assigns it by trigger) — every insert names only columns present in both.
--
-- SAFETY: additive only. Creates five functions and their grants. Changes no table, index, constraint,
-- row, or existing function (apply_bill_stock_movement and reconcile_stock_movement are untouched).
-- Historical movements are never rewritten. Re-running is a no-op (create or replace + idempotent grants).

create or replace function public.vhc_manual_stock_reason_ok(p_reason text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_reason is not null
     and length(btrim(p_reason)) >= 3
     and length(p_reason) <= 500
     and btrim(lower(regexp_replace(p_reason, '[[:space:][:punct:]]+', ' ', 'g'))) not in (
       'update', 'updated', 'edit', 'edited', 'change', 'changed', 'stock', 'stock update', 'stock change',
       'stock edit', 'correction', 'stock correction', 'adjust', 'adjusted', 'adjustment', 'na', 'n a', 'none',
       'nil', 'null', 'test', 'ok', 'reason', 'no reason', 'manual', 'misc', 'other', 'fix', 'qty', 'quantity');
$$;
revoke all on function public.vhc_manual_stock_reason_ok(text) from public, anon;
grant execute on function public.vhc_manual_stock_reason_ok(text) to authenticated, service_role;

create or replace function public.apply_stock_correction(payload jsonb)
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
  v_batch_id uuid := nullif(payload->>'stock_batch_id', '')::uuid;
  v_expected numeric := (payload->>'expected_qty')::numeric;
  v_new numeric := (payload->>'new_qty')::numeric;
  v_reason text := btrim(coalesce(payload->>'reason', ''));
  v_batch public.stock_batches%rowtype;
  v_loc_type text;
  v_existing public.stock_movements%rowtype;
  v_rows int;
begin
  if v_actor is null then
    raise exception 'An authenticated user is required for a manual stock correction';
  end if;
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{16,80}$' then
    raise exception 'request_key is required (16-80 characters: letters, digits, - or _)';
  end if;
  if v_batch_id is null then
    raise exception 'stock_batch_id is required';
  end if;
  if v_expected is null or v_new is null or v_expected = 'NaN'::numeric or v_new = 'NaN'::numeric then
    raise exception 'expected_qty and new_qty are required numbers';
  end if;
  if v_new < 0 then
    return jsonb_build_object('status', 'REJECTED_NEGATIVE_QTY', 'requested_qty', v_new);
  end if;
  if not public.vhc_manual_stock_reason_ok(v_reason) then
    return jsonb_build_object('status', 'REJECTED_REASON', 'reason', v_reason);
  end if;
  v_key := 'VHC:EDIT:' || v_request;

  -- Exact batch, locked for the rest of the transaction.
  select * into v_batch from public.stock_batches where id = v_batch_id for update;
  if not found then
    -- Readable but not lockable = the caller's RLS forbids writing it. Only a row the caller can already read
    -- is reported as NOT_PERMITTED; an unreadable row stays "not found" (no existence disclosure).
    if exists (select 1 from public.stock_batches where id = v_batch_id) then
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_batch_id);
    end if;
    return jsonb_build_object('status', 'CONFLICT_BATCH_NOT_FOUND', 'stock_batch_id', v_batch_id);
  end if;
  select type into v_loc_type from public.locations where id = v_batch.location_id;
  if v_loc_type is distinct from 'pharmacy_counter' then
    return jsonb_build_object('status', 'CONFLICT_NOT_PHARMACY_BATCH', 'stock_batch_id', v_batch.id);
  end if;

  -- Idempotency BEFORE the stale check: a retry of an already-applied correction must report the
  -- original result, not "stale" (its own success moved the quantity away from expected_qty).
  select * into v_existing from public.stock_movements where movement_key = v_key;
  if found then
    if v_existing.type <> 'EDIT'
       or v_existing.item_id is distinct from v_batch.item_id
       or v_existing.location_id is distinct from v_batch.location_id
       or lower(btrim(coalesce(v_existing.batch_no, ''))) <> lower(btrim(coalesce(v_batch.batch_no, '')))
       or abs(coalesce(v_existing.opening, 0) - v_expected) > 0.0005
       or abs(coalesce(v_existing.closing, 0) - v_new) > 0.0005
       or coalesce(v_existing.reason, '') <> v_reason then
      return jsonb_build_object('status', 'CONFLICT_REQUEST_KEY_REUSED', 'movement_key', v_key, 'movement_id', v_existing.id);
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
      'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing,
      'created_by', v_existing.created_by, 'created_at', v_existing.created_at);
  end if;

  -- Compare-and-set: refuse to overwrite a quantity the user did not see.
  if abs(v_batch.qty - v_expected) > 0.0005 then
    return jsonb_build_object('status', 'CONFLICT_STALE_OPENING', 'stock_batch_id', v_batch.id,
      'expected_qty', v_expected, 'current_qty', v_batch.qty);
  end if;
  if abs(v_new - v_batch.qty) <= 0.0005 then
    return jsonb_build_object('status', 'NO_CHANGE', 'stock_batch_id', v_batch.id, 'current_qty', v_batch.qty);
  end if;

  begin
    update public.stock_batches set qty = v_new, updated_at = v_now where id = v_batch.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'Stock batch % was not updated (not permitted); nothing was changed', v_batch.id using errcode = 'insufficient_privilege';
    end if;
    insert into public.stock_movements (
      movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at
    ) values (
      v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'EDIT', v_new - v_batch.qty, v_batch.qty, v_new,
      v_reason, v_actor, v_now
    ) returning * into v_existing;
  exception
    when unique_violation then
      select * into v_existing from public.stock_movements where movement_key = v_key;
      return jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
        'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing, 'race', true);
    when insufficient_privilege then
      -- RLS refused the update or the ledger insert: the block (update + insert) is rolled back.
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_batch.id);
  end;

  return jsonb_build_object('status', 'APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
    'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing,
    'qty', v_existing.qty, 'created_by', v_actor, 'created_at', v_now);
end;
$$;
revoke all on function public.apply_stock_correction(jsonb) from public, anon;
grant execute on function public.apply_stock_correction(jsonb) to authenticated, service_role;

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
  v_patient uuid := nullif(payload->>'patient_id', '')::uuid;
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
  v_key := 'VHC:RESTORE:' || v_bill_id || ':' || v_batch_id::text;

  select * into v_batch from public.stock_batches where id = v_batch_id for update;
  if not found then
    -- Readable but not lockable = the caller's RLS forbids writing it. Only a row the caller can already read
    -- is reported as NOT_PERMITTED; an unreadable row stays "not found" (no existence disclosure).
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
  -- Restores written by older app versions carry no movement_key. A RESTORE row for the same bill and the same
  -- batch identity can only come from an earlier delete of that bill (sale returns are type RETURN), so it counts
  -- as already applied — never a second restore of the same bill/batch.
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
      -- RLS refused the update or the ledger insert: the block (update + insert) is rolled back.
      return jsonb_build_object('status', 'NOT_PERMITTED', 'stock_batch_id', v_batch.id);
  end;

  return jsonb_build_object('status', 'APPLIED', 'movement_id', v_existing.id, 'movement_key', v_key,
    'stock_batch_id', v_batch.id, 'opening', v_existing.opening, 'closing', v_existing.closing, 'created_by', v_actor);
end;
$$;
revoke all on function public.apply_stock_restore(jsonb) from public, anon;
grant execute on function public.apply_stock_restore(jsonb) to authenticated, service_role;

-- Warehouse (Main Stock, STRIPS) -> Pharmacy (UNITS) quantity rule. Identical to VHC Mobile
-- (src/lib/transfers.js resolveAcceptedLine + src/lib/units.js stripsToUnits, read 2026-10-22):
-- transfer_order_items.qty is ALWAYS in the source's native unit (strips for Main Stock, possibly fractional when the
-- request was entered in units); transfer_unit only records how it was entered; units_per_pack is the line's own
-- snapshotted strips -> units factor.
--   legacy line: transfer_unit AND units_per_pack both NULL         -> qty added 1:1 (historical behaviour, unchanged)
--   transfer_unit 'strips' or 'units' AND units_per_pack > 0        -> qty * units_per_pack units added
--   anything else (only one set, unknown unit, units_per_pack <= 0) -> NULL: the accept is refused, never guessed
create or replace function public.vhc_transfer_dest_qty(p_qty numeric, p_transfer_unit text, p_units_per_pack numeric)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_transfer_unit is null and p_units_per_pack is null then p_qty
    when p_transfer_unit in ('strips', 'units') and p_units_per_pack > 0 and p_units_per_pack <> 'NaN'::numeric
      then p_qty * p_units_per_pack
    else null
  end;
$$;
revoke all on function public.vhc_transfer_dest_qty(numeric, text, numeric) from public, anon;
grant execute on function public.vhc_transfer_dest_qty(numeric, text, numeric) to authenticated, service_role;

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
begin
  if v_actor is null then
    raise exception 'An authenticated user is required to accept a transfer';
  end if;
  if v_id is null then
    raise exception 'transfer_id is required';
  end if;

  -- The order row lock serialises concurrent accepts (another desktop, or Mobile on the same path).
  select * into v_t from public.transfer_orders where id = v_id for update;
  v_locked := found;
  if not v_locked then
    -- Not lockable: either the caller cannot see the order (NOT_FOUND, nothing disclosed) or can read it but its
    -- RLS forbids writing it (NOT_PERMITTED, after reporting a status the caller can already read).
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

  -- No unique constraint exists on (item, location, batch_no), so two accepts that both need to CREATE the same
  -- pharmacy batch could insert it twice. Serialise them on a transaction-scoped advisory lock per pharmacy batch
  -- identity, taken in a fixed order BEFORE any batch is read (needs no table privileges; released at commit).
  for v_line in select distinct item_id, batch_no from public.transfer_order_items
                where transfer_order_id = v_t.id and qty > 0 and item_id is not null order by item_id, batch_no loop
    perform pg_advisory_xact_lock(hashtextextended('vhc_batch:' || v_line.item_id || ':' || v_pharm || ':' || coalesce(lower(btrim(v_line.batch_no)), ''), 0));
  end loop;

  -- Phase 1: resolve and lock every batch (in id order, to avoid deadlocks) and validate. No writes yet,
  -- so any problem returns with nothing changed and the order still Pending.
  select array_agg(distinct b.id order by b.id) into v_src_ids
  from public.transfer_order_items l
  join public.stock_batches b on b.item_id = l.item_id and b.location_id = v_main
       and b.batch_no is not distinct from l.batch_no
  where l.transfer_order_id = v_t.id and l.qty > 0;
  select array_agg(distinct b.id order by b.id) into v_dst_ids
  from public.transfer_order_items l
  join public.stock_batches b on b.item_id = l.item_id and b.location_id = v_pharm
       and b.batch_no is not distinct from l.batch_no
  where l.transfer_order_id = v_t.id and l.qty > 0;
  perform 1 from public.stock_batches where id = any(coalesce(v_src_ids, '{}') || coalesce(v_dst_ids, '{}')) order by id for update;

  for v_line in select * from public.transfer_order_items where transfer_order_id = v_t.id and qty > 0 order by id loop
    v_lines := v_lines + 1;
    if v_line.item_id is null then
      return jsonb_build_object('status', 'CONFLICT_LINE_WITHOUT_ITEM', 'line_id', v_line.id, 'name', v_line.name);
    end if;
    -- Unit columns read through to_jsonb so the function also runs where they do not exist yet (NULL = legacy line).
    v_unit := to_jsonb(v_line)->>'transfer_unit';
    v_upp := (to_jsonb(v_line)->>'units_per_pack')::numeric;
    if public.vhc_transfer_dest_qty(v_line.qty, v_unit, v_upp) is null then
      return jsonb_build_object('status', 'CONFLICT_TRANSFER_UNIT', 'line_id', v_line.id, 'name', v_line.name,
        'transfer_unit', v_unit, 'units_per_pack', v_upp);
    end if;
    select count(*) into v_count from public.stock_batches
      where item_id = v_line.item_id and location_id = v_main and batch_no is not distinct from v_line.batch_no;
    if v_count <> 1 then
      return jsonb_build_object('status', case when v_count = 0 then 'CONFLICT_SOURCE_NOT_FOUND' else 'CONFLICT_SOURCE_AMBIGUOUS' end,
        'line_id', v_line.id, 'name', v_line.name, 'matches', v_count);
    end if;
    select * into v_src from public.stock_batches
      where item_id = v_line.item_id and location_id = v_main and batch_no is not distinct from v_line.batch_no;
    v_need := jsonb_set(v_need, array[v_src.id::text], to_jsonb(coalesce((v_need->>v_src.id::text)::numeric, 0) + v_line.qty));
    if (v_need->>v_src.id::text)::numeric > v_src.qty + 0.0005 then
      return jsonb_build_object('status', 'CONFLICT_INSUFFICIENT_STOCK', 'line_id', v_line.id, 'name', v_line.name,
        'available', v_src.qty, 'needed', (v_need->>v_src.id::text)::numeric);
    end if;
    select count(*) into v_count from public.stock_batches
      where item_id = v_line.item_id and location_id = v_pharm and batch_no is not distinct from v_line.batch_no;
    if v_count > 1 then
      return jsonb_build_object('status', 'CONFLICT_DESTINATION_AMBIGUOUS', 'line_id', v_line.id, 'name', v_line.name, 'matches', v_count);
    end if;
  end loop;
  if v_lines = 0 then
    return jsonb_build_object('status', 'CONFLICT_NO_LINES', 'transfer_id', v_t.id);
  end if;

  -- Phase 2: all writes, in one block. Any other error raises and rolls back the whole call (order stays Pending).
  -- Under SECURITY INVOKER an UPDATE blocked by the caller's RLS affects 0 rows WITHOUT an error, so every
  -- update is checked and raises insufficient_privilege; that (or an RLS-refused insert) rolls back every Phase 2
  -- write and returns NOT_PERMITTED (no ledger row without its stock change, no partial transfer).
  begin
    update public.transfer_orders set status = 'Completed' where id = v_t.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'Transfer % could not be marked Completed (not permitted); nothing was changed', v_t.transfer_number using errcode = 'insufficient_privilege'; end if;
    for v_line in select * from public.transfer_order_items where transfer_order_id = v_t.id and qty > 0 order by id loop
      v_unit := to_jsonb(v_line)->>'transfer_unit';
      v_upp := (to_jsonb(v_line)->>'units_per_pack')::numeric;
      v_dest := public.vhc_transfer_dest_qty(v_line.qty, v_unit, v_upp);   -- validated non-NULL in Phase 1
      v_note := case when v_unit is not null and v_upp <> 1
                     then format(' [%s entered; %s/pack conversion applied]', v_unit, trim_scale(v_upp)) else '' end;
      select * into v_src from public.stock_batches
        where item_id = v_line.item_id and location_id = v_main and batch_no is not distinct from v_line.batch_no;
      update public.stock_batches set qty = qty - v_line.qty, updated_at = v_now where id = v_src.id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then raise exception 'Main Stock batch for % was not updated (not permitted); nothing was changed', v_line.name using errcode = 'insufficient_privilege'; end if;
      insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
      values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':OUT', v_line.item_id, v_main, v_line.batch_no, 'TRANSFER', -v_line.qty,
              v_src.qty, v_src.qty - v_line.qty,
              format('Pharmacy transfer %s accepted (out of Main Stock)', v_t.transfer_number) || v_note, v_actor, v_now);

      select * into v_dst from public.stock_batches
        where item_id = v_line.item_id and location_id = v_pharm and batch_no is not distinct from v_line.batch_no;
      if found then
        update public.stock_batches set qty = qty + v_dest, updated_at = v_now where id = v_dst.id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then raise exception 'Pharmacy batch for % was not updated (not permitted); nothing was changed', v_line.name using errcode = 'insufficient_privilege'; end if;
        insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
        values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':IN', v_line.item_id, v_pharm, v_line.batch_no, 'TRANSFER', v_dest,
                v_dst.qty, v_dst.qty + v_dest,
                format('Pharmacy transfer %s accepted (into Pharmacy)', v_t.transfer_number) || v_note, v_actor, v_now);
      else
        -- No created_at: production stock_batches has no such column (TEST's defaults to now()).
        insert into public.stock_batches (item_id, location_id, batch_no, expiry_date, mrp, net_rate, gst, stockist, qty, updated_at)
        values (v_line.item_id, v_pharm, v_line.batch_no, v_line.expiry_date, v_line.mrp, v_line.net_rate, v_src.gst, v_src.stockist,
                v_dest, v_now);
        insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, reason, created_by, created_at)
        values ('VHC:TRANSFER:' || v_t.id || ':' || v_line.id || ':IN', v_line.item_id, v_pharm, v_line.batch_no, 'TRANSFER', v_dest,
                0, v_dest,
                format('Pharmacy transfer %s accepted (into Pharmacy, new batch)', v_t.transfer_number) || v_note, v_actor, v_now);
      end if;
    end loop;
  exception when insufficient_privilege then
    -- RLS refused a status/stock update or an insert: every Phase 2 write is rolled back, order stays Pending.
    return jsonb_build_object('status', 'NOT_PERMITTED', 'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number);
  end;

  return jsonb_build_object('status', 'APPLIED', 'transfer_id', v_t.id, 'transfer_number', v_t.transfer_number,
    'lines', v_lines, 'created_by', v_actor, 'completed_at', v_now);
end;
$$;
revoke all on function public.accept_pharmacy_transfer(jsonb) from public, anon;
grant execute on function public.accept_pharmacy_transfer(jsonb) to authenticated, service_role;
