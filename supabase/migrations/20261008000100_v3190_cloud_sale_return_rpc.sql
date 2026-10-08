-- VHC v3.19.0 — production-compatible cloud (historical) return / refund execution
--
-- Objects:
--   1. widens public.stock_movements_type_check to also allow 'RETURN'      (SCHEMA CHANGE)
--   2. public.vhc_return_line_allocation(uuid, uuid)  — internal, deterministic stock reconstruction
--  2b. public.vhc_sale_recorded_outstanding(uuid)     — internal, credit still owed on the bill
--   3. public.create_sale_return(jsonb)               — atomic, idempotent return execution
--   4. public.get_sale_return_eligibility(text)       — read-only per-line returnability for the UI
--
-- WHY THE DESIGN LOOKS LIKE THIS (proven on a restored copy of production, 2026-10-08)
--   * Production uploads cloud sales RECORD-ONLY: all 12,015 historical sale_items have
--     affects_stock = false and stock_batch_id = NULL. Stock was deducted separately through
--     stock_movements rows of type 'BILL' that carry bill_id, item_id, location_id, batch_no and
--     the (negative) quantity. So stock for a return is reconstructed from those BILL movements,
--     never from sale_items.stock_batch_id / affects_stock.
--   * Every historical medicine line with stock history maps ONE-TO-ONE to a BILL movement on
--     (bill_id, item_id, normalised batch_no) with exactly equal quantity (0 mismatches, 0 keys
--     with several lines or several movements, 0 multi-batch sales). Each movement's batch resolves
--     through the UNIQUE natural key (item_id, location_id, normalised batch_no) of stock_batches.
--   * Lines whose own batch is blank / 'N/A' are matched to the bill's ONLY BILL movement for that
--     item, and only when the bill has exactly one line for that item — unique, not a guess.
--   * Anything else (batch no longer exists, no stock history, several candidates, quantity
--     mismatch, non-stock Custom / Injection / Procedure line) is REFUSED with a clear status and
--     zero mutation. A batch is never guessed and never re-created.
--   * Production public.sales has NO deleted_at / cancelled_at (deletes are hard deletes through
--     delete_sale_and_restore). A missing sale row is the only "deleted" signal and is sufficient.
--   * Production's stock_movements_type_check did not allow 'RETURN'. Rather than disguise a
--     return as 'RESTORE', the constraint is widened to include 'RETURN' (block 1). The rewrite
--     only ever ADDS the one value to the exact existing list and refuses unknown constraint shapes.
--
-- GUARANTEES
--  * Atomic: one plpgsql call = one transaction; no exception handler around any mutation.
--  * Idempotent: client-supplied deterministic return_id (= sale_returns.id). Replay returns
--    ALREADY_APPLIED and writes nothing. Each restored batch allocation also carries the
--    deterministic movement_key 'VHC:RETURN:<return_id>:<sale_item_id>:<source BILL movement id>'
--    (unique index from 20260929000100), adopted instead of re-applied if it already exists.
--  * All lines are validated BEFORE the first write; a refused line refuses the whole return.
--  * Never restores more than was deducted: returned + requested <= sold == deducted.
--  * Original sale and its lines are only read and row-locked; never inserted, updated or deleted.
--  * Credit bills: return value first reduces outstanding credit; only a genuine excess is
--    refunded. An optional caller 'outstanding_amount' hint can only LOWER absorbed credit.
--    Bills without recorded payment detail follow the app's convention (Credit = fully owed,
--    single paid mode = fully paid); a Split bill without its breakdown is refused
--    (RETURN_REFUSED[PAYMENT_STATE_UNKNOWN]) rather than guess how much cash to pay out.
--
-- LOCKING: block 1 briefly takes an ACCESS EXCLUSIVE lock on public.stock_movements to swap the
-- CHECK constraint and validate existing rows (~12.5k rows in production; sub-second).

