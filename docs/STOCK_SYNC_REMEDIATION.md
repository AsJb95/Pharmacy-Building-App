# Stock-sync incident remediation ("Online • 45 Need Review")

Working copy: `C:\New VHC\VHC Pharmacy\.feature-worktrees\stock-sync-fix` — a plain copy of the v3.19.6
stock-correction worktree (`fix/stock-correction`, uncommitted) plus this change. NOT a git worktree, NOT committed,
NOT built, NOT deployed. `20261023000100` was applied to TEST only (2026-10-23, approved); NOT on Production.
The follow-up `20261023000200_restore_bill_stock_patient_fix.sql` (T7, below) is prepared only: NOT on TEST or Production.

## Root cause (read-only investigation, 2026-10-22)
1. Bill stock was deducted one line per call (`apply_bill_stock_movement`). The worker stopped at the first refused
   line: earlier lines stayed deducted, later lines were never tried, and the bill was parked in `STOCK_CONFLICT`
   (never retried, no way to resolve it). 45 bills on 21–22 Oct are missing or partly deducted in the cloud.
2. Refusals were mostly batches deleted / re-created (`CONFLICT_BATCH_NOT_FOUND`) or too little cloud stock
   (`CONFLICT_INSUFFICIENT_STOCK`).
3. The inventory overlay replaced a batch's cloud quantity with the frozen closing quantity of every unconfirmed bill
   — including review items, forever — so the shown stock stopped following the cloud. Staff then deleted and
   re-created batches, which broke more pending bills (feedback loop).
4. Batch create wrote no ledger row; batch delete was a plain DELETE (no ledger row, no reference check).
5. Bill delete restored the bill's LINE quantities matched by name (fuzzy fallback, `parseInt`), whether or not they
   had ever been deducted; `delete_sale_and_restore` restores nothing for these bills (cloud lines carry
   `affects_stock = false`).
6. BILL movements recorded no acting user.

## What changed
### Database — `supabase/migrations/20261023000100_stock_sync_remediation.sql` (prepared, not applied)
Requires `20261022000100_stock_correction_rpcs.sql` (v3.19.6) first. One transaction. No table/column/policy change,
no data change; historical movements are never rewritten.
| Object | Behaviour |
|---|---|
| `apply_bill_stock_movements(jsonb)` | All BILL lines of one bill in one transaction. Phase 1 resolves batches, then locks them (fixed order), phase 2 checks idempotency per original key and the AGGREGATED stock per batch, and only if every line is fine phase 3 writes. Any refused line → `CONFLICT` with per-line reasons and nothing written. Keys must be `VHC:BILL:<bill_id>:…` (no cross-bill keys). A partly applied bill (older app) gets only its missing lines. `allow_identity_fallback` (apply a line whose batch was deleted to the current batch with the same item + location + batch number) is admin-only and recorded in the movement reason. `created_by = auth.uid()`. Per-bill advisory lock. SECURITY INVOKER. |
| `restore_bill_stock(jsonb)` | Bill delete: restores exactly the recorded BILL movements of the bill, once each (`VHC:BILL-RESTORE:<bill>:<original key or id>`), into the batch they came from; writes `VHC:BILL-DELETED:<bill>` so the bill can never be deducted afterwards. Refuses (nothing written) when the bill has returns, was restored by an older path, or a batch is missing/ambiguous. Never invents a batch. Reason required. |
| `create_stock_batch(jsonb)` | Batch + `RECEIVE` opening movement (0 → opening qty, actor, reason) in one transaction; duplicate item + location + batch number → `CONFLICT_BATCH_EXISTS`; idempotent per request key. |
| `delete_stock_batch(jsonb)` | Only an EMPTY batch with no stock history (other than its own opening row) can be deleted; the deletion is recorded (`ADJUST` 0, actor, reason). A batch with history is kept at zero (closed) so bills still syncing from any counter find it. |
| `apply_bill_stock_movement(jsonb)` (legacy, older apps) | Same contract; now records `created_by` and refuses a deleted bill. Keeps SECURITY DEFINER. |
| `stock_batches_identity_uq` | Unique `(item_id, location_id, lower(btrim(coalesce(batch_no,''))))`. The migration aborts (nothing applied) if duplicates exist — 0 in Production on 2026-10-22. |
Grants: EXECUTE revoked from PUBLIC/anon, granted to authenticated + service_role (Supabase's default ACL would
otherwise give anon EXECUTE).

### App
* Sync worker (`dist/assets/vhc-audit-engine.js`): one atomic call per bill; read-back of every key before
  confirming; exact per-line reasons stored in `last_error`. Falls back to the older single-line path only while
  the server function is missing (pre-deployment compatibility).
