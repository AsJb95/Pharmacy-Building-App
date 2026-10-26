# Manual stock correction fix (EDIT / RESTORE / TRANSFER)

Branch `fix/stock-correction` (worktree `C:\New VHC\VHC Pharmacy\.feature-worktrees\stock-correction`), based on the
v3.19.5 working state (commit e487696 + the uncommitted v3.19.5 release files). NOT committed, NOT deployed.

## Defects fixed (verified in v3.19.5 source)
| # | Path | Defect |
|---|---|---|
| D1 | Edit Item (`updateInventoryItem`) | batch qty updated, then a separate EDIT insert whose error is ignored → stock changes with no ledger row |
| D2 | Edit Item | reason validated only AFTER the qty update |
| D3 | Edit Item | opening taken from the client cache, no compare-and-set → silent lost update |
| D4 | EDIT/RESTORE/TRANSFER | no `created_by`; no request key → retries/double submits apply twice |
| D5 | Edit Item UI | not awaited; local "EDIT" audit + modal close before the server answers; errors swallowed; `parseInt` truncates fractional stock; the display mapper's MNERWIN 220→2200 rewrite flows into saves |
| D6 | Bill-delete RESTORE (`adjustStockBulk`) and transfer accept | update-then-insert, unchecked inserts, double restore possible, non-UUID patient id breaks the insert, failure hidden from the user; transfer marks Completed first, partial moves on failure |
| D7 | Inventory mapper `c()` (pre-v3.9.0) | code-level mapping bug: a hard-coded rule displayed a "MNERWIN NT PLUS" stock of 220 as 2200, and Add Item / bulk import / Edit could send the displayed value back; `parseInt` dropped fractional stock. Fixed in code only — no existing batch is known to be affected and this fix changes no stock data |
| D9 | Inventory row value, dashboard + admin stock valuation, low-stock widget/lists, expiry list, a medicine's batch total | `parseInt(stock)` truncated fractional stock in DISPLAYED quantities and values (20.5 units x Rs 10 shown as Rs 200.00 instead of Rs 205.00). Now `parseFloat` (17 expressions, display only; stored stock untouched; integer stock and the 50/200 low-stock bands behave exactly as before). Not changed: 4 import / purchase mappings and the cloud bulk-import merge still parse stock as an integer (they write stock; separate decision) |
| D8 | Unsynced local bills | the inventory shows a local overlay (stock minus bills not yet synced); a correction based on it is ambiguous against the cloud value — now refused with a clear message until sync completes |

## Review changes (2026-10-22)
* All three RPCs are SECURITY INVOKER (no definer, no `is_pharmacy_writer` gate): the caller's existing RLS decides
  exactly as for today's direct writes, so no privilege is widened and nobody allowed today is newly blocked.
  Confirmed against production RLS (read-only, 2026-10-22). Every UPDATE is row-count checked.
* Transfer: per-pharmacy-batch transaction advisory lock prevents two concurrent accepts creating the same batch twice.
* Restore: an older app's un-keyed RESTORE row for the same bill + batch counts as already applied (or a mismatch).
* TEST's seq trigger takes a global advisory lock (19360721, 3182) on every movement insert; the tests now include
  it verbatim. Lock order everywhere is batch rows -> (transfer batch lock) -> global ledger lock: no deadlock cycle
  (verified by concurrency tests and a 200-operation 8-session stress run with ledger reconciliation).

## Review changes, round 2 (2026-10-22, approved)
* Transfer new-batch insert no longer names `stock_batches.created_at` (production has no such column; TEST's
  defaults to now()). A contract check now verifies every column the migration names against the production column
  list (negative control: re-adding created_at makes it fail).
* Permission failures return `NOT_PERMITTED` (nothing changed) instead of `NOT_FOUND` / `CONFLICT_BATCH_NOT_FOUND`:
  - EDIT/RESTORE: batch readable but not lockable (RLS forbids UPDATE) -> NOT_PERMITTED; RLS-refused update or ledger
    insert inside the write block -> NOT_PERMITTED with the block rolled back.
  - TRANSFER: order readable but not lockable -> its readable status (ALREADY_COMPLETED / NOT_PENDING) if not
    Pending, else NOT_PERMITTED; any RLS refusal in Phase 2 (status, batch update, new-batch insert, ledger insert)
    -> NOT_PERMITTED with every Phase 2 write rolled back (order stays Pending).
  - No disclosure: a row the caller cannot READ is still reported as not found (CONFLICT_BATCH_NOT_FOUND / NOT_FOUND).
    NOT_PERMITTED is only returned for rows the caller's own SELECT policy already shows.
  - Client (cloud-src + dist mirror): new message "Your account is not allowed to make this stock change (ask an
    admin). Nothing was changed." No direct-write fallback.
* Non-permission failures (e.g. an injected trigger error) still raise and roll the whole call back.

