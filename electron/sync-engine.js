// ─── Offline → Online synchronization engine (Phase 2D) ───
// Owns the network side of syncing local SQLite sales to Supabase: when to run, how to talk to
// Supabase, and how to classify a failure. Every SQLite read/write goes through
// electron/database.js's exported functions — this file never touches the database directly,
// and contains no billing/UI logic at all.
//
// Reuses the SAME Supabase project the rest of the app already talks to (see
// dist/assets/vhc-cloud-sync.js's SUPABASE_URL/SUPABASE_ANON_KEY — these are the publishable
// anon key already shipped in the renderer bundle, not a new credential) and the SAME
// authenticated session the renderer already has — there is no second authentication system
// here. The renderer relays its current Supabase access token via the existing
// 'supabase-session-token-changed' IPC channel (already wired for the embedded Telegram bot in
// electron/main.js); this module is simply a second consumer of that same relayed token.
//
// Reuses the actual, already-idempotent Supabase RPCs traced from
// supabase/migrations/20260819000200_pharmacy_billing_compatibility_patch1.sql:
//   - create_sale(payload): returns the EXISTING row if bill_id already exists — genuinely
//     idempotent, safe to call more than once for the same bill.
//   - delete_sale_and_restore(p_sale_id): NOT idempotent on its own (raises "Sale % not found"
//     if called twice) — this module treats that specific error as success (see
//     classifyRpcError), since it can only mean the first call already succeeded.
// Both RPCs do their own atomic, server-authoritative stock math — this module never uploads a
// local "closing stock" number, only ever asks the server to deduct/restore a quantity.

import { getNextSyncBatch, markSyncProcessing, markSyncSynced, markSyncRetry, markSyncNeedsReview, recoverStuckSyncItems, buildCreateSalePayload, getSaleServerId, buildCreateItemPayload, buildCreatePatientPayload } from './database.js';

const SUPABASE_URL = 'https://fjtgszdzbiepmdmnjsxn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_QG4Nk02c6MAXygDjhhApgg_5RA9V-vt';
const RPC_TIMEOUT_MS = 15000;
const CYCLE_INTERVAL_MS = 30000;
const BATCH_SIZE = 25;
// Per-item backoff after repeated failures: attempts*10s, capped at 5 minutes — keeps retrying
// without ever hammering Supabase for an item that just failed.
const BACKOFF_STEP_MS = 10000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;

let getAccessToken = () => null;
let timer = null;
let running = false; // reentrancy guard — a slow cycle must never overlap with the next tick
let lastCycleSummary = null;

function backoffEligible(row) {
  if (!row.attempts) return true;
  const delay = Math.min(row.attempts * BACKOFF_STEP_MS, BACKOFF_CAP_MS);
  return Date.now() - new Date(row.updated_at).getTime() >= delay;
}

async function callRpc(fnName, body, accessToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty body, e.g. delete_sale_and_restore returns void */ }
    return { httpStatus: res.status, ok: res.ok, body: json };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Plain PostgREST table access (items/patients have no bespoke RPC — a plain insert/select
 *  under RLS is the existing, already-used pattern, same as resolveItemId/upsertPatientFromOPD
 *  in cloud-src/vhc-cloud-sync.js). Always requests the representation back so the caller gets
 *  the created/matched row's real id in one round trip. */