do $preflight$
begin
  if to_regclass('public.sale_returns') is null
     or to_regclass('public.sale_return_items') is null
     or to_regclass('public.sale_refunds') is null
     or to_regclass('public.sale_return_credits') is null then
    raise exception 'Return/refund audit tables are missing. Apply 20261006000100_v3182_return_exchange_refund_audit.sql first.';
  end if;
  if to_regprocedure('public.is_pharmacy_writer()') is null then
    raise exception 'public.is_pharmacy_writer() is missing. Apply 20260929000100_v3182_idempotent_stock_reconciliation.sql first.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stock_movements' and column_name = 'movement_key'
  ) then
    raise exception 'public.stock_movements.movement_key is missing. Apply 20260929000100_v3182_idempotent_stock_reconciliation.sql first.';
  end if;
end;
$preflight$;

-- ── 1. Allow 'RETURN' stock movements ───────────────────────────────────────────────────────
do $widen$
declare
  v_def  text;
  v_vals text[];
  v_list text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.stock_movements'::regclass and c.conname = 'stock_movements_type_check';

  if v_def is null then
    raise notice 'stock_movements_type_check is not present here; type is unconstrained — nothing to widen.';
  elsif v_def ~ '''RETURN''' then
    raise notice 'stock_movements_type_check already allows RETURN.';
  else
    -- Only rewrite the exact shape we have verified in production: CHECK ((type = ANY (ARRAY[...])))
    if v_def !~ '^CHECK \(\(type = ANY \(ARRAY\[(''[A-Z_]+''::text(, )?)+\]\)\)\)$' then
      raise exception 'Unexpected stock_movements_type_check shape, refusing to rewrite: %', v_def;
    end if;
    select array_agg(m.v[1] order by m.ord) into v_vals
      from regexp_matches(v_def, '''([A-Z_]+)''', 'g') with ordinality as m(v, ord);
    v_vals := v_vals || array['RETURN'];
    select string_agg(quote_literal(x), ', ') into v_list from unnest(v_vals) as x;
    execute format(
      'alter table public.stock_movements drop constraint stock_movements_type_check, '
      'add constraint stock_movements_type_check check (type = any (array[%s]::text[]))', v_list);
    raise notice 'stock_movements_type_check widened to: %', v_list;
  end if;
end;
$widen$;

-- ── 2. Deterministic reconstruction of one sold line's original stock deduction ─────────────
create or replace function public.vhc_return_line_allocation(p_sale_id uuid, p_sale_item_id uuid)
returns table (
  status text, detail text, source_movement_id uuid, stock_batch_id uuid,
  item_id uuid, location_id uuid, batch_no text, deducted numeric
)
language plpgsql
stable
security definer
set search_path = public
as $alloc$
declare
  v_item   public.sale_items%rowtype;
  v_bill   text;
  v_key    text;
  v_exact  integer;
  v_any    integer;
  v_lines  integer;
  v_mv     public.stock_movements%rowtype;
  v_batch  uuid[];
