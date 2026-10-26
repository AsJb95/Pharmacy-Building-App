-- TEST-project (dvscemgqegmfmgrtytal) functional check for 20261026000100. Everything runs in ONE DO block that ends
-- with RAISE EXCEPTION, so every scratch row (items, patients, batches, movements, transfer orders) is ROLLED BACK.
-- The exception text carries the PASS/FAIL list. No existing row is touched. No patient/QA data is read or printed.
do $qa$
declare
  res jsonb := '[]'::jsonb; r jsonb; uid uuid; wm uuid; pc uuid; p1 uuid; p2 uuid;
  i0 uuid; i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; i7 uuid;
  b_ab uuid; b_pab uuid; b_r uuid; b_s uuid; b_c uuid; t uuid; x numeric; y numeric; n int; f1 text; f2 text;
  c_mv int := (select count(*) from public.stock_movements);
  c_sb int := (select count(*) from public.stock_batches);
begin
  -- helpers (pg_temp, rolled back with everything else)
  execute $f$create function pg_temp.qa_call(fn text, p jsonb) returns jsonb language plpgsql as $b$
    declare r jsonb; begin
      execute 'set local role authenticated';
      execute format('select public.%I($1)', fn) into r using p;
      execute 'reset role';
      return r;
    exception when others then return jsonb_build_object('status', 'ERROR', 'error', sqlerrm); end $b$$f$;
  execute $f$create function pg_temp.qa_order(wm uuid, pc uuid, lines text) returns uuid language plpgsql as $b$
    declare t uuid := gen_random_uuid(); l jsonb; begin
      insert into public.transfer_orders (id, transfer_number, from_location_id, to_location_id, status)
        values (t, 'QA-ROLLBACK-' || left(t::text, 8), wm, pc, 'Pending');
      for l in select * from jsonb_array_elements(lines::jsonb) loop
        if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'transfer_order_items' and column_name = 'units_per_pack') then
          execute 'insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty, units_per_pack, transfer_unit) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)'
            using t, (l->>'item')::uuid, 'QA line', l->>'batch', (l->>'qty')::numeric, nullif(l->>'upp', '')::numeric, nullif(l->>'unit', '');
        else
          insert into public.transfer_order_items (id, transfer_order_id, item_id, name, batch_no, qty)
            values (gen_random_uuid(), t, (l->>'item')::uuid, 'QA line', l->>'batch', (l->>'qty')::numeric);
        end if;
      end loop;
      return t; end $b$$f$;
  execute $f$create function pg_temp.qa_qty(i uuid, loc uuid) returns text language sql as $b$
    select coalesce(string_agg(coalesce(batch_no, '~') || '=' || trim_scale(qty)::text, ',' order by batch_no), '') from public.stock_batches where item_id = i and location_id = loc $b$$f$;

  select id into uid from auth.users order by created_at limit 1;
  select id into wm from public.locations where type = 'warehouse_main';
  select id into pc from public.locations where type = 'pharmacy_counter';
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  insert into public.items (name) values ('QA-RB 0') returning id into i0; insert into public.items (name) values ('QA-RB 1') returning id into i1;
  insert into public.items (name) values ('QA-RB 2') returning id into i2; insert into public.items (name) values ('QA-RB 3') returning id into i3;
  insert into public.items (name) values ('QA-RB 4') returning id into i4; insert into public.items (name) values ('QA-RB 5') returning id into i5;
  insert into public.items (name) values ('QA-RB 6') returning id into i6; insert into public.items (name) values ('QA-RB 7') returning id into i7;
  insert into public.patients (name) values ('QA-RB patient A') returning id into p1;
  insert into public.patients (name) values ('QA-RB patient B') returning id into p2;

  -- ── Warehouse transfer ──
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i0, wm, 'Ab-1', 50) returning id into b_ab;
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i0, pc, 'AB-1', 5) returning id into b_pab;
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i0 || '","batch":"Ab-1","qty":10}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR1 Production case: pharmacy batch differs only by case -> APPLIED into the SAME batch (AB-1 5->15, Main 50->40)',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i0, pc) = 'AB-1=15' and pg_temp.qa_qty(i0, wm) = 'Ab-1=40', 'got', r->>'status', 'ph', pg_temp.qa_qty(i0, pc));
  select string_agg(batch_no || ':' || trim_scale(opening) || '>' || trim_scale(closing) || ':' || (created_by = uid), ',' order by movement_key) into f1
    from public.stock_movements where movement_key like 'VHC:TRANSFER:' || t || ':%';
  res := res || jsonb_build_object('t', 'TR1 IN/OUT movements: real batch numbers, exact opening/closing, created_by = actor',
    'ok', f1 = 'AB-1:5>15:true,Ab-1:50>40:true', 'got', f1);
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR1 retry -> ALREADY_COMPLETED, stock unchanged', 'ok', r->>'status' = 'ALREADY_COMPLETED' and pg_temp.qa_qty(i0, pc) = 'AB-1=15', 'got', r->>'status');
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i0 || '","batch":"ab-1 ","qty":5}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR2 line differs from BOTH batches by case + trailing space -> APPLIED (15->20, 40->35)',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i0, pc) = 'AB-1=20' and pg_temp.qa_qty(i0, wm) = 'Ab-1=35', 'got', r->>'status');

  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i1, wm, 'W-7', 20);
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i1 || '","batch":"  w-7 ","qty":4}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR3 whitespace/case line, no pharmacy batch -> new batch named like Main (W-7=4), Main 20->16',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i1, pc) = 'W-7=4' and pg_temp.qa_qty(i1, wm) = 'W-7=16', 'got', r->>'status', 'ph', pg_temp.qa_qty(i1, pc));

  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i2, wm, 'Z-1', 10);
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i2 || '","batch":"Z-1","qty":3},{"item":"' || i2 || '","batch":"z-1 ","qty":2}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR4 two lines of one identity (case/space) -> ONE pharmacy batch Z-1=5, Main 10->5',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i2, pc) = 'Z-1=5' and pg_temp.qa_qty(i2, wm) = 'Z-1=5', 'got', r->>'status', 'ph', pg_temp.qa_qty(i2, pc));

  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i3, wm, 'Q-1', 4);
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i3 || '","batch":"Q-1","qty":3},{"item":"' || i3 || '","batch":"q-1","qty":2}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR5 need summed across case variants (5 > 4) -> CONFLICT_INSUFFICIENT_STOCK, nothing moved, still Pending',
    'ok', r->>'status' = 'CONFLICT_INSUFFICIENT_STOCK' and pg_temp.qa_qty(i3, wm) = 'Q-1=4' and pg_temp.qa_qty(i3, pc) = ''
      and (select status from public.transfer_orders where id = t) = 'Pending', 'got', r->>'status');

  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i4, wm, 'U-1', 6);
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i4, pc, 'u-1', 1);
  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i4 || '","batch":"U-1 ","qty":2,"unit":"strips","upp":10}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'transfer_order_items' and column_name = 'units_per_pack') then
    res := res || jsonb_build_object('t', 'TR6 strips->units conversion on a case-variant batch: pharmacy 1 + 2x10 = 21, Main 6->4',
      'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i4, pc) = 'u-1=21' and pg_temp.qa_qty(i4, wm) = 'U-1=4', 'got', r->>'status');
  else
    res := res || jsonb_build_object('t', 'TR6a (no unit columns here) legacy 1:1 line on a case-variant batch: pharmacy 1 + 2 = 3, Main 6->4',
      'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i4, pc) = 'u-1=3' and pg_temp.qa_qty(i4, wm) = 'U-1=4', 'got', r->>'status');
    res := res || jsonb_build_object('t', 'TR6 strips->units conversion', 'ok', null, 'skip', true, 'got', 'NOT RUN: transfer_order_items has no units_per_pack/transfer_unit on this project');
  end if;

  t := pg_temp.qa_order(wm, pc, '[{"item":"' || i4 || '","batch":"nope","qty":1}]');
  r := pg_temp.qa_call('accept_pharmacy_transfer', jsonb_build_object('transfer_id', t));
  res := res || jsonb_build_object('t', 'TR7 unknown batch -> CONFLICT_SOURCE_NOT_FOUND (unchanged)', 'ok', r->>'status' = 'CONFLICT_SOURCE_NOT_FOUND', 'got', r->>'status');

  -- ── Stock restore (apply_stock_restore) ──
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i5, pc, 'B-1', 10) returning id into b_r;
  insert into public.stock_movements (movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason)
    values ('VHC:BILL:QA-RB-RS1:m1', i5, pc, 'b-1 ', 'BILL', -2, 12, 10, 'QA-RB-RS1', p1, 'Bill:QA-RB-RS1'),
           ('VHC:BILL:QA-RB-RS3:m1', i5, pc, 'B-1', 'BILL', -1, 13, 12, 'QA-RB-RS3', p1, 'Bill:QA-RB-RS3'),
           ('VHC:BILL:QA-RB-RS3:m2', i5, pc, 'B-1', 'BILL', -1, 14, 13, 'QA-RB-RS3', p2, 'Bill:QA-RB-RS3');
  r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS1', 'stock_batch_id', b_r, 'quantity_delta', 2,
    'reason', 'Bill deleted — stock restored', 'patient_id', '99999999-9999-4999-8999-999999999999'));
  res := res || jsonb_build_object('t', 'RS1 non-cloud patient uuid ignored -> APPLIED 10->12 (old code: FK error)',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i5, pc) = 'B-1=12', 'got', r->>'status', 'err', r->>'error');
  res := res || jsonb_build_object('t', 'RS1 RESTORE row carries the patient of the bill''s deduction (case/space-variant batch_no)',
    'ok', (select patient_id from public.stock_movements where movement_key = 'VHC:RESTORE:QA-RB-RS1:' || b_r) = p1);
  r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS1', 'stock_batch_id', b_r, 'quantity_delta', 2,
    'reason', 'Bill deleted — stock restored', 'patient_id', 'local-17'));
  res := res || jsonb_build_object('t', 'RS2 retry -> ALREADY_APPLIED, stock unchanged (12)', 'ok', r->>'status' = 'ALREADY_APPLIED' and pg_temp.qa_qty(i5, pc) = 'B-1=12', 'got', r->>'status');
  r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS2', 'stock_batch_id', b_r, 'quantity_delta', 1,
    'reason', 'Bill deleted — stock restored', 'patient_id', 'local-17'));
  res := res || jsonb_build_object('t', 'RS3 non-uuid local id ignored (old code: cast error), no deduction -> APPLIED, patient NULL',
    'ok', r->>'status' = 'APPLIED' and (select patient_id from public.stock_movements where movement_key = 'VHC:RESTORE:QA-RB-RS2:' || b_r) is null, 'got', r->>'status', 'err', r->>'error');
  r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS3', 'stock_batch_id', b_r, 'quantity_delta', 2,
    'reason', 'Bill deleted — stock restored', 'patient_id', p1));
  res := res || jsonb_build_object('t', 'RS4 two different patients on the deductions -> patient NULL (payload ignored)',
    'ok', r->>'status' = 'APPLIED' and (select patient_id from public.stock_movements where movement_key = 'VHC:RESTORE:QA-RB-RS3:' || b_r) is null, 'got', r->>'status');
  begin
    alter table public.stock_movements add constraint qa_rb_force_fail check (reason is distinct from 'QA force write failure') not valid;
    x := (select qty from public.stock_batches where id = b_r);
    r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS4', 'stock_batch_id', b_r, 'quantity_delta', 1, 'reason', 'QA force write failure'));
    res := res || jsonb_build_object('t', 'RS5 write-phase constraint failure -> CONFLICT_RESTORE_WRITE_FAILED (23514), stock unchanged',
      'ok', r->>'status' = 'CONFLICT' and r->>'conflict' = 'CONFLICT_RESTORE_WRITE_FAILED' and r->>'sqlstate' = '23514'
        and (select qty from public.stock_batches where id = b_r) = x
        and not exists (select 1 from public.stock_movements where movement_key = 'VHC:RESTORE:QA-RB-RS4:' || b_r), 'got', r);
    alter table public.stock_movements drop constraint qa_rb_force_fail;
  exception when others then
    res := res || jsonb_build_object('t', 'RS5 write-phase constraint failure', 'ok', null, 'got', 'NOT RUN: ' || sqlerrm);
  end;
  r := pg_temp.qa_call('apply_stock_restore', jsonb_build_object('bill_id', 'QA-RB-RS6', 'stock_batch_id', b_r, 'quantity_delta', 1, 'reason', 'edit'));
  res := res || jsonb_build_object('t', 'RS6 weak reason -> REJECTED_REASON (unchanged)', 'ok', r->>'status' = 'REJECTED_REASON', 'got', r->>'status');

  -- ── Stock sync + bill restore with the fixed functions present ──
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i6, pc, 'S-1', 10) returning id into b_s;
  r := pg_temp.qa_call('apply_bill_stock_movements', jsonb_build_object('bill_id', 'QA-RB-BS1', 'movements', jsonb_build_array(
    jsonb_build_object('movement_key', 'VHC:BILL:QA-RB-BS1:1', 'stock_batch_id', b_s, 'quantity_delta', -3, 'item_id', i6, 'location_id', pc, 'batch_no', 's-1'))));
  res := res || jsonb_build_object('t', 'SS1 atomic bill deduction, case-variant batch_no -> APPLIED 10->7', 'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i6, pc) = 'S-1=7', 'got', r->>'status');
  r := pg_temp.qa_call('apply_bill_stock_movements', jsonb_build_object('bill_id', 'QA-RB-BS1', 'movements', jsonb_build_array(
    jsonb_build_object('movement_key', 'VHC:BILL:QA-RB-BS1:1', 'stock_batch_id', b_s, 'quantity_delta', -3))));
  res := res || jsonb_build_object('t', 'SS2 retry of the same bill -> ALREADY_APPLIED, no second deduction', 'ok', r->>'status' = 'ALREADY_APPLIED' and pg_temp.qa_qty(i6, pc) = 'S-1=7', 'got', r->>'status');
  r := pg_temp.qa_call('restore_bill_stock', jsonb_build_object('bill_id', 'QA-RB-BS1', 'reason', 'Bill deleted — stock restored', 'patient_id', 'local-5'));
  res := res || jsonb_build_object('t', 'BR1 bill delete restore -> APPLIED 7->10 + BILL-DELETED marker',
    'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i6, pc) = 'S-1=10' and exists (select 1 from public.stock_movements where movement_key = 'VHC:BILL-DELETED:QA-RB-BS1'), 'got', r->>'status');
  r := pg_temp.qa_call('restore_bill_stock', jsonb_build_object('bill_id', 'QA-RB-BS1', 'reason', 'Bill deleted — stock restored'));
  res := res || jsonb_build_object('t', 'BR2 delete retry -> ALREADY_APPLIED, no second restore', 'ok', r->>'status' = 'ALREADY_APPLIED' and pg_temp.qa_qty(i6, pc) = 'S-1=10', 'got', r->>'status');
  r := pg_temp.qa_call('apply_bill_stock_movements', jsonb_build_object('bill_id', 'QA-RB-BS1', 'movements', jsonb_build_array(
    jsonb_build_object('movement_key', 'VHC:BILL:QA-RB-BS1:2', 'stock_batch_id', b_s, 'quantity_delta', -1))));
  res := res || jsonb_build_object('t', 'BR3 late deduction of the deleted bill -> CONFLICT_BILL_DELETED', 'ok', r->>'conflict' = 'CONFLICT_BILL_DELETED', 'got', r);

  -- ── Stock correction + batch identity ──
  insert into public.stock_batches (item_id, location_id, batch_no, qty) values (i7, pc, 'C-1', 8) returning id into b_c;
  r := pg_temp.qa_call('apply_stock_correction', jsonb_build_object('request_key', 'qa-rb-req-0123456789ab', 'stock_batch_id', b_c,
    'expected_qty', 8, 'new_qty', 6, 'reason', 'Physical count found two strips damaged'));
  res := res || jsonb_build_object('t', 'SC1 stock correction (compare-and-set) -> APPLIED 8->6', 'ok', r->>'status' = 'APPLIED' and pg_temp.qa_qty(i7, pc) = 'C-1=6', 'got', r->>'status');
  r := pg_temp.qa_call('apply_stock_correction', jsonb_build_object('request_key', 'qa-rb-req-0123456789cd', 'stock_batch_id', b_c,
    'expected_qty', 8, 'new_qty', 5, 'reason', 'Physical count found two strips damaged'));
  res := res || jsonb_build_object('t', 'SC2 stale expected quantity -> CONFLICT_STALE_OPENING, unchanged', 'ok', r->>'status' = 'CONFLICT_STALE_OPENING' and pg_temp.qa_qty(i7, pc) = 'C-1=6', 'got', r->>'status');
  r := pg_temp.qa_call('create_stock_batch', jsonb_build_object('request_key', 'qa-rb-req-0123456789ef', 'item_id', i0, 'location_id', pc, 'batch_no', ' ab-1', 'opening_qty', 1));
  res := res || jsonb_build_object('t', 'SC3 create batch differing only by case/space from AB-1 -> CONFLICT_BATCH_EXISTS', 'ok', r->>'status' = 'CONFLICT_BATCH_EXISTS', 'got', r->>'status');

  -- ── Permissions ──
  res := res || jsonb_build_object('t', 'PERM anon cannot EXECUTE either fixed function; authenticated can',
    'ok', not has_function_privilege('anon', 'public.accept_pharmacy_transfer(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.apply_stock_restore(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.accept_pharmacy_transfer(jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.apply_stock_restore(jsonb)', 'execute'));
  begin
    execute 'set local role anon';
    perform public.accept_pharmacy_transfer(jsonb_build_object('transfer_id', t));
    execute 'reset role';
    res := res || jsonb_build_object('t', 'PERM anon call refused', 'ok', false);
  exception when insufficient_privilege then
    res := res || jsonb_build_object('t', 'PERM anon call -> permission denied', 'ok', true);
  end;

  select count(*) into n from jsonb_array_elements(res) e where (e->>'ok') is distinct from 'true' and (e->>'skip') is null;
  raise exception 'QA_RESULTS fails=% scratch_rows_before_rollback(mv=%,sb=%) %', n,
    (select count(*) from public.stock_movements) - c_mv, (select count(*) from public.stock_batches) - c_sb, res::text;
end
$qa$;