* Review workflow: badge click opens "Bills needing stock review" with the exact reason per bill and per line.
  * Retry stock — re-applies only missing deductions with the original keys; all-or-nothing; cleared only after
    the cloud read-back.
  * Apply to current batch (admin, server-verified) — for a deleted batch.
  * Close with reason (admin, ≥10 characters) — `REVIEW_ACKNOWLEDGED`, no stock write; reason/user/time kept.
  * A bill deleted on the counter, or a `SALE_MISMATCH`, is never stock-retried.
* Overlay: only still-pending deductions, as a delta on the live cloud quantity. Review items never freeze stock.
* Local DB (`electron/database.js`): migration 6 adds `review_resolution`, `review_resolved_at`, `review_resolved_by`;
  new `getFinancialSyncReviewItems`, `markFinancialSyncReviewResolved`, `markFinancialSyncReviewAcknowledged`,
  `getStockBatchReferences`; deleting a bill also cancels a still-pending stock step.
* Batches: add → `create_stock_batch`; delete → refused while any pending/review bill on this counter uses the
  batch (fails closed if that cannot be checked), then `delete_stock_batch`. Refusals are shown to the user.
* Bill delete: local sale cancelled first, then `restore_bill_stock`; the old line-based restore runs only when
  the server function is missing.

## T7 fix — bill delete vs the cloud patients FK (2026-10-23, prepared only)
TEST desktop run 3, test T7 (FAIL): deleting a bill called `restore_bill_stock` with `patient_id` = the counter's
LOCAL SQLite patient id (`billRecord.patientId`, from `handleDeleteBill` in `index-doBKNLAj.js`). It is not a cloud
`patients.id`, so the RESTORE insert violated `stock_movements_patient_id_fkey` (`FOREIGN KEY (patient_id) REFERENCES
patients(id)`, TEST and Production) → HTTP 409, nothing restored, no BILL-DELETED marker. The app then still deleted
the bill locally and soft-deleted the cloud sale, leaving its deductions in place.
* Server — `20261023000200_restore_bill_stock_patient_fix.sql` replaces only `restore_bill_stock`: the payload
  patient id is ignored; each RESTORE row carries the patient recorded on the deduction it reverses (FK-valid by
  construction). A constraint failure in the write phase returns `CONFLICT` / `CONFLICT_RESTORE_WRITE_FAILED`
  (+ SQLSTATE) with every write rolled back, instead of an HTTP error. Everything else unchanged.
* Cloud wrapper (`cloud-src` + dist mirror): `restoreBillStock` sends no patient id.
* Bill delete (`handleDeleteBill`): the cloud restore must succeed (`APPLIED` / `ALREADY_APPLIED` /
  `NOTHING_TO_RESTORE`) before anything is deleted. Any other result (error/offline, refusal, empty reply, sync busy)
  → the bill is NOT removed: no local cancel, no local stock change, no history change, no cloud soft delete; the
  user sees why and the refusal is audited (`BILL_DELETE_REFUSED`). The restore + local cancel run inside
  `VHC_FINANCIAL_SYNC.runExclusiveOfFinancialSync` (new, `vhc-audit-engine.js`) so no sync run can upload or deduct
  the bill mid-delete. Pre-deployment fallback (server function missing) unchanged.
* Messages (2026-10-23, after TEST run 4): no usable reply (lost / timed out / empty) → "NOT removed on this counter … the
  cloud result is UNKNOWN … remove the bill again when online; the retry restores each item at most once" (never
  "nothing changed"). A definite server refusal (or a call never sent: sync busy) still says nothing was changed. A retry
  that finds the restore already done → "Its stock had already been restored … no additional stock was added";
  NOTHING_TO_RESTORE → "no cloud stock had been deducted, so no stock was added"; partly done earlier → only the new
  units are counted and the rest are "not added again". Deletion rules unchanged.
* Unchanged guarantees: once-only restore keys (retries restore nothing twice), per-bill advisory lock, BILL-DELETED
  marker blocks any later deduction (bulk and legacy).
* Behaviour change: a bill can no longer be deleted while the counter is offline (previously deleted locally with a
  warning). Decide before Production.

## Inventory display: cloud corrected, desktop shows 0 / old stock (2026-10-24)
* Shipped builds (v3.19.5 `unpacked_app`, v3.19.6 stock-correction base): `getPendingStockOverlays()` returns every
  bill not `CLOUD_CONFIRMED`/`CANCELLED` (incl. `STOCK_CONFLICT` review bills, never retried) and the inventory loader
  `l()` REPLACES the cloud quantity with that bill's frozen `closing`. Any later cloud change to the batch is hidden;
  a bill that emptied the batch pins it at 0. Display defect (cloud data and the inventory query are correct).
  Already fixed above (retryable bills only, delta on live cloud quantity).