async function callRest(method, table, { query = '', body, extraHeaders = {} } = {}, accessToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'return=representation',
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { httpStatus: res.status, ok: res.ok, body: json };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Decides what a failed RPC call actually means. Returns one of:
 *   { kind: 'retry', message }     — transient (network/DNS/timeout/auth) — stays pending
 *   { kind: 'needs_review', message } — a real conflict/limitation — stops auto-retry
 *   { kind: 'treat_as_success' }   — e.g. delete_sale_and_restore's "already gone" case
 */
function classifyFailure(operation, err, httpResult) {
  if (err) {
    // fetch() itself threw — no internet, DNS failure, or our own timeout abort. All of these
    // are exactly the "internet unavailable" case this whole engine exists to survive.
    if (err.name === 'AbortError') return { kind: 'retry', message: 'Supabase request timed out' };
    return { kind: 'retry', message: `Network error: ${err.message}` };
  }
  const message = (httpResult.body && (httpResult.body.message || httpResult.body.error)) || `HTTP ${httpResult.httpStatus}`;
  if (operation === 'cancel' && /sale .* not found/i.test(message)) {
    // delete_sale_and_restore's only non-idempotent failure mode — it can only mean a PRIOR
    // call already deleted this sale (response lost, we retried) — not a real error.
    return { kind: 'treat_as_success' };
  }
  if (httpResult.httpStatus === 401 || /jwt|token|not authorized|jwsError/i.test(message)) {
    // Session expired or not yet signed in. Per the explicit requirement: never destroy pending
    // data over an auth problem — keep retrying; it resolves itself once the user is signed in
    // again and a fresh token is relayed.
    return { kind: 'retry', message: `Authentication error: ${message}` };
  }
  if (/insufficient stock/i.test(message)) {
    // A genuine multi-computer stock conflict — the server's own atomic deduction couldn't be
    // fulfilled. Blind retry cannot fix this; it needs a human to look at the bill.
    return { kind: 'needs_review', message: `Remote stock conflict: ${message}` };
  }
  if (/row-level security|permission denied/i.test(message)) {
    // A role/permission problem (e.g. items_write_warehouse requiring admin/warehouse_manager —
    // see processItemCreate's comment) — unlike an expired JWT, retrying with the SAME account
    // can never fix this; it needs a human to either grant the right role or accept the item
    // stays local-only. Never touches the local record either way.
    return { kind: 'needs_review', message: `Permission denied: ${message}` };
  }
  // Anything else is unexplained — err on the side of NOT hammering Supabase forever with an
  // unknown, possibly-permanent error, while still never touching the local sale itself.
  return { kind: 'needs_review', message };
}

async function processCreate(row, accessToken) {
  const built = buildCreateSalePayload(row.entity_id);
  if (!built.ok) {
    // Phase 2E: a dependency (an offline-created item, see buildCreateSalePayload) is still in
    // flight — this is not a failure of THIS sale, just not its turn yet. Stays pending/retries
    // on the normal cadence rather than being marked needs_review.
    if (built.waiting) {
      markSyncRetry(row.id, built.reason);
      return { id: row.id, outcome: 'retry', reason: built.reason };
    }
    markSyncNeedsReview(row.id, built.reason);
    return { id: row.id, outcome: 'needs_review', reason: built.reason };
  }
  try {
    const result = await callRpc('create_sale', { payload: built.payload }, accessToken);
    if (result.ok) {
      const serverId = result.body && result.body.id;
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', serverId };
    }
    const verdict = classifyFailure('create', null, result);
    if (verdict.kind === 'needs_review') markSyncNeedsReview(row.id, verdict.message);
    else markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: verdict.kind, reason: verdict.message };
  } catch (err) {
    const verdict = classifyFailure('create', err, null);
    markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: 'retry', reason: verdict.message };
  }
}

async function processCancel(row, accessToken) {
  const serverId = getSaleServerId(row.entity_id);
  if (!serverId) {
    // Its 'create' hasn't produced a server_id yet — depends_on should have prevented this row
    // from being selected at all (see getNextSyncBatch); this is a defensive fallback only.
    markSyncRetry(row.id, 'Waiting for this sale’s create operation to sync first');
    return { id: row.id, outcome: 'retry', reason: 'waiting on dependency' };
  }
  try {
    const result = await callRpc('delete_sale_and_restore', { p_sale_id: serverId }, accessToken);
    if (result.ok) {
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', serverId };
    }
    const verdict = classifyFailure('cancel', null, result);
    if (verdict.kind === 'treat_as_success') {
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', reason: 'already deleted remotely' };
    }
    if (verdict.kind === 'needs_review') markSyncNeedsReview(row.id, verdict.message);
    else markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: verdict.kind, reason: verdict.message };
  } catch (err) {
    const verdict = classifyFailure('cancel', err, null);
    markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: 'retry', reason: verdict.message };
  }
}