begin
  select * into v_item from public.sale_items si where si.id = p_sale_item_id and si.sale_id = p_sale_id;
  if not found then
    status := 'NOT_IN_BILL'; detail := 'Line does not belong to this bill'; return next; return;
  end if;
  if v_item.item_id is null then
    status := 'NON_STOCK';
    detail := coalesce(nullif(v_item.category, ''), 'Custom') || ' line is not a stock item and is not returnable';
    return next; return;
  end if;

  select s.bill_id into v_bill from public.sales s where s.id = p_sale_id;
  v_key := lower(btrim(coalesce(v_item.batch_no, '')));

  select count(*) into v_exact from public.stock_movements m
   where m.type = 'BILL' and m.bill_id = v_bill and m.item_id = v_item.item_id
     and lower(btrim(coalesce(m.batch_no, ''))) = v_key;

  if v_exact = 1 then
    select * into v_mv from public.stock_movements m
     where m.type = 'BILL' and m.bill_id = v_bill and m.item_id = v_item.item_id
       and lower(btrim(coalesce(m.batch_no, ''))) = v_key;
  elsif v_exact > 1 then
    status := 'AMBIGUOUS'; detail := 'Several original stock movements match this line'; return next; return;
  else
    select count(*) into v_any from public.stock_movements m
     where m.type = 'BILL' and m.bill_id = v_bill and m.item_id = v_item.item_id;
    if v_any = 0 then
      status := 'NO_STOCK_HISTORY'; detail := 'No original stock deduction was recorded for this line'; return next; return;
    end if;
    if v_key not in ('', 'n/a', 'na', '-') then
      status := 'AMBIGUOUS'; detail := 'The line''s batch does not match its original stock deduction'; return next; return;
    end if;
    select count(*) into v_lines from public.sale_items si where si.sale_id = p_sale_id and si.item_id = v_item.item_id;
    if v_any <> 1 or v_lines <> 1 then
      status := 'AMBIGUOUS'; detail := 'Batch not recorded on the line and the original deduction is not unique'; return next; return;
    end if;
    select * into v_mv from public.stock_movements m
     where m.type = 'BILL' and m.bill_id = v_bill and m.item_id = v_item.item_id;
  end if;

  if (-v_mv.qty) <> v_item.quantity then
    status := 'QTY_MISMATCH'; detail := 'Sold quantity differs from the original stock deduction'; return next; return;
  end if;

  select array_agg(b.id) into v_batch from public.stock_batches b
   where b.item_id = v_mv.item_id and b.location_id = v_mv.location_id
     and lower(btrim(coalesce(b.batch_no, ''))) = lower(btrim(coalesce(v_mv.batch_no, '')));
  if coalesce(array_length(v_batch, 1), 0) = 0 then
    status := 'BATCH_GONE'; detail := 'The original stock batch no longer exists'; return next; return;
  end if;
  if array_length(v_batch, 1) > 1 then
    status := 'AMBIGUOUS'; detail := 'Several stock batches share the original batch identity'; return next; return;
  end if;

  status := 'RETURNABLE'; detail := null;
  source_movement_id := v_mv.id; stock_batch_id := v_batch[1];
  item_id := v_mv.item_id; location_id := v_mv.location_id; batch_no := v_mv.batch_no;
  deducted := -v_mv.qty;
  return next;
end;
$alloc$;