## Status (2026-10-22)
* TEST (`dvscemgqegmfmgrtytal`): migration applied (history row `20261022050648`), 32/32 functional QA checks,
  post-QA verification and an authenticated end-to-end app test passed. QA records: `.qa-claude/TEST-QA-RECORDS.md`.
* Production (`yrgtnhvnwkqudxdcrkhm`): NOT applied. Read-only checks: schema, RLS (15 policies), role functions and
  default grants match what was tested; the stock-correction functions are absent; 0 pending transfers.

## Transfer unit conversion (fixed 2026-10-22, approved)
Verified read-only in VHC Mobile (`src/lib/transfers.js` planTransferLines / resolveAcceptedLine, `src/lib/units.js`,
`src/context/WarehouseContext.jsx` insertPendingTransfer / acceptPendingTransfer): Main Stock `stock_batches.qty` is in
STRIPS, Pharmacy in UNITS; `transfer_order_items.qty` is always in the source's native unit (strips for Main Stock,
fractional when the request was entered in units); `transfer_unit` ('strips'|'units', production CHECK) only records how
it was entered; `units_per_pack` is the line's snapshotted factor. Before this fix the desktop (old client and the first
version of the RPC) added the raw strip count to the pharmacy (5 strips at 10/pack -> +5 units instead of +50).
Now `accept_pharmacy_transfer` applies the Mobile rule through `vhc_transfer_dest_qty(qty, transfer_unit, units_per_pack)`:
* legacy line, both columns NULL -> pharmacy +qty (1:1, Mobile's explicit legacy passthrough);
* 'strips' or 'units' with units_per_pack > 0 -> pharmacy +qty x units_per_pack, Main Stock -qty strips;
* anything else -> `CONFLICT_TRANSFER_UNIT`, refused in Phase 1 before any write (whole transfer stays Pending).
Insufficient-stock is judged in strips; ledger OUT = -qty strips, IN = +converted units, both reasons carry
`[<unit> entered; <n>/pack conversion applied]` (Mobile's wording) when the factor is not 1. Locking, idempotency,
row-count/permission checks and movement keys are unchanged. The unit columns are read through `to_jsonb(line)`, so the
function also runs on TEST, whose `transfer_order_items` has no unit columns (every TEST line is therefore legacy 1:1).
The desktop request list now shows e.g. "5 strips × 10/strip = 50 units to Pharmacy", "(no unit recorded — added 1:1)",
or flags a line that will be refused.

## VHC Mobile coexistence
* Mobile today accepts with direct writes (status claim `.eq('status','Pending')`, then per-line batch CAS updates and
  ledger rows). The RPC takes the order row lock first; whichever commits first wins and the other sees it is no longer
  Pending, so a double accept is not possible. Movement keys cannot collide (Mobile writes none today; its prepared RPC
  uses `TRANSFER:OUT|IN:...`, the desktop `VHC:TRANSFER:...`). Both now convert units identically.
* Mobile's own path is still non-atomic (a mid-way failure leaves "Completed, some lines need checking").
* Mobile has a prepared, NOT applied migration `20261020000100_atomic_stock_transfers.sql` (accept/reject RPCs, audit
  columns, and a policy letting pharmacy writers update pharmacy-bound transfer orders). Applying it later would also
  let pharmacists accept through the desktop RPC. Review it separately.

## Production deployment sequence (when authorized)
0. Approvals; agree a short window with no stock edits, bill deletes or transfer accepts on any desktop or Mobile.
1. Confirm backups (Dashboard steps below) and take the logical pre-deployment export (list below), with checksums.
2. Read-only pre-check: ref `yrgtnhvnwkqudxdcrkhm`, the five functions absent, schema/RLS unchanged since this review.
3. Apply ONLY `20261022000100_stock_correction_rpcs.sql` (sha256 `a9abc36cffc36b0eca0e68f15eee4468ea9560a98aeac8d1aa9e4b286e3a4512`)
   in one transaction (see Migration history). Verify function bodies (md5 of prosrc as on TEST), SECURITY INVOKER,
   grants (authenticated + service_role, not anon), table checksums unchanged.
4. Release the desktop app containing this change (commit, version bump, build, sign) and install it on EVERY pharmacy
   desktop in the same window.
5. Watch the first real EDIT / RESTORE / TRANSFER rows: movement_key `VHC:EDIT|RESTORE|TRANSFER:...`, created_by set.
Old desktop clients keep working against the migrated database (they never call the functions) but keep the old
non-atomic direct writes, and a direct write can race an RPC on the same batch — hence step 4 in one window.

## Rollback
App: reinstall the previous build (its direct-write paths do not use these functions).
Rollback order: app first, then the functions (a new app without the functions refuses safely; an old app ignores them).
Database: `drop function public.accept_pharmacy_transfer(jsonb); drop function public.apply_stock_restore(jsonb);
drop function public.apply_stock_correction(jsonb); drop function public.vhc_manual_stock_reason_ok(text);
drop function public.vhc_transfer_dest_qty(numeric, text, numeric);`
Movements written through the functions are ordinary ledger rows and stay (never delete audit history).

## Migration history
Production has no `supabase_migrations` schema (history never initialised; changes were applied with the SQL editor /
ad-hoc SQL). TEST had none either until this migration was applied with the Supabase MCP `apply_migration`, which
created it with one row. The repository holds 7 migration files, including `20260926000100_vhc_safe_test_schema.sql`
(TEST-only schema). Never run `supabase db push` against production from this repository: with an empty history it
would try to replay every file, including the TEST-only schema.
Recommended: apply exactly this one file the same way as on TEST (MCP `apply_migration`, name
`20261022000100_stock_correction_rpcs`): one transaction, the full SQL stored in the history row, TEST/production
parity; a later CLI push would stop on the history mismatch instead of silently replaying. Before anyone adopts the
CLI, mark each older file as applied (`supabase migration repair --status applied <version>`) only after confirming its
objects really exist in production. Alternative: run the file in the SQL editor and record it in a deployment log.

## Backup readiness (verify before step 3; read-only)
Dashboard: supabase.com -> organisation -> project "VHC data Project" (ref yrgtnhvnwkqudxdcrkhm) -> Database ->
Backups. "Scheduled backups": confirm a completed backup within the last 24 h and note its time (daily backups need a
paid plan; Free shows none). "Point in Time": shows whether PITR is enabled and its window (Project Settings -> Add-ons).
Pre-deployment logical export (separately authorised; read-only):
* Data: stock_batches, stock_movements, transfer_orders, transfer_order_items, items, locations (everything this
  release can write); optional context: sales, sale_items (patient names — keep local, never share).
* Metadata: row count + md5 per table, max(seq) / identity state, column lists, `pg_policies` for these tables, the
  role functions (is_known_user, is_pharmacy_writer, is_warehouse_writer, current_role_name), definitions of all
  public functions, function grants and default ACLs, migration history (none).

## Tests (2026-10-22, round 2 — all local; TEST and production NOT modified)
Disposable localhost PostgreSQL 16, two schema shapes (`VHC_SCHEMA_SHAPE`):
| Suite | TEST shape | Production shape |
|---|---|---|
| `test/stock-correction-rpcs.pg.mjs` | 89 passed, 0 failed | 101 passed, 0 failed (incl. 12-check production role matrix, verbatim production RLS) |
| 8-session x 25-op stress (EDIT/RESTORE/BILL/TRANSFER mixed) | 200 ops, 0 errors, ledger continuous | 200 ops, 0 errors, ledger continuous (4 runs) |

Covered for TRANSFER: acceptance (2 lines, new batch created with production columns only), Rejected order ->
NOT_PENDING, duplicate accept -> ALREADY_COMPLETED, two concurrent accepts -> one APPLIED, insufficient stock ->
nothing moved, unknown id -> NOT_FOUND, permission denied (batch update, order update, new-batch insert, unreadable
order), injected failure on the last write -> full rollback then a clean re-accept, concurrent creation of the same new
batch -> one batch.
Production role matrix: pharmacist EDIT APPLIED; warehouse_manager EDIT APPLIED; viewer EDIT/RESTORE NOT_PERMITTED;
signed-in user without a profile -> not found (nothing disclosed); pharmacist / viewer transfer accept NOT_PERMITTED
(as today: only warehouse writers may update transfer_orders); pharmacist on a Completed transfer ALREADY_COMPLETED;
warehouse_manager transfer accept APPLIED; anon cannot execute.
Windows regression (stock-correction worktree, Electron-as-Node, no cloud target): 30 test files PASS, 0 FAIL, plus
`database.selftest` PASS. `stock-correction-client.test.cjs` 34/34; `stock-correction-rpcs.test.cjs` 12/12.
Round 3 (display fix): `test/stock-fractional-display.test.cjs` 8/8 — and 4/8 FAIL against the previous bundle
(negative control). Windows regression re-run: see the release-readiness report.

## Remaining risks
* Not yet run on the real TEST project (needs your authorization). TEST's RLS is permissive, so the permission matrix
  is only proven on the local production-shaped copy, not on a live database.
* Pharmacist-only accounts still cannot accept transfers (production policy, unchanged); they now see a clear
  "not allowed" message instead of "not found". Changing who may accept is a policy decision, not part of this fix.
* `delete_sale_and_restore` (production) can still restore stock for sale lines with affects_stock=true; today every
  cloud sale line is record-only, so it restores nothing. If that ever changes, a bill delete could restore twice.
* 15 historical bill+batch groups already have more than one un-keyed RESTORE row; the legacy check compares with the
  earliest. Historical rows are never modified.
* The app must ship after the migration (see Deployment); an app shipped first refuses these stock changes safely.
* Production has no global ledger lock (seq is identity); per-batch row locks keep each batch's ledger continuous
  (stress-tested), but seq order across different batches is allocation order, not commit order — same as today.