/**
 * Item sync (Phase 2E). IMPORTANT — traced from the real schema before writing this: `items`
 * has NO unique constraint at all (see database.js's buildCreateItemPayload comment) AND its
 * RLS policy ('items_write_warehouse') only permits 'admin'/'warehouse_manager' roles — a plain
 * pharmacist-role user's insert will be rejected regardless of this code's correctness (a
 * pre-existing schema/role characteristic this phase inherits, not causes; see the report). So:
 * (1) a best-effort SELECT-by-name check before inserting reduces but does not eliminate
 * duplicate risk (a genuine race between two computers is not fully closed — disclosed, not
 * hidden); (2) an RLS rejection is classified as needs_review (see classifyFailure) — a role
 * problem never resolves by retrying with the same account, so this surfaces clearly for a
 * human to fix (assign the right Supabase role) rather than retrying forever.
 */
async function processItemCreate(row, accessToken) {
  const built = buildCreateItemPayload(row.entity_id);
  if (!built.ok) {
    markSyncNeedsReview(row.id, built.reason);
    return { id: row.id, outcome: 'needs_review', reason: built.reason };
  }
  try {
    const existing = await callRest('GET', 'items', { query: `?name=ilike.${encodeURIComponent(built.payload.name)}&select=id&limit=1` }, accessToken);
    if (existing.ok && Array.isArray(existing.body) && existing.body.length > 0) {
      const serverId = existing.body[0].id;
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', serverId, reason: 'matched an existing remote item by name' };
    }
    const created = await callRest('POST', 'items', { body: built.payload }, accessToken);
    if (created.ok) {
      const serverId = Array.isArray(created.body) ? created.body[0].id : created.body && created.body.id;
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', serverId };
    }
    const verdict = classifyFailure('item', null, created);
    if (verdict.kind === 'needs_review') markSyncNeedsReview(row.id, verdict.message);
    else markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: verdict.kind, reason: verdict.message };
  } catch (err) {
    const verdict = classifyFailure('item', err, null);
    markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: 'retry', reason: verdict.message };
  }
}

/**
 * Patient sync (Phase 2E). Unlike items, this table's RLS ('patients_write_pharmacy') already
 * permits the normal pharmacist role, and a real partial unique index on legacy_patient_id
 * (traced from supabase/migrations/20260819000100_pharmacy_billing_compatibility.sql) gives a
 * genuine, safe idempotency guarantee: sending this local patient's own id as legacy_patient_id
 * means a retried insert is rejected by Postgres itself (a 409 conflict), not duplicated — at
 * that point a follow-up SELECT by legacy_patient_id reliably finds the real row.
 */
async function processPatientCreate(row, accessToken) {
  const built = buildCreatePatientPayload(row.entity_id);
  if (!built.ok) {
    markSyncNeedsReview(row.id, built.reason);
    return { id: row.id, outcome: 'needs_review', reason: built.reason };
  }
  try {
    const created = await callRest('POST', 'patients', { body: built.payload }, accessToken);
    if (created.ok) {
      const serverId = Array.isArray(created.body) ? created.body[0].id : created.body && created.body.id;
      markSyncSynced(row.id, serverId);
      return { id: row.id, outcome: 'synced', serverId };
    }
    // A 409/unique-violation on legacy_patient_id can only mean OUR OWN prior attempt already
    // succeeded (this id is never reused for a different local patient) — a lost-response retry,
    // not a real conflict. Resolve it by fetching the row that already exists.
    const message = (created.body && (created.body.message || created.body.error)) || `HTTP ${created.httpStatus}`;
    if (created.httpStatus === 409 || /duplicate key|already exists/i.test(message)) {
      const existing = await callRest('GET', 'patients', { query: `?legacy_patient_id=eq.${encodeURIComponent(built.payload.legacy_patient_id)}&select=id&limit=1` }, accessToken);
      if (existing.ok && Array.isArray(existing.body) && existing.body.length > 0) {
        const serverId = existing.body[0].id;
        markSyncSynced(row.id, serverId);
        return { id: row.id, outcome: 'synced', serverId, reason: 'resolved via legacy_patient_id after a lost-response retry' };
      }
    }
    const verdict = classifyFailure('patient', null, created);
    if (verdict.kind === 'needs_review') markSyncNeedsReview(row.id, verdict.message);
    else markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: verdict.kind, reason: verdict.message };
  } catch (err) {
    const verdict = classifyFailure('patient', err, null);
    markSyncRetry(row.id, verdict.message);
    return { id: row.id, outcome: 'retry', reason: verdict.message };
  }
}