* Remaining in the loader, fixed now (`index-doBKNLAj.js`, provider `l()`): (1) a pending bill whose deduction is
  already in the cloud (reply lost) was subtracted again → checked by its key `VHC:BILL:<bill>:<local movement id>`
  (chunks of 80; on lookup failure the deduction stays applied — shows less, never more, never zero); (2) pending
  overlays are read before the cloud quantities; (3) only the newest load may set the screen (an older, slower
  response is dropped); the load uses its own fetch result, not the shared cache. A failed load keeps the last
  good inventory. Tests 4c–4f.
* Startup (shipped builds too): realtime — the only trigger that refreshes the screens when the cloud changes — is
  started only at the end of `init()`, and `init()` ran once at app start: any failure (a fetch, the location lookup,
  a token refresh) was only logged ("retry via reload"), and `init()` returned SILENTLY when no session was available.
  The session then had no realtime: cloud changes made elsewhere never reached the screen until a restart. Fixed:
  `init()` reports a missing session, starts realtime even if one initial fetch fails (then reports it; the local
  auto-recovery runs only after a successful inventory read), and the startup gate retries `init()` (15 s, 30 s, 60 s,
  then every 2 min) until it succeeds, then reloads inventory and patients once; retries stop on sign-out. Tests 7a–7c.
  Not covered: an app started in OFFLINE mode (no cloud at launch) still calls `init()` only after a restart/sign-in.

## Known limits / to decide before Production
* Other counters: the batch-reference check is per counter (local bills). The server rule "history ⇒ never deleted"
  protects every counter's bills.
* A bill deleted while the cloud is unreachable is not restored later automatically (unchanged): the user is
  warned to correct the batch.
* Unique index side effects: VHC Mobile `addMainItem` / `addPharmacyItem` / purchase receive insert batches
  directly; a duplicate item + batch number will now be refused with an error instead of creating a second batch.
  Mobile's non-atomic transfer accept could stop mid-way on such an error (existing Mobile issue). The v3.19.6
  `accept_pharmacy_transfer` matches the destination batch by exact batch number; a case/space variant of an
  existing batch would make that accept fail and roll back (no partial write). Review with the Mobile owner.
* The 45 bills are NOT repaired by this change; after deployment they appear in the review list and are resolved
  one by one (retry / apply to current batch / close with reason), after a physical count.

## Anonymous read access (investigated only — no permission changed)
Production has `stock_batches_select_anon` and `items_select_anon` (SELECT `true` for role anon). With the
publishable key (embedded in the desktop app and the Telegram bot, i.e. public) anyone can read every batch
(quantities, MRP, net rate, stockist) and item. No patient data. No code path found that needs it: the desktop app
reads inventory only after sign-in; the Telegram bot does not query `stock_batches`. VHC Mobile reads after sign-in
(not exhaustively verified). Recommendation (separate, approved change): drop both anon policies after confirming no
unauthenticated consumer, e.g. `drop policy stock_batches_select_anon on public.stock_batches; drop policy
items_select_anon on public.items;` — test on TEST first.

## Tests
* `test/stock-sync-remediation.pg.mjs` — real PostgreSQL, disposable localhost DB only; production and TEST
  role shapes; includes the cloud `patients` table and `stock_movements_patient_id_fkey` (T7 regression T7.0–T7.8:
  reproduces the failure on the old body, then proves the fix, retries, late sync, failed-restore rollback).
* `test/stock-sync-remediation.test.cjs` — real worker + real SQLite layer + both cloud copies + real UI code.
* `electron/database.selftest.js` — V1 expects local migration 6; Y9 now asserts that a conflicted bill does NOT
  overlay stock (the old assertion encoded the freeze bug).

## Rollback
App first (reinstall the previous build), then:
`drop function public.apply_bill_stock_movements(jsonb); drop function public.restore_bill_stock(jsonb);
drop function public.create_stock_batch(jsonb); drop function public.delete_stock_batch(jsonb);
drop index public.stock_batches_identity_uq;` and re-create `apply_bill_stock_movement` from
`20261015000100_v3193_apply_bill_stock_movement.sql`. (T7 follow-up alone: re-run section 2 of `20261023000100`.) Ledger rows written by these functions stay (audit history).
Local migration 6 only adds nullable columns; older builds ignore them.