-- ── 2b. Credit still owed on the bill when it was recorded ─────────────────────────────────
-- Production cloud sales carry NO payment detail (outstanding_amount, amount_received and
-- payment_breakdown are NULL on every historical row). Without detail, the app's own existing
-- convention (Payments report / ae()) applies: Credit = fully outstanding, a single paid mode =
-- fully paid. A Split bill without its breakdown cannot be resolved → NULL, and the caller refuses
-- rather than guess how much cash may leave the till.
create or replace function public.vhc_sale_recorded_outstanding(p_sale_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $out$
  select case
    when s.outstanding_amount is not null then greatest(0, s.outstanding_amount)
    when jsonb_typeof(s.payment_breakdown) = 'object' then
      greatest(0, coalesce(nullif(s.payment_breakdown->>'credit', '')::numeric, 0))
    when lower(coalesce(s.payment_mode, '')) = 'credit' then greatest(0, coalesce(s.total_amount, 0))
    when lower(coalesce(s.payment_mode, '')) = 'split' then null
    else 0
  end
  from public.sales s where s.id = p_sale_id
$out$;

-- ── 3. Return execution ─────────────────────────────────────────────────────────────────────
create or replace function public.create_sale_return(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_return_id   uuid;
  v_bill_id     text;
  v_items       jsonb;
  v_return_type text;
  v_exchange_id uuid;
  v_recorded_by uuid;
  v_sale        public.sales%rowtype;
  v_existing    public.sale_returns%rowtype;
  v_item        public.sale_items%rowtype;
  v_batch       public.stock_batches%rowtype;
  v_movement    public.stock_movements%rowtype;
  v_alloc       record;
  v_line        jsonb;
  v_plan        jsonb := '[]'::jsonb;
  v_p           jsonb;
  v_distinct    integer;
  v_qty         numeric;
  v_already     numeric;
  v_unit        numeric;
  v_amount      numeric;
  v_total       numeric := 0;
  v_disposition text;
  v_restore     boolean;
  v_key         text;
  v_movement_id uuid;
  v_opening     numeric;
  v_closing     numeric;
  v_outstanding numeric;
  v_hint        numeric;
  v_consumed    numeric;
  v_credit      numeric;
  v_refund      numeric;
  v_method      text;
  v_lines       jsonb := '[]'::jsonb;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to record pharmacy returns';
  end if;

  v_return_id   := nullif(payload->>'return_id', '')::uuid;
  v_bill_id     := nullif(payload->>'bill_id', '');
  v_items       := payload->'items';
  v_return_type := coalesce(nullif(payload->>'return_type', ''), 'RETURN');
  v_exchange_id := nullif(payload->>'exchange_sale_id', '')::uuid;
  v_recorded_by := coalesce(nullif(payload->>'recorded_by', '')::uuid, auth.uid());

  if v_return_id is null or v_bill_id is null then
    raise exception 'return_id and bill_id are required';
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'At least one return line is required';
  end if;
  if v_return_type not in ('RETURN', 'EXCHANGE') then
    raise exception 'Unsupported return_type %', v_return_type;
  end if;
  select count(distinct e->>'sale_item_id') into v_distinct from jsonb_array_elements(v_items) e;
  if v_distinct <> jsonb_array_length(v_items) then
    raise exception 'Each sale item may appear only once per return';
  end if;

  -- The original sale, row-locked to serialise returns on this bill (also guards the replay check
  -- below against a concurrent caller with the same return_id). A missing row = deleted / unknown.
  select * into v_sale from public.sales where bill_id = v_bill_id for update;
  if not found then
    raise exception 'Original sale for bill % was not found', v_bill_id;
  end if;

  select * into v_existing from public.sale_returns where id = v_return_id;
  if found then
    if v_existing.original_bill_id <> v_bill_id then
      raise exception 'return_id % is already used by bill %', v_return_id, v_existing.original_bill_id;
    end if;
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED', 'return_id', v_existing.id, 'bill_id', v_existing.original_bill_id,
      'original_sale_id', v_existing.original_sale_id, 'return_type', v_existing.return_type,
      'return_amount', v_existing.return_amount, 'refund_amount', v_existing.refund_amount,
      'credit_amount', v_existing.credit_amount, 'refund_method', v_existing.refund_method);
  end if;

  if v_return_type = 'EXCHANGE' and v_exchange_id is not null
     and not exists (select 1 from public.sales where id = v_exchange_id) then
    raise exception 'Exchange sale % was not found', v_exchange_id;
  end if;

  -- ── Pass 1: validate EVERY line before any write ──────────────────────────────────────────
  for v_line in select value from jsonb_array_elements(v_items) loop
    v_qty := (v_line->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Each return line requires a positive quantity';
    end if;
    v_disposition := coalesce(nullif(v_line->>'disposition', ''), 'SALEABLE');
    if v_disposition not in ('SALEABLE', 'DAMAGED', 'NON_SALEABLE') then
      raise exception 'Unsupported disposition %', v_disposition;
    end if;

    select * into v_item from public.sale_items
     where id = nullif(v_line->>'sale_item_id', '')::uuid and sale_id = v_sale.id;
    if not found then
      raise exception 'Return line does not belong to bill %', v_bill_id;
    end if;

    select * into v_alloc from public.vhc_return_line_allocation(v_sale.id, v_item.id);
    if v_alloc.status <> 'RETURNABLE' then
      raise exception 'RETURN_REFUSED[%] %: %', v_alloc.status, coalesce(v_item.drug_name, 'line'), v_alloc.detail;
    end if;

    select coalesce(sum(sri.quantity), 0) into v_already
      from public.sale_return_items sri
      join public.sale_returns sr on sr.id = sri.return_id
     where sri.original_sale_item_id = v_item.id and sr.status = 'COMPLETED';

    if v_already + v_qty > least(v_item.quantity, v_alloc.deducted) + 0.0005 then
      raise exception 'Return quantity exceeds remaining sold quantity for % (sold %, already returned %, requested %)',
        coalesce(v_item.drug_name, 'item'), v_item.quantity, v_already, v_qty;
    end if;

    v_plan := v_plan || jsonb_build_object(
      'sale_item_id', v_item.id, 'qty', v_qty, 'disposition', v_disposition, 'already', v_already,
      'source_movement_id', v_alloc.source_movement_id, 'stock_batch_id', v_alloc.stock_batch_id);
  end loop;

  v_outstanding := public.vhc_sale_recorded_outstanding(v_sale.id);
  if v_outstanding is null then
    raise exception 'RETURN_REFUSED[PAYMENT_STATE_UNKNOWN] Bill %: the split payment breakdown was not recorded, so refund vs credit cannot be determined', v_bill_id;
  end if;

  -- ── Pass 2: write ──────────────────────────────────────────────────────────────────────────
  insert into public.sale_returns (
    id, original_sale_id, original_bill_id, patient_id, return_type, status,
    return_amount, refund_amount, credit_amount, exchange_sale_id, recorded_by, metadata
  ) values (
    v_return_id, v_sale.id, v_sale.bill_id, v_sale.patient_id, v_return_type, 'COMPLETED',
    0, 0, 0, case when v_return_type = 'EXCHANGE' then v_exchange_id else null end, v_recorded_by,
    jsonb_strip_nulls(jsonb_build_object(
      'source', coalesce(nullif(payload->>'source', ''), 'cloud-return'),
      'reason', nullif(payload->>'reason', ''),
      'original_payment_mode', v_sale.payment_mode,
      'stock_source', 'original BILL stock movements'))
  );

  for v_p in select value from jsonb_array_elements(v_plan) loop
    select * into v_item from public.sale_items where id = (v_p->>'sale_item_id')::uuid;
    v_qty         := (v_p->>'qty')::numeric;
    v_already     := (v_p->>'already')::numeric;
    v_disposition := v_p->>'disposition';
    v_unit        := case when v_item.quantity > 0 then v_item.total / v_item.quantity else 0 end;
    v_amount      := round(v_unit * v_qty, 2);
    v_total       := v_total + v_amount;
    v_restore     := v_disposition = 'SALEABLE';
    v_movement_id := null; v_opening := null; v_closing := null; v_key := null;

    if v_restore then
      v_key := 'VHC:RETURN:' || v_return_id::text || ':' || v_item.id::text || ':' || (v_p->>'source_movement_id');
      select * into v_movement from public.stock_movements where movement_key = v_key;
      if found then
        v_movement_id := v_movement.id; v_opening := v_movement.opening; v_closing := v_movement.closing;
      else
        select * into v_batch from public.stock_batches where id = (v_p->>'stock_batch_id')::uuid for update;
        if not found then
          raise exception 'Original stock batch for % disappeared during the return', coalesce(v_item.drug_name, 'item');
        end if;
        v_opening := v_batch.qty;
        v_closing := v_batch.qty + v_qty;
        update public.stock_batches set qty = v_closing, updated_at = now() where id = v_batch.id;
        -- seq is never supplied: production's GENERATED ALWAYS AS IDENTITY seq allocates itself.
        insert into public.stock_movements (
          movement_key, item_id, location_id, batch_no, type, qty,
          opening, closing, bill_id, patient_id, reason, created_by
        ) values (
          v_key, v_batch.item_id, v_batch.location_id, v_batch.batch_no, 'RETURN', v_qty,
          v_opening, v_closing, v_sale.bill_id, v_sale.patient_id,
          coalesce(nullif(payload->>'reason', ''), 'Sale return stock restoration'), auth.uid()
        ) returning id into v_movement_id;
      end if;
    end if;

    insert into public.sale_return_items (
      return_id, original_sale_item_id, item_id, stock_batch_id, quantity, original_quantity,
      already_returned_quantity, unit_net_value, return_amount, disposition, restoration_movement_id
    ) values (
      v_return_id, v_item.id, v_item.item_id, (v_p->>'stock_batch_id')::uuid, v_qty, v_item.quantity,
      v_already, round(v_unit, 2), v_amount, v_disposition, v_movement_id
    );

    v_lines := v_lines || jsonb_build_object(
      'sale_item_id', v_item.id, 'drug_name', v_item.drug_name, 'quantity', v_qty,
      'return_amount', v_amount, 'disposition', v_disposition, 'stock_restored', v_restore,
      'stock_batch_id', v_p->>'stock_batch_id', 'source_movement_id', v_p->>'source_movement_id',
      'movement_id', v_movement_id, 'movement_key', v_key, 'opening', v_opening, 'closing', v_closing);
  end loop;

  v_total := round(v_total, 2);

  v_hint := nullif(payload->>'outstanding_amount', '')::numeric;
  if v_hint is not null then
    v_outstanding := least(v_outstanding, greatest(0, v_hint));
  end if;
  select coalesce(sum(sr.credit_amount), 0) into v_consumed
    from public.sale_returns sr
   where sr.original_sale_id = v_sale.id and sr.status = 'COMPLETED' and sr.id <> v_return_id;
  v_outstanding := greatest(0, v_outstanding - v_consumed);
  v_credit := round(least(v_total, v_outstanding), 2);
  v_refund := round(greatest(0, v_total - v_credit), 2);

  if v_refund > 0 then
    v_method := coalesce(nullif(payload->>'refund_method', ''),
      case lower(coalesce(v_sale.payment_mode, ''))
        when 'upi' then 'UPI' when 'card' then 'Card' when 'cash' then 'Cash' else 'Cash' end);
    if v_method not in ('Cash', 'UPI', 'Card', 'Other') then
      raise exception 'Unsupported refund_method %', v_method;
    end if;
  else
    v_method := null;
  end if;

  update public.sale_returns
     set return_amount = v_total, refund_amount = v_refund, credit_amount = v_credit, refund_method = v_method
   where id = v_return_id;

  if v_refund > 0 then
    insert into public.sale_refunds (return_id, amount, method, reference, status, recorded_by)
    values (v_return_id, v_refund, v_method, nullif(payload->>'refund_reference', ''), 'COMPLETED', v_recorded_by);
  end if;
  if v_credit > 0 then
    insert into public.sale_return_credits (return_id, applied_sale_id, amount)
    values (v_return_id, case when v_return_type = 'EXCHANGE' then v_exchange_id else null end, v_credit);
  end if;

  return jsonb_build_object(
    'status', 'APPLIED', 'return_id', v_return_id, 'bill_id', v_sale.bill_id,
    'original_sale_id', v_sale.id, 'return_type', v_return_type,
    'return_amount', v_total, 'refund_amount', v_refund, 'credit_amount', v_credit,
    'refund_method', v_method, 'items', v_lines);
end;
$fn$;

-- ── 4. Read-only eligibility for the Return / Exchange screen ───────────────────────────────
create or replace function public.get_sale_return_eligibility(p_bill_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $elig$
declare
  v_sale    public.sales%rowtype;
  v_line    public.sale_items%rowtype;
  v_alloc   record;
  v_already numeric;
  v_owed    numeric;
  v_out     jsonb := '[]'::jsonb;
begin
  if not coalesce(public.is_pharmacy_writer(), false) then
    raise exception 'Not authorized to read pharmacy returns';
  end if;
  select * into v_sale from public.sales where bill_id = p_bill_id;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND', 'bill_id', p_bill_id, 'lines', '[]'::jsonb);
  end if;
  v_owed := public.vhc_sale_recorded_outstanding(v_sale.id);
  for v_line in select * from public.sale_items where sale_id = v_sale.id order by created_at, id loop
    select * into v_alloc from public.vhc_return_line_allocation(v_sale.id, v_line.id);
    select coalesce(sum(sri.quantity), 0) into v_already
      from public.sale_return_items sri join public.sale_returns sr on sr.id = sri.return_id
     where sri.original_sale_item_id = v_line.id and sr.status = 'COMPLETED';
    v_out := v_out || jsonb_build_object(
      'sale_item_id', v_line.id, 'drug_name', v_line.drug_name, 'category', v_line.category,
      'quantity', v_line.quantity, 'total', v_line.total, 'already_returned', v_already,
      'remaining', greatest(0, v_line.quantity - v_already),
      'status', v_alloc.status, 'reason', v_alloc.detail, 'batch_no', coalesce(v_alloc.batch_no, v_line.batch_no),
      'returnable', v_owed is not null and v_alloc.status = 'RETURNABLE' and v_line.quantity - v_already > 0);
  end loop;
  if v_owed is null then
    return jsonb_build_object('status', 'PAYMENT_STATE_UNKNOWN', 'bill_id', v_sale.bill_id, 'sale_id', v_sale.id,
      'reason', 'The split payment breakdown was not recorded for this bill, so refund vs credit cannot be determined',
      'lines', v_out);
  end if;
  return jsonb_build_object('status', 'OK', 'bill_id', v_sale.bill_id, 'sale_id', v_sale.id,
    'payment_mode', v_sale.payment_mode, 'recorded_credit', v_owed, 'lines', v_out);
end;
$elig$;

alter function public.vhc_return_line_allocation(uuid, uuid) owner to postgres;
alter function public.vhc_sale_recorded_outstanding(uuid) owner to postgres;
alter function public.create_sale_return(jsonb) owner to postgres;
alter function public.get_sale_return_eligibility(text) owner to postgres;
-- The two helpers are internal: reachable only through the two gated functions below.
revoke all on function public.vhc_return_line_allocation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.vhc_sale_recorded_outstanding(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_sale_return(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_sale_return_eligibility(text) from public, anon, authenticated, service_role;
grant execute on function public.create_sale_return(jsonb) to authenticated, service_role;
grant execute on function public.get_sale_return_eligibility(text) to authenticated, service_role;

comment on function public.create_sale_return(jsonb) is
  'Atomic, idempotent return/exchange for a cloud sale. Stock is reconstructed from the original BILL stock movements; ambiguous lines are refused with zero mutation. Keyed on a client-supplied return_id; movement_key VHC:RETURN:<return_id>:<sale_item_id>:<source movement>.';
comment on function public.get_sale_return_eligibility(text) is
  'Read-only per-line returnability for a cloud bill, using the same reconstruction as create_sale_return.';

do $verify$
declare
  v_oid    oid;
  v_secdef boolean;
  v_config text[];
  v_grants text[];
  v_fn     text;
  v_def    text;
begin
  foreach v_fn in array array['public.vhc_return_line_allocation(uuid,uuid)', 'public.vhc_sale_recorded_outstanding(uuid)', 'public.create_sale_return(jsonb)', 'public.get_sale_return_eligibility(text)'] loop
    v_oid := to_regprocedure(v_fn);
    if v_oid is null then raise exception '% was not created', v_fn; end if;
    select p.prosecdef, p.proconfig into v_secdef, v_config from pg_proc p where p.oid = v_oid;
    if not coalesce(v_secdef, false) then raise exception '% must be SECURITY DEFINER', v_fn; end if;
    if v_config is null or not ('search_path=public' = any (v_config)) then raise exception '% must pin search_path=public', v_fn; end if;
  end loop;
  foreach v_fn in array array['create_sale_return', 'get_sale_return_eligibility'] loop
    select coalesce(array_agg(distinct grantee order by grantee), array[]::text[]) into v_grants
      from information_schema.routine_privileges
     where specific_schema = 'public' and routine_name = v_fn and privilege_type = 'EXECUTE';
    if v_grants is distinct from array['authenticated','postgres','service_role']::text[] then
      raise exception '% EXECUTE grants are unexpected: %', v_fn, v_grants;
    end if;
  end loop;
  foreach v_fn in array array['vhc_return_line_allocation', 'vhc_sale_recorded_outstanding'] loop
    select coalesce(array_agg(distinct grantee order by grantee), array[]::text[]) into v_grants
      from information_schema.routine_privileges
     where specific_schema = 'public' and routine_name = v_fn and privilege_type = 'EXECUTE';
    if v_grants is distinct from array['postgres']::text[] then
      raise exception '% must be owner-only, got %', v_fn, v_grants;
    end if;
  end loop;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.stock_movements'::regclass and c.conname = 'stock_movements_type_check';
  if v_def is not null and v_def !~ '''RETURN''' then
    raise exception 'stock_movements_type_check still rejects RETURN: %', v_def;
  end if;
end;
$verify$;