/**
 * Runs one sync pass: recovers crash-interrupted rows, then processes whatever is eligible.
 * Never throws — every per-row failure is caught and recorded on that row alone, so one bad
 * record can never stop the rest of the batch (or a future cycle) from proceeding. Safe to call
 * concurrently with itself (the `running` guard below just skips an overlapping call rather than
 * queuing it — the next timer tick will pick up whatever is still pending).
 */
export async function runSyncCycle() {
  if (running) return { skipped: true, reason: 'A sync cycle is already in progress' };
  running = true;
  try {
    recoverStuckSyncItems();
    const accessToken = getAccessToken();
    if (!accessToken) {
      lastCycleSummary = { at: new Date().toISOString(), processed: 0, note: 'No authenticated session available yet' };
      return lastCycleSummary;
    }

    const candidates = getNextSyncBatch(BATCH_SIZE * 3).filter(backoffEligible).slice(0, BATCH_SIZE);
    const results = [];
    for (const row of candidates) {
      markSyncProcessing(row.id);
      let outcome;
      if (row.entity_type === 'item') outcome = await processItemCreate(row, accessToken);
      else if (row.entity_type === 'patient') outcome = await processPatientCreate(row, accessToken);
      else if (row.operation === 'cancel') outcome = await processCancel(row, accessToken);
      else outcome = await processCreate(row, accessToken);
      results.push(outcome);
    }
    lastCycleSummary = { at: new Date().toISOString(), processed: results.length, results };
    return lastCycleSummary;
  } finally {
    running = false;
  }
}

/**
 * Starts the background timer. Must be called once at app startup. `getAccessTokenFn` is a
 * closure over whatever electron/main.js already tracks as the current relayed session token
 * (the same variable the Telegram bot relay already reads) — passed in rather than imported so
 * this module never needs to know how that token is obtained, only how to ask for the current
 * value at the moment it's needed.
 */
/** Exported separately from startSyncEngine so tests can drive runSyncCycle() directly with a
 *  scripted token, without also starting the real background timer. */
export function setAccessTokenGetter(getAccessTokenFn) {
  getAccessToken = getAccessTokenFn || (() => null);
}

export function startSyncEngine(getAccessTokenFn) {
  setAccessTokenGetter(getAccessTokenFn);
  if (timer) return;
  // Fire once shortly after startup (lets the app finish opening first — sync is explicitly
  // non-blocking and must never compete with initial UI responsiveness), then on a fixed
  // interval. A fixed interval (rather than a tighter per-item backoff timer) is the "reasonable
  // backoff, don't hammer Supabase" mechanism at the cycle level; per-item backoff (above)
  // handles repeatedly-failing individual records within that cadence.
  setTimeout(() => { runSyncCycle().catch(() => {}); }, 5000);
  timer = setInterval(() => { runSyncCycle().catch(() => {}); }, CYCLE_INTERVAL_MS);
}

export function stopSyncEngine() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Manual trigger — used right after a new local sale (best-effort, non-blocking "try now"
 *  instead of waiting for the next timer tick) and by tests. Never awaited by its caller in
 *  production code, exactly like the existing cloud record-only mirror call it sits alongside. */
export function triggerSyncNow() {
  return runSyncCycle();
}

export function getLastCycleSummary() {
  return lastCycleSummary;
}
