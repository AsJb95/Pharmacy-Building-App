// VHC_CLOUD — Pharmacy POS's Supabase data layer. Loaded as a plain <script>
// sibling to the React bundle (same integration pattern as vhc-audit-engine.js
// and auto-sync-engine.js): exposes window.VHC_CLOUD and fires
// 'vhc-cloud-change' CustomEvents so the React bundle can react to Realtime
// updates without importing anything.
//
// Mirrors the proven patterns already used by the Warehouse app's
// WarehouseContext.jsx (same Supabase project): fetch-into-memory-cache,
// resolveItemId-style catalog dedup, a read-only localStorage fallback cache
// so the app doesn't go blank on a brief network drop, and a per-action
// try/catch that reports errors instead of throwing into the UI.
import { createClient } from '@supabase/supabase-js';

const PRODUCTION_SUPABASE_URL = 'https://yrgtnhvnwkqudxdcrkhm.supabase.co';
const PRODUCTION_SUPABASE_ANON_KEY = 'sb_publishable_7fL9ZcI18hC1XiMqeCLhlg_YXNzABAC';
function resolveSupabaseRuntimeConfig() {
  const runtime = window.electronAPI && window.electronAPI.getSupabaseRuntimeConfig
    ? window.electronAPI.getSupabaseRuntimeConfig()
    : null;
  const environmentName = (runtime && runtime.environmentName) || 'PRODUCTION';
  const isTest = environmentName === 'TEST';
  const supabaseUrl = runtime ? runtime.supabaseUrl : PRODUCTION_SUPABASE_URL;
  const supabaseAnonKey = runtime ? runtime.supabaseAnonKey : PRODUCTION_SUPABASE_ANON_KEY;
  const isProductionUrl = String(supabaseUrl).replace(/\/+$/, '') === PRODUCTION_SUPABASE_URL.replace(/\/+$/, '');
  const missing = !supabaseUrl || !supabaseAnonKey;
  const disabledReason = (runtime && runtime.disabledReason) ||
    (environmentName === 'TEST' && missing ? 'SAFE CLOUD TEST TARGET REQUIRED' : '') ||
    (environmentName === 'TEST' && isProductionUrl ? 'PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING' : '');
  return {
    environmentName,
    supabaseUrl,
    supabaseAnonKey,
    isProductionUrl,
    cloudWritesAllowed: runtime && typeof runtime.cloudWritesAllowed === 'boolean'
      ? runtime.cloudWritesAllowed
      : !isTest && !missing,
    disabledReason,
  };
}

const CLOUD_CONFIG = resolveSupabaseRuntimeConfig();
const SUPABASE_URL = CLOUD_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = CLOUD_CONFIG.supabaseAnonKey;
const PHARMACY_LOCATION_NAME = 'VHC Pharmacy Counter';

// A deliberately unroutable client prevents TEST mode from ever falling back to
// production while still allowing this plain-script module to initialise.
const CLIENT_URL = SUPABASE_URL || 'https://vhc-test-target-required.invalid';
const CLIENT_KEY = SUPABASE_ANON_KEY || 'safe-test-target-required';
const supabase = createClient(CLIENT_URL, CLIENT_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

let offlineAuthMode = false;
let offlineAuthTransportFailure = false;

function projectHost() {
  try { return new URL(SUPABASE_URL).hostname.toLowerCase(); } catch (e) { return ''; }
}

function setOfflineAuthMode(enabled, identity = null, transportFailure = false) {
  offlineAuthMode = enabled === true;
  offlineAuthTransportFailure = offlineAuthMode && transportFailure === true;
  try {
    window.dispatchEvent(new CustomEvent('vhc-offline-auth-mode', {
      detail: { enabled: offlineAuthMode, identity: offlineAuthMode ? identity : null },
    }));
  } catch (e) {}
}

function isTransportFailure(error) {
  return !!(window.VHC_RUNTIME_POLICY && window.VHC_RUNTIME_POLICY.isTransportFailure(error));
}

async function recordVerifiedOfflineIdentity(user) {
  if (!user || !user.id || !user.email || !window.electronAPI?.recordOfflineAuthIdentity) return;
  try {
    await window.electronAPI.recordOfflineAuthIdentity({
      onlineConfirmed: true,
      userId: String(user.id),
      email: String(user.email),
      projectHost: projectHost(),
      confirmedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[VHC_AUTH] Could not persist offline identity metadata:', error?.message || error);
  }
}

async function readOfflineIdentity() {
  try {
    return window.electronAPI?.getOfflineAuthIdentity
      ? await window.electronAPI.getOfflineAuthIdentity()
      : null;
  } catch (e) {
    return null;
  }
}

async function probeCloudTransport(timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { error } = await supabase.from('sales').select('id').limit(1).abortSignal(controller.signal);
    if (error) throw error;
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Supabase auth bootstrap probe timed out after ${timeoutMs}ms`);
      timeoutError.code = 'REACHABILITY_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertCloudWritesAllowed(actionName) {
  if (offlineAuthMode) throw new Error(`Cloud write blocked in offline-auth mode (${actionName}).`);
  if (!CLOUD_CONFIG.cloudWritesAllowed) {
    throw new Error(CLOUD_CONFIG.disabledReason || 'SAFE CLOUD TEST TARGET REQUIRED');
  }
  if (CLOUD_CONFIG.environmentName === 'TEST' && CLOUD_CONFIG.isProductionUrl) {
    throw new Error('PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING');
  }
  return true;
}

function installEnvironmentIndicator() {
  if (CLOUD_CONFIG.environmentName !== 'TEST' || !document || document.getElementById('vhc-test-env-indicator')) return;
  const div = document.createElement('div');
  div.id = 'vhc-test-env-indicator';
  div.textContent = `Environment: TEST${CLOUD_CONFIG.disabledReason ? ' - cloud writes disabled' : ''}`;
  div.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:999999;background:#facc15;color:#111827;border:2px solid #92400e;border-radius:6px;padding:7px 10px;font:700 12px system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);pointer-events:none;';
  document.body.appendChild(div);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installEnvironmentIndicator, { once: true });
} else {
  installEnvironmentIndicator();
}

// The app stores expiry as free-text "MM/YY" (see parseExpiryToDate in the
// React bundle), but stock_batches.expiry_date is a real Postgres `date`
// column — "12/27" is not a valid date literal and every insert/update
// carrying it as-is is rejected outright. Mirrors parseExpiryToDate's own
// "last day of that month" convention so cloud data reads the same as the
// app's local expiry-alert logic already does.
function toISODateString(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expiryToISODate(expiryStr) {
  if (!expiryStr) return null;
  const s = String(expiryStr).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let month = parseInt(m[1], 10);
    let year = parseInt(m[2], 10);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12) {
      // Last day of that month — .getDate() reads the local calendar day
      // number, not a UTC-shifted instant, so this is timezone-safe (unlike
      // toISOString(), which can roll the date back a day depending on the
      // machine's UTC offset).
      const lastDayNum = new Date(year, month, 0).getDate();
      return toISODateString(year, month, lastDayNum);
    }
    return null;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return toISODateString(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function emit(table, type, row) {
  window.dispatchEvent(new CustomEvent('vhc-cloud-change', { detail: { table, type, row } }));
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`vhc_cloud_cache_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  try {
    localStorage.setItem(`vhc_cloud_cache_${key}`, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function withErrorReport(fn) {
  return async (...args) => {
    try {
      if (CLOUD_WRITE_FUNCTIONS.has(fn.name)) assertCloudWritesAllowed(fn.name);
      return await fn(...args);
    } catch (e) {
      const details = describeCloudError(e);
      console.error(`[VHC_CLOUD] action failed (${fn.name || 'anonymous'}):`, details, e);
      return { error: details.message, ...details };
    }
  };
}

function describeCloudError(error) {
  return {
    code: error && error.code ? String(error.code) : null,
    message: error && error.message ? String(error.message) : String(error),
    details: error && error.details ? String(error.details) : null,
    hint: error && error.hint ? String(error.hint) : null,
  };
}

const CLOUD_WRITE_FUNCTIONS = new Set([
  'addInventoryItem', 'addInventoryItemsBulk', 'restoreInventoryFromBackup',
  'updateInventoryItem', 'adjustStockBulk', 'deleteInventoryItem',
  'clearInventoryData', 'factoryReset', 'upsertPatientFromOPD',
  'restorePatientsFromBackup', 'addManualPatient', 'mergeManualPatientInto',
  'createSale', 'deleteSale', 'deleteSaleByBillId', 'restoreSaleHistory',
  'updateAlertsConfig', 'acceptPharmacyTransfer', 'rejectPharmacyTransfer',
]);

// ============================================================
// Auth
// ============================================================

let currentSession = null;

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  currentSession = data.session;
  setOfflineAuthMode(false);
  await recordVerifiedOfflineIdentity(data.session?.user);
  return data.session;
}

async function getSession() {
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  return data.session;
}

async function getAuthBootstrap() {
  let session = null;
  let authError = null;
  try {
    const result = await supabase.auth.getSession();
    session = result?.data?.session || null;
    authError = result?.error || null;
    currentSession = session;
  } catch (error) {
    authError = error;
  }

  let verificationError = null;
  if (session && !authError) {
    try {
      const verified = await supabase.auth.getUser();
      verificationError = verified?.error || null;
      if (!verificationError && verified?.data?.user?.id === session.user?.id) {
        currentSession = session;
        setOfflineAuthMode(false);
        await recordVerifiedOfflineIdentity(verified.data.user);
        return { session, mode: 'online' };
      }
      if (!verificationError) verificationError = Object.assign(new Error('Authenticated user did not match cached session'), { code: 'AUTH_IDENTITY_MISMATCH' });
    } catch (error) {
      verificationError = error;
    }
  }

  const error = verificationError || authError;
  const offlineIdentity = await readOfflineIdentity();
  let bootstrapError = error;
  if (!session && !bootstrapError && offlineIdentity && offlineIdentity.projectHost === projectHost()) {
    try {
      await probeCloudTransport();
    } catch (probeError) {
      bootstrapError = probeError;
    }
  }
  const policy = window.VHC_RUNTIME_POLICY;
  const decision = policy
    ? policy.decideAuthBootstrap({ session: null, authError: bootstrapError, offlineIdentity, projectHost: projectHost() })
    : { mode: 'signin' };
  if (decision.mode === 'offline') {
    currentSession = null;
    setOfflineAuthMode(true, decision.identity, true);
    return { session: null, mode: 'offline', offlineIdentity: decision.identity };
  }

  currentSession = null;
  setOfflineAuthMode(false);
  if (bootstrapError && !isTransportFailure(bootstrapError) && bootstrapError.status && [401, 403].includes(Number(bootstrapError.status))) {
    try { await supabase.auth.signOut({ scope: 'local' }); } catch (e) {}
    try { await window.electronAPI?.clearOfflineAuthIdentity?.(); } catch (e) {}
  }
  return {
    session: null,
    mode: 'signin',
    error: bootstrapError ? { code: bootstrapError.code || null, status: bootstrapError.status || null, message: bootstrapError.message || String(bootstrapError) } : null,
  };
}

// A lightweight authenticated read used only to establish operational cloud reachability.
// navigator.onLine is a hint, not proof that the configured Supabase project is reachable.
async function checkReachability(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  if (offlineAuthMode && offlineAuthTransportFailure) {
    const error = new Error('Network request failed during offline auth bootstrap');
    error.code = 'ERR_NETWORK';
    throw error;
  }
  const session = await getSession();
  if (!session) {
    const error = new Error('No authenticated Supabase session');
    error.code = 'AUTH_SESSION_MISSING';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { error } = await supabase
      .from('sales')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal);
    if (error) throw error;
    setOfflineAuthMode(false);
    await recordVerifiedOfflineIdentity(session.user);
    return { ok: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Supabase reachability check timed out after ${timeoutMs}ms`);
      timeoutError.code = 'REACHABILITY_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function signOut() {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } finally {
    currentSession = null;
    setOfflineAuthMode(false);
    try { await window.electronAPI?.clearOfflineAuthIdentity?.(); } catch (e) {}
    window.dispatchEvent(new CustomEvent('vhc-cloud-signed-out'));
  }
}

// Is the signed-in user a platform admin? Gates the admin-only Settings sections (Backup &
// Restore / Stock Audit cards, Admin Security, Cloud Integrations). The Settings screen already
// calls this; it was never implemented here, so the call silently short-circuited and every
// account was treated as non-admin, hiding those sections from everyone.
//
// This delegates to the EXISTING server-side function rather than reading profiles directly:
//   public.is_platform_admin()  -- SQL, STABLE, SECURITY DEFINER, search_path=public
//     select coalesce((select is_platform_admin from public.profiles where id = auth.uid()), false)
// so the answer is derived server-side from the caller's own auth.uid() under the database's own
// rules. No admin identity is hardcoded here, no profile row is read by the client, and the
// client cannot widen its own privileges. Fails CLOSED: any error, missing function or
// non-true value yields false.
async function isPlatformAdmin() {
  try {
    const { data, error } = await supabase.rpc('is_platform_admin');
    if (error) return false;
    return data === true;
  } catch (e) {
    return false;
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    currentSession = null;
    setOfflineAuthMode(false);
    window.dispatchEvent(new CustomEvent('vhc-cloud-signed-out'));
  } else if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user) {
    currentSession = session;
    setOfflineAuthMode(false);
  }
});

window.addEventListener('online', () => {
  offlineAuthTransportFailure = false;
});

// ============================================================
// Locations / catalog
// ============================================================

let pharmacyLocationId = null;
let productCodeSupported = false;

async function ensurePharmacyLocation() {
  if (pharmacyLocationId) return pharmacyLocationId;
  const { data, error } = await supabase
    .from('locations')
    .select('id')
    .eq('type', 'pharmacy_counter')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No location of type pharmacy_counter found (expected "${PHARMACY_LOCATION_NAME}")`);
  pharmacyLocationId = data.id;
  return pharmacyLocationId;
}

// Same code-first-then-name matching rule as WarehouseContext.jsx's
// resolveItemId, so a drug already known to Warehouse becomes the same
// items row instead of a duplicate.
async function resolveItemId({ name, category, hsnCode, unitsPerPack, productCode }) {
  const trimmed = (name || '').trim();
  const code = (productCode || '').trim();

  if (code) {
    const { data: byCode } = await supabase.from('items').select('id').ilike('product_code', code).limit(1).maybeSingle();
    if (byCode) return byCode.id;
  }
  const { data: existing } = await supabase.from('items').select('id').ilike('name', trimmed).limit(1).maybeSingle();
  if (existing) return existing.id;

  const insertPayload = { name: trimmed, category: category || null, hsn_code: hsnCode || null, units_per_pack: unitsPerPack || null };
  if (code && productCodeSupported) insertPayload.product_code = code;

  const { data: created, error } = await supabase.from('items').insert(insertPayload).select('id').single();
  if (error) throw error;
  return created.id;
}

// ============================================================
// Inventory (stock_batches at the pharmacy_counter location)
// ============================================================

let inventoryCache = [];

function rowToInventoryItem(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    locationId: row.location_id,
    name: row.items?.name || '',
    batch: row.batch_no || '',
    expiry: row.expiry_date || '',
    mrp: row.mrp,
    netRate: row.net_rate,
    rate: row.net_rate,
    gst: row.gst,
    stockist: row.stockist,
    stock: row.qty,
    category: row.items?.category,
    hsnCode: row.items?.hsn_code,
    unitsPerPack: row.items?.units_per_pack || 10,
  };
}

async function fetchInventory() {
  const locId = await ensurePharmacyLocation();
  const { data, error } = await supabase
    .from('stock_batches')
    .select('*, items(name, category, hsn_code, units_per_pack)')
    .eq('location_id', locId);
  if (error) throw error;
  inventoryCache = (data || []).map(rowToInventoryItem);
  cacheSet('inventory', inventoryCache);
  return inventoryCache;
}

function getInventory() {
  return inventoryCache.length ? inventoryCache : cacheGet('inventory') || [];
}

async function addInventoryItem(item) {
  const locId = await ensurePharmacyLocation();
  // item.category flows straight into resolveItemId's destructured params —
  // sets items.category only on first insert of a brand-new catalog item,
  // never touches an existing shared row (see updateInventoryItem for edits).
  const itemId = await resolveItemId(item);
  // Stock-sync remediation: create the batch AND its opening quantity in the ledger in one server transaction
  // (create_stock_batch). A second batch with the same item + batch number is refused instead of duplicated.
  // Falls back to the older direct insert only while the server function is not deployed.
  const openingQty = Number.isFinite(parseFloat(item.stock)) ? parseFloat(item.stock) : 0;
  const { data: created, error: createError } = await supabase.rpc('create_stock_batch', {
    payload: {
      request_key: item.requestKey || newStockRequestKey(), item_id: itemId, location_id: locId,
      batch_no: item.batch || null, expiry_date: expiryToISODate(item.expiry),
      mrp: item.mrp ?? item.price ?? null, net_rate: item.netRate ?? item.rate ?? null, gst: item.gst ?? null,
      stockist: item.stockist || null, opening_qty: openingQty,
      reason: item.openingReason || 'New batch added in Inventory',
    },
  });
  if (createError && !isRpcMissing(createError)) throw createError;
  if (!createError) {
    const s = created && created.status;
    if (s === 'CONFLICT_BATCH_EXISTS') {
      throw stockRpcError(s, `"${item.name || 'This item'}" batch "${item.batch || '(no batch)'}" already exists (current stock ${created.current_qty}). Nothing was created. Add the new stock to the existing batch with a stock correction instead.`, created);
    }
    if (s !== 'APPLIED' && s !== 'ALREADY_APPLIED') throw stockRpcError(s || 'UNKNOWN', describeStockStatus(created), created);
    const { data: row, error: readError } = await supabase
      .from('stock_batches').select('*, items(name, category, hsn_code, units_per_pack)').eq('id', created.stock_batch_id).single();
    if (readError) throw readError;
    const mappedNew = rowToInventoryItem(row);
    inventoryCache = [...inventoryCache.filter((i) => i.id !== mappedNew.id), mappedNew];
    cacheSet('inventory', inventoryCache);
    return mappedNew;
  }
  const { data, error } = await supabase
    .from('stock_batches')
    .insert({
      item_id: itemId, location_id: locId,
      batch_no: item.batch || null, expiry_date: expiryToISODate(item.expiry),
      mrp: item.mrp ?? item.price, net_rate: item.netRate ?? item.rate, gst: item.gst,
      stockist: item.stockist || null, qty: item.stock || 0,
    })
    .select('*, items(name, category, hsn_code, units_per_pack)').single();
  if (error) throw error;
  const mapped = rowToInventoryItem(data);
  inventoryCache = [...inventoryCache, mapped];
  cacheSet('inventory', inventoryCache);
  return mapped;
}

// ─── Manual stock corrections (EDIT / RESTORE / TRANSFER) ───────────────────────────────────────────
// All three go through server RPCs (supabase/migrations/20261022000100_stock_correction_rpcs.sql) so each
// stock change and its stock_movements row commit atomically, concurrency is checked under a row lock, a
// retried request cannot apply twice, and created_by is taken from the signed-in session on the server.
// If an RPC is not installed the change is REFUSED (never silently falls back to the old two-step write).
const GENERIC_STOCK_REASONS = new Set([
  'update', 'updated', 'edit', 'edited', 'change', 'changed', 'stock', 'stock update', 'stock change',
  'stock edit', 'correction', 'stock correction', 'adjust', 'adjusted', 'adjustment', 'na', 'n a', 'none',
  'nil', 'null', 'test', 'ok', 'reason', 'no reason', 'manual', 'misc', 'other', 'fix', 'qty', 'quantity',
]);
function manualStockReasonProblem(reason) {
  const r = String(reason == null ? '' : reason).trim();
  if (r.length < 3) return 'A reason (at least 3 characters) is required for manual stock changes.';
  if (r.length > 500) return 'The reason is too long (500 characters maximum).';
  const norm = r.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
  if (GENERIC_STOCK_REASONS.has(norm)) return `"${r}" is too general. Describe why the stock changed (for example: "Physical count on 21-Oct, 2 strips damaged").`;
  return null;
}
function newStockRequestKey() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}
function stockRpcError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) e.details = JSON.stringify(extra);
  return e;
}
function isRpcMissing(error) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .* does not exist/i.test(msg);
}
function describeStockStatus(r) {
  const s = r && r.status;
  switch (s) {
    case 'CONFLICT_STALE_OPENING':
      return `Stock for this batch is now ${r.current_qty}, not the ${r.expected_qty} you started from (it was changed elsewhere). Nothing was saved. Close and reopen the item, check the quantity, then correct it again.`;
    case 'CONFLICT_BATCH_NOT_FOUND': return 'This batch no longer exists in the cloud. Nothing was saved. Refresh the inventory.';
    case 'CONFLICT_NOT_PHARMACY_BATCH': return 'This batch is not pharmacy stock, so it cannot be corrected here. Nothing was saved.';
    case 'CONFLICT_REQUEST_KEY_REUSED': return 'This save request was already used for a different correction. Nothing was saved. Please save again.';
    case 'CONFLICT_MOVEMENT_MISMATCH': return 'A different stock restore is already recorded for this bill and batch. Nothing was changed.';
    case 'REJECTED_REASON': return manualStockReasonProblem(r.reason) || 'The reason was rejected. Nothing was saved.';
    case 'REJECTED_NEGATIVE_QTY': return 'Stock cannot be negative. Nothing was saved.';
    case 'ALREADY_COMPLETED': return `Transfer ${r.transfer_number || ''} was already accepted. Nothing was changed.`;
    case 'NOT_PENDING': return `This request is already "${r.current_status}". Nothing was changed.`;
    case 'NOT_FOUND': return 'Request not found. Refresh and try again.';
    case 'NOT_PERMITTED': return 'Your account is not allowed to make this stock change (ask an admin). Nothing was changed.';
    case 'CONFLICT_INSUFFICIENT_STOCK': return `Warehouse stock for "${r.name}" is ${r.available}, but ${r.needed} is needed. Nothing was transferred; the request is still Pending.`;
    case 'CONFLICT_SOURCE_NOT_FOUND': return `"${r.name}" (this batch) was not found in Main Stock. Nothing was transferred; the request is still Pending.`;
    case 'CONFLICT_SOURCE_AMBIGUOUS': return `"${r.name}" matches ${r.matches} Main Stock batches, so the correct one cannot be chosen safely. Nothing was transferred.`;
    case 'CONFLICT_DESTINATION_AMBIGUOUS': return `"${r.name}" matches ${r.matches} pharmacy batches, so the correct one cannot be chosen safely. Nothing was transferred.`;
    case 'CONFLICT_LINE_WITHOUT_ITEM': return `"${r.name}" is not linked to an inventory item. Nothing was transferred.`;
    case 'CONFLICT_NO_LINES': return 'This request has no items to transfer.';
    case 'CONFLICT_LOCATION_AMBIGUOUS': return `The ${r.location_type} location is not unique (${r.matches} found). Nothing was transferred.`;
    case 'CONFLICT_TRANSFER_UNIT': return `"${r.name}" has a missing or unknown unit (unit: ${r.transfer_unit ?? 'none'}, pack size: ${r.units_per_pack ?? 'none'}), so its quantity cannot be converted safely. Nothing was transferred; the request is still Pending.`;
    case 'CONFLICT_LOCATION_MISMATCH': return 'This request is not a Main Stock to Pharmacy transfer. Nothing was transferred.';
    default: return `The server refused the stock change (${s || 'no status'}). Nothing was saved.`;
  }
}
async function applyStockCorrection({ id, expectedStock, newStock, reason, requestKey }) {
  const problem = manualStockReasonProblem(reason);
  if (problem) throw stockRpcError('REJECTED_REASON', problem);
  if (!Number.isFinite(newStock) || newStock < 0) throw stockRpcError('REJECTED_NEGATIVE_QTY', 'Enter a stock quantity of 0 or more. Nothing was saved.');
  if (!Number.isFinite(expectedStock)) throw stockRpcError('MISSING_EXPECTED_STOCK', 'The starting stock is unknown. Reopen the item and try again.');
  const { data, error } = await supabase.rpc('apply_stock_correction', {
    payload: { request_key: requestKey || newStockRequestKey(), stock_batch_id: id, expected_qty: expectedStock, new_qty: newStock, reason: String(reason).trim() },
  });
  if (error) {
    if (isRpcMissing(error)) throw stockRpcError('RPC_MISSING', 'The stock-correction server update (apply_stock_correction) is not installed yet. Stock was NOT changed.');
    throw error;
  }
  const s = data && data.status;
  if (s === 'APPLIED' || s === 'ALREADY_APPLIED' || s === 'NO_CHANGE') return data;
  throw stockRpcError(s || 'UNKNOWN', describeStockStatus(data), data);
}
async function applyStockRestore({ id, delta, billId, reason, patientId }) {
  const problem = manualStockReasonProblem(reason);
  if (problem) throw stockRpcError('REJECTED_REASON', problem);
  const { data, error } = await supabase.rpc('apply_stock_restore', {
    payload: { bill_id: billId, stock_batch_id: id, quantity_delta: delta, reason: String(reason).trim(), patient_id: UUID_RE.test(String(patientId || '')) ? patientId : null },
  });
  if (error) {
    if (isRpcMissing(error)) throw stockRpcError('RPC_MISSING', 'The stock-restore server update (apply_stock_restore) is not installed yet. Stock was NOT restored.');
    throw error;
  }
  const s = data && data.status;
  if (s === 'APPLIED' || s === 'ALREADY_APPLIED') return data;
  throw stockRpcError(s || 'UNKNOWN', describeStockStatus(data), data);
}

// patch: { stock, reason, ... } — stock changes must carry a reason and are
// logged to stock_movements (type EDIT), same invariant vhc-audit-engine.js
// already enforces locally.
async function updateInventoryItem(id, patch, reason, options) {
  const current = inventoryCache.find((i) => i.id === id);
  if (!current) throw new Error(`Inventory item ${id} not found in cache`);

  const batchPatch = {};
  if (patch.batch !== undefined) batchPatch.batch_no = patch.batch || null;
  if (patch.expiry !== undefined) batchPatch.expiry_date = expiryToISODate(patch.expiry);
  if (patch.netRate !== undefined) batchPatch.net_rate = patch.netRate;
  if (patch.rate !== undefined) batchPatch.net_rate = patch.rate;
  // price is the UI's legacy field name for the same value as mrp (see the
  // Edit Item form) — accept it as a fallback so saving an edited item can
  // actually update mrp, same convention as addInventoryItem/restoreInventoryFromBackup.
  if (patch.mrp !== undefined) batchPatch.mrp = patch.mrp;
  else if (patch.price !== undefined) batchPatch.mrp = patch.price;
  if (patch.gst !== undefined) batchPatch.gst = patch.gst;
  if (patch.stockist !== undefined) batchPatch.stockist = patch.stockist;
  // Stock changes are applied ONLY through apply_stock_correction (atomic batch update + EDIT movement,
  // compare-and-set on the quantity the user started from, idempotent per request key, server-side actor).
  // The quantity is never part of the plain batch update below. expectedStock is what the user saw when the
  // edit began (options.expectedStock); without it, the cached cloud value is used.
  const opts = options || {};
  const expectedStock = opts.expectedStock !== undefined && opts.expectedStock !== null ? Number(opts.expectedStock) : Number(current.stock);
  const stockChanged = patch.stock !== undefined && patch.stock !== null && Math.abs(Number(patch.stock) - expectedStock) > 0.0005;
  let correction = null;
  if (stockChanged) {
    correction = await applyStockCorrection({ id, expectedStock, newStock: Number(patch.stock), reason, requestKey: opts.requestKey });
  }

  if (Object.keys(batchPatch).length > 0) {
    // .select('id') returns the rows actually updated; an empty result means nothing was written
    // (row gone or not permitted), which must not be reported as success.
    const { data: updatedRows, error } = await supabase.from('stock_batches').update(batchPatch).eq('id', id).select('id');
    if (error || !updatedRows || updatedRows.length === 0) {
      const why = error ? (error.message || String(error)) : 'no batch row was updated (it may have been removed, or you may not have permission)';
      throw stockRpcError(correction ? 'STOCK_SAVED_DETAILS_FAILED' : 'DETAILS_NOT_SAVED',
        correction ? `The stock correction WAS saved, but the other changes were not: ${why}. Save again to retry the other changes.`
                   : `Changes were not saved: ${why}.`);
    }
  }

  // category and unitsPerPack live on the shared items row, not stock_batches.
  // items UPDATE is warehouse/admin-only (items_write_warehouse RLS policy) —
  // a pharmacist-role attempt matches zero rows and silently no-ops rather
  // than erroring, so read back what actually persisted instead of trusting
  // the patch, otherwise the local cache would show values that revert the
  // next time inventory is fetched from Supabase.
  let persistedCategory = current.category;
  let persistedUnitsPerPack = current.unitsPerPack;
  const itemsPatch = {};
  if (patch.category !== undefined && patch.category !== current.category) itemsPatch.category = patch.category;
  if (patch.unitsPerPack !== undefined && Number(patch.unitsPerPack) !== Number(current.unitsPerPack)) itemsPatch.units_per_pack = patch.unitsPerPack;
  if (Object.keys(itemsPatch).length > 0) {
    const { data: itemRow } = await supabase
      .from('items')
      .update(itemsPatch)
      .eq('id', current.itemId)
      .select('category, units_per_pack')
      .maybeSingle();
    if (itemRow) {
      persistedCategory = itemRow.category;
      persistedUnitsPerPack = itemRow.units_per_pack || 10;
    }
  }

  inventoryCache = inventoryCache.map((i) => (i.id === id ? { ...i, ...patch, category: persistedCategory, unitsPerPack: persistedUnitsPerPack } : i));
  cacheSet('inventory', inventoryCache);
  return inventoryCache.find((i) => i.id === id);
}

// Bulk import/merge: for each item, merge into an existing batch (same name
// + batch, case-insensitive) by adding to its qty, or insert a new batch —
// same matching rule the local addItemsBulk already used.
async function addInventoryItemsBulk(items) {
  const results = [];
  for (const item of items) {
    const existing = inventoryCache.find((i) =>
      i.name.toLowerCase().trim() === (item.name || '').toLowerCase().trim() &&
      (item.batch ? (i.batch || '').toLowerCase().trim() === item.batch.toLowerCase().trim() : true)
    );
    if (existing) {
      const addedQty = parseInt(item.stock, 10) || 0;
      const updated = await updateInventoryItem(existing.id, { stock: (existing.stock || 0) + addedQty }, 'Bulk import / purchase stock-in');
      results.push(updated);
    } else {
      const created = await addInventoryItem(item);
      results.push(created);
    }
  }
  return results;
}

// Restore-from-backup: sets each item's stock/mrp/etc to exactly the backed-up
// value (not additive, unlike addInventoryItemsBulk's purchase-merge), matched
// by name+batch. Deliberately never deletes a cloud item just because it's
// missing from the backup — the cloud inventory may already reflect real
// sales/edits from other terminals made after this particular backup was
// taken, and a restore should never silently erase those without the admin
// explicitly choosing to. Logs a RESTORE stock_movements entry per changed item.
async function restoreInventoryFromBackup(items) {
  if (!Array.isArray(items) || items.length === 0) return { restored: 0, failed: 0, errors: [] };
  await fetchInventory();
  let restored = 0;
  const errors = [];
  for (const item of items) {
    try {
      if (!item || !item.name) throw new Error('Missing item name');
      const existing = inventoryCache.find((i) =>
        i.name.toLowerCase().trim() === (item.name || '').toLowerCase().trim() &&
        (item.batch ? (i.batch || '').toLowerCase().trim() === item.batch.toLowerCase().trim() : true)
      );
      if (existing) {
        await updateInventoryItem(existing.id, {
          stock: Number.isFinite(parseFloat(item.stock)) ? parseFloat(item.stock) : 0,
          mrp: item.mrp ?? item.price, netRate: item.netRate, gst: item.gst,
          expiry: item.expiry, stockist: item.stockist,
        }, `Backup restore`);
      } else {
        await addInventoryItem(item);
      }
      restored++;
    } catch (e) {
      errors.push({ name: item && item.name, error: e.message || String(e) });
    }
  }
  return { restored, failed: errors.length, errors };
}

// deductions: [{id (stock_batches id), qty (signed delta: negative = sale
// deduction, positive = restore)}], context: {billId, patientName, patientId,
// reason}. Interim direct-adjustment path for callers not yet wired to the
// atomic create_sale/delete_sale_and_restore RPCs — logs the same
// stock_movements shape those RPCs produce.
async function adjustStockBulk(deductions, context) {
  if (!Array.isArray(deductions) || deductions.length === 0) return [];
  const ctx = context || {};
  const locId = await ensurePharmacyLocation();
  const results = [];
  // RESTORE (positive delta, e.g. a deleted bill's stock coming back): one atomic, idempotent server call per
  // batch, keyed by bill + batch, so deleting/retrying the same bill can never restore twice. Lines on the
  // same batch are summed first. Every batch is attempted; failures are collected and reported together.
  const restores = new Map();
  for (const d of deductions) {
    const delta = parseFloat(d.qty) || 0;
    if (delta > 0) restores.set(d.id, (restores.get(d.id) || 0) + delta);
  }
  const restoreProblems = [];
  if (restores.size > 0) {
    if (!ctx.billId) throw stockRpcError('RESTORE_NEEDS_BILL', 'A stock restore must name its bill, so it can never be applied twice. Nothing was restored.');
    for (const [id, delta] of restores) {
      const current = inventoryCache.find((i) => i.id === id);
      try {
        const r = await applyStockRestore({ id, delta, billId: ctx.billId, reason: ctx.reason, patientId: ctx.patientId });
        results.push({ id, opening: r.opening, closing: r.closing, status: r.status });
      } catch (e) {
        restoreProblems.push(`${(current && current.name) || id}: ${e.message || e}`);
      }
    }
  }
  // BILL (negative delta): legacy direct path, unchanged. Bill stock normally goes through
  // apply_bill_stock_movement in the financial sync worker; this branch is kept exactly as before.
  for (const d of deductions) {
    const current = inventoryCache.find((i) => i.id === d.id);
    if (!current) continue;
    const delta = parseFloat(d.qty) || 0;
    if (!(delta < 0)) continue;
    const opening = parseFloat(current.stock) || 0;
    const closing = opening + delta;
    const { error } = await supabase.from('stock_batches').update({ qty: closing }).eq('id', d.id);
    if (error) throw error;
    await supabase.from('stock_movements').insert({
      item_id: current.itemId, location_id: locId, batch_no: current.batch,
      type: delta < 0 ? 'BILL' : 'RESTORE', qty: delta, opening, closing,
      bill_id: ctx.billId || null, patient_id: ctx.patientId || null, reason: ctx.reason || null,
    });
    results.push({ id: d.id, opening, closing });
  }
  await fetchInventory();
  if (restoreProblems.length) {
    throw stockRpcError('RESTORE_INCOMPLETE', `Cloud stock was not restored for: ${restoreProblems.join('; ')}`);
  }
  return results;
}

async function reconcileStockMovement(payload) {
  assertCloudWritesAllowed('reconcileStockMovement');
  const { data, error } = await supabase.rpc('reconcile_stock_movement', { payload });
  if (error) throw error;
  return data;
}

// v3.19.3: delta-based, idempotent, atomic BILL stock application (migration
// 20261015000100). Returns { status: 'RPC_MISSING' } when the function is not deployed yet so
// the worker can fall back to reconcile_stock_movement instead of failing the stock stage.
async function applyBillStockMovement(payload) {
  assertCloudWritesAllowed('applyBillStockMovement');
  const { data, error } = await supabase.rpc('apply_bill_stock_movement', { payload });
  if (error) {
    const code = String(error.code || '');
    const msg = String(error.message || '');
    if (code === 'PGRST202' || code === '42883' || /could not find the function|function .*apply_bill_stock_movement.* does not exist/i.test(msg)) {
      return { status: 'RPC_MISSING' };
    }
    throw error;
  }
  return data;
}

async function findStockMovementByKey(movementKey) {
  if (!movementKey) return null;
  const { data, error } = await supabase
    .from('stock_movements')
    .select('id, movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, reason, created_at')
    .eq('movement_key', movementKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ─── Stock-sync remediation (migration 20261023000100) ──────────────────────────────────────────────
// One bill's BILL lines in ONE server transaction: all lines apply or none do, exactly once per original
// movement_key. { status: 'RPC_MISSING' } when the function is not deployed yet (the worker then keeps the
// older single-line path). allow_identity_fallback (re-point a line at the current batch) is admin-only server-side.
async function applyBillStockMovements(payload) {
  assertCloudWritesAllowed('applyBillStockMovements');
  const { data, error } = await supabase.rpc('apply_bill_stock_movements', { payload });
  if (error) {
    if (isRpcMissing(error)) return { status: 'RPC_MISSING' };
    throw error;
  }
  return data;
}

// Read-back of several movement keys at once (verification after apply / review resolution).
async function findStockMovementsByKeys(movementKeys) {
  const keys = Array.from(new Set((Array.isArray(movementKeys) ? movementKeys : []).filter(Boolean).map(String)));
  if (keys.length === 0) return [];
  const { data, error } = await supabase
    .from('stock_movements')
    .select('id, movement_key, item_id, location_id, batch_no, type, qty, opening, closing, bill_id, created_by, created_at')
    .in('movement_key', keys);
  if (error) throw error;
  return data || [];
}

// Bill delete: restore EXACTLY the recorded deductions of this bill, once each (never the bill's line
// quantities). Also marks the bill deleted server-side so a late sync can never deduct it.
// No patient id is sent (T7 fix): the counter only knows its LOCAL patient id, which is not a cloud patients.id and
// broke the restore on stock_movements_patient_id_fkey. The server takes the patient from the recorded deductions.
async function restoreBillStock({ billId, reason }) {
  assertCloudWritesAllowed('restoreBillStock');
  const { data, error } = await supabase.rpc('restore_bill_stock', {
    payload: { bill_id: billId, reason: String(reason || '').trim() },
  });
  if (error) {
    if (isRpcMissing(error)) return { status: 'RPC_MISSING' };
    throw error;
  }
  return data;
}

// Server-verified admin check for review actions that only an admin may take. Any failure = not admin.
async function isCurrentUserAdmin() {
  try {
    const { data, error } = await supabase.rpc('is_admin');
    return !error && data === true;
  } catch (e) {
    return false;
  }
}

// Stock-sync remediation: a batch is never hard-deleted while any bill on this counter still depends on it, a batch
// that holds stock or has stock history is kept (closed at zero), and an allowed deletion is recorded in the ledger
// (delete_stock_batch). Deleting and re-creating batches is what broke pending bills' batch references.
async function deleteInventoryItem(id, options) {
  const opts = options || {};
  const current = inventoryCache.find((i) => i.id === id);
  if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getStockBatchReferences) {
    const refs = await window.electronAPI.getStockBatchReferences({
      serverStockBatchId: id, serverItemId: current ? current.itemId : null,
      cloudLocationId: current ? current.locationId : null, batchNo: current ? current.batch : null,
    });
    if (!refs || refs.success === false) {
      throw stockRpcError('BATCH_REFERENCES_UNKNOWN', `This counter could not check which bills still use this batch (${(refs && refs.error) || 'local database unavailable'}). Nothing was deleted.`);
    }
    if (Array.isArray(refs.bills) && refs.bills.length > 0) {
      throw stockRpcError('BATCH_IN_USE', `This batch is still used by ${refs.bills.length} bill(s) waiting for cloud sync or stock review (${refs.bills.slice(0, 5).join(', ')}${refs.bills.length > 5 ? ', ...' : ''}). It cannot be deleted now. Nothing was deleted.`, refs);
    }
  }
  const reason = String(opts.reason || 'Batch removed from Inventory').trim();
  const { data: del, error: delError } = await supabase.rpc('delete_stock_batch', {
    payload: { request_key: opts.requestKey || newStockRequestKey(), stock_batch_id: id, reason },
  });
  if (delError && !isRpcMissing(delError)) throw delError;
  if (!delError) {
    const s = del && del.status;
    if (s === 'CONFLICT_BATCH_NOT_EMPTY') {
      throw stockRpcError(s, `This batch still holds ${del.current_qty} in stock. Nothing was deleted. Correct the stock to 0 with a reason first; the batch is then kept at zero.`, del);
    }
    if (s === 'CONFLICT_BATCH_HAS_HISTORY') {
      throw stockRpcError(s, 'This batch has sales or stock history, so it is kept (closed at zero) instead of being deleted: bills from any counter can still find it. Nothing was deleted.', del);
    }
    if (s === 'CONFLICT_BATCH_REFERENCED') throw stockRpcError(s, 'This batch is referenced by a bill or return line, so it cannot be deleted. Nothing was deleted.', del);
    if (s !== 'APPLIED' && s !== 'ALREADY_APPLIED') throw stockRpcError(s || 'UNKNOWN', describeStockStatus(del), del);
    inventoryCache = inventoryCache.filter((i) => i.id !== id);
    cacheSet('inventory', inventoryCache);
    return { success: true, id, recorded: true };
  }
  // Server function not deployed yet: the older direct delete, but never for a batch that still holds stock.
  if (current && Math.abs(Number(current.stock) || 0) > 0.0005) {
    throw stockRpcError('CONFLICT_BATCH_NOT_EMPTY', `This batch still holds ${current.stock} in stock. Nothing was deleted. Correct the stock to 0 with a reason first.`);
  }
  const { error } = await supabase.from('stock_batches').delete().eq('id', id);
  if (error) throw error;
  inventoryCache = inventoryCache.filter((i) => i.id !== id);
  cacheSet('inventory', inventoryCache);
  // Callers gate their UI refresh on a truthy return value (same convention
  // as every other write here) — returning nothing here made a successful
  // delete look like a failure to Hr's deleteItem, so the list never
  // refreshed and the deleted row kept showing until a manual reload.
  return { success: true, id };
}

// ============================================================
// Patients
// ============================================================

let patientsCache = [];

function identityFilter(p) {
  const contact = (p.contact || p.mobile || p.phone || '').replace(/\D/g, '');
  return { contact, name: (p.name || '').trim().toLowerCase(), age: p.age || null, sex: p.sex || p.gender || null };
}

// legacyId: the local app's own patient identifier, e.g. "PID-XXXX-XXX" or
// "WALKIN-XXXX-XXX" (see patients[].patientId / salesHistory[].patientId in
// the backup JSON) — never a Supabase UUID, so it must never be passed
// directly as patients.id or sales.patient_id.
async function findExistingPatient(p, legacyId) {
  if (legacyId) {
    const { data } = await supabase.from('patients').select('*').eq('legacy_patient_id', legacyId).limit(1).maybeSingle();
    if (data) return data;
  }
  const { contact, name } = identityFilter(p);
  if (contact) {
    const { data } = await supabase.from('patients').select('*').eq('contact', contact).limit(1).maybeSingle();
    if (data) return data;
  }
  if (name) {
    const { data } = await supabase.from('patients').select('*').ilike('name', name).limit(1).maybeSingle();
    if (data) return data;
  }
  return null;
}

// Called from the existing OPD Google-Sheet sync path: upserts each synced
// patient into Supabase (matched by legacy id, else phone, else name) so the
// sync becomes visible on every Pharmacy POS terminal in real time, not just
// this one. Backfills legacy_patient_id even on an already-matched row so
// later bill restores can resolve this patient by their local id.
async function upsertPatientFromOPD(p) {
  const legacyId = p.patientId || null;
  const existing = await findExistingPatient(p, legacyId);
  const payload = {
    name: p.name, contact: p.contact || p.mobile || p.phone || null,
    age: p.age || null, sex: p.sex || p.gender || null, address: p.address || null, source: 'opd',
  };
  if (legacyId) payload.legacy_patient_id = legacyId;
  if (existing) {
    const { data, error } = await supabase.from('patients').update(payload).eq('id', existing.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('patients').insert(payload).select().single();
  if (error) throw error;
  return data;
}

// Bulk restore-from-backup for patients[]: same match-then-upsert rule as
// upsertPatientFromOPD, matched by legacy_patient_id first so a re-run is
// idempotent. Never deletes a cloud patient absent from the backup — same
// non-destructive convention as restoreInventoryFromBackup.
async function restorePatientsFromBackup(patients) {
  if (!Array.isArray(patients) || patients.length === 0) return { restored: 0, failed: 0, errors: [] };
  let restored = 0;
  const errors = [];
  for (const p of patients) {
    try {
      if (!p || !p.name) throw new Error('Missing patient name');
      await upsertPatientFromOPD({ ...p, source: p.source || 'restore' });
      restored++;
    } catch (e) {
      errors.push({ name: p && p.name, patientId: p && p.patientId, error: e.message || String(e) });
    }
  }
  return { restored, failed: errors.length, errors };
}

// legacyId is treated as an opaque local identifier (PID-.../WALKIN-...),
// never assumed to already be a UUID — resolved through legacy_patient_id or
// contact only, deliberately NEVER by name. The checkout screen falls back
// to the literal display name "Walk-in Patient" for any truly anonymous
// sale (see oe() in index-doBKNLAj.js) — that string is shared across every
// such walk-in, so a name-based match here would risk attributing a bill to
// a completely unrelated patient who happens to have the same (possibly
// generic) name. Returns null (not an error) when no match exists; callers
// fall back to the sale's own free-text patient_name column rather than
// inventing a new patient record or guessing by name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolvePatientId(legacyId, fallback) {
  // A patient picked from the live Supabase-backed autocomplete already
  // carries its real patients.id as legacyId — short-circuit before the
  // legacy_patient_id/contact lookup, which would never match a real UUID.
  if (legacyId && UUID_RE.test(legacyId)) return legacyId;
  const contact = fallback && (fallback.contact || fallback.mobile || fallback.phone);
  if (!legacyId && !contact) return null;
  const existing = await findExistingPatient({ contact }, legacyId);
  return existing ? existing.id : null;
}

async function addManualPatient(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Patient name required');
  const { data: existing } = await supabase.from('patients').select('*').ilike('name', trimmed).eq('is_manual', true).is('merged_into_patient_id', null).limit(1).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from('patients').insert({ name: trimmed, source: 'manual', is_manual: true }).select().single();
  if (error) throw error;
  return data;
}

async function mergeManualPatientInto(manualPatientId, realPatientId) {
  const { error } = await supabase.from('patients').update({ merged_into_patient_id: realPatientId }).eq('id', manualPatientId);
  if (error) throw error;
}

async function fetchPatients() {
  const { data, error } = await supabase.from('patients').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  patientsCache = data || [];
  cacheSet('patients', patientsCache);
  return patientsCache;
}

function getAllPatients() {
  const list = patientsCache.length ? patientsCache : cacheGet('patients') || [];
  return list.filter((p) => !p.merged_into_patient_id);
}

function findPatientsByName(name) {
  const needle = (name || '').trim().toLowerCase();
  if (!needle) return [];
  return getAllPatients().filter((p) => (p.name || '').trim().toLowerCase() === needle);
}

// ============================================================
// Sales / billing (via the atomic create_sale / delete_sale_and_restore RPCs)
// ============================================================

let salesCache = [];

async function fetchSalesHistory() {
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .order('sale_date', { ascending: false });
  if (error) throw error;
  salesCache = data || [];
  cacheSet('salesHistory', salesCache);
  return salesCache;
}

function getSalesHistory() {
  return salesCache.length ? salesCache : cacheGet('salesHistory') || [];
}

// item_id lookup only — never creates a catalog row (unlike resolveItemId,
// used by inventory adds). A billing/restore line for a drug that isn't in
// the catalog yet should record its name/rate as-is and leave item_id null,
// not silently mint a new item mid-sale.
async function resolveExistingItemId(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const cached = inventoryCache.find((i) => (i.name || '').toLowerCase().trim() === trimmed.toLowerCase());
  if (cached) return cached.itemId;
  const { data } = await supabase.from('items').select('id').ilike('name', trimmed).limit(1).maybeSingle();
  return data ? data.id : null;
}

// Maps one backup/local particular into the RPC's item shape. affects_stock
// is true only when the line is actually stock-backed (a real Medicine line
// with a resolvable catalog item) — Injection/Procedure/Custom lines are
// service charges with no stock_batches row behind them, so create_sale
// must not try to FEFO-decrement inventory for them (that's what the
// 20260819000100 draft's affects_stock column exists for). expiry_date goes
// through the same expiryToISODate() used for inventory — the app's local
// convention is free text like "10/2027" or "N/A", not an ISO date, and the
// server-side safe_date() is only a defensive backstop, not the primary
// conversion.
async function mapSaleItem(i, { resolveItemFromName } = {}) {
  let itemId = i.itemId || i.item_id || null;
  if (!itemId && resolveItemFromName && i.drugName) {
    itemId = await resolveExistingItemId(i.drugName);
  }
  const metadata = {};
  for (const k of ['medicineName', 'medicineId', 'medicineQty', 'medicineUnitPrice', 'medicineCost',
    'syringeCharge', 'injectionCharge', 'optionalCharges', 'procedureName', 'procedureCharge',
    'materials', 'materialsCost', 'label', 'amount', 'notes']) {
    if (i[k] !== undefined) metadata[k] = i[k];
  }
  return {
    item_id: itemId, stock_batch_id: i.stockBatchId || null,
    category: i.category || null, drug_name: i.drugName, batch_no: i.batchNo || null,
    expiry_date: expiryToISODate(i.expiryDate), quantity: i.quantity, rate: i.rate, total: i.total,
    affects_stock: Boolean(itemId && i.stockBatchId) || Boolean(itemId && i.category === 'Medicine'),
    metadata,
  };
}

// payload: { billId, patientId, patientName, doctorName, paymentMode, subtotal,
//   totalTax, totalAmount, gstMode, discount, discountPercent, saleDate, recordOnly,
//   items:[{itemId, stockBatchId, category, drugName, batchNo, expiryDate,
//   quantity, rate, total, ...category-specific fields}] }
// patientId is the app's own local identifier (PID-.../WALKIN-...), resolved
// here to a real patients.id — never passed through as-is (see
// resolvePatientId).
//
// recordOnly: true forces affects_stock=false on every line, regardless of
// what mapSaleItem would otherwise compute, so create_sale only ever writes
// the sales/sale_items rows and never touches stock_batches. This is how the
// checkout screen's cloud sync is wired for now — the local checkout flow
// already deducts stock itself (via the existing adjustStockBulk-based
// path), so letting create_sale's own FEFO decrement run too would deduct
// the same sale's stock twice. Once the cloud path has been verified in
// real use, stock deduction can be moved onto create_sale's own decrement
// and recordOnly dropped — until then, exactly one mechanism ever touches
// stock_batches for a live sale.
async function createSale(payload) {
  const locId = await ensurePharmacyLocation();
  const patientId = await resolvePatientId(payload.patientId, { contact: payload.patientContact });
  const recordOnly = !!payload.recordOnly;
  const rpcPayload = {
    bill_id: payload.billId,
    client_request_id: payload.billId,
    patient_id: patientId,
    patient_name: payload.patientName || null,
    patient_snapshot: payload.patientSnapshot || null,
    doctor_name: payload.doctorName || null,
    payment_mode: payload.paymentMode || null,
    subtotal: payload.subtotal,
    total_tax: payload.totalTax,
    total_amount: payload.totalAmount,
    amount_received: payload.amountReceived ?? null,
    outstanding_amount: payload.outstandingAmount ?? null,
    payment_status: payload.paymentStatus || null,
    payment_breakdown: payload.paymentBreakdown || null,
    recorded_by: payload.recordedBy || null,
    gst_mode: payload.gstMode || null,
    discount: payload.discount,
    discount_percent: payload.discountPercent,
    location_id: locId,
    sale_date: payload.saleDate || undefined,
    items: await Promise.all((payload.items || []).map(async (i) => {
      const mapped = await mapSaleItem(i, { resolveItemFromName: true });
      return recordOnly ? { ...mapped, affects_stock: false, stock_batch_id: null } : mapped;
    })),
  };
  const { data, error } = await supabase.rpc('create_sale', { payload: rpcPayload });
  if (error) throw error;
  await Promise.all([fetchSalesHistory(), fetchInventory()]);
  return data;
}

async function findSaleByBillId(billId) {
  if (!billId) return null;
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .eq('bill_id', billId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Executes a return/refund for a CLOUD-origin (history-only) bill through the
// create_sale_return(jsonb) RPC — the only atomic, idempotent entry point for this.
// Everything that matters (authorization, remaining-quantity limits, stock-exactly-once,
// refund/credit audit) is enforced inside that one transaction on the server; this wrapper
// deliberately adds no client-side arithmetic that could disagree with it.
//
// returnId MUST be stable across retries of the same user action: the RPC treats it as the
// idempotency key, so a retry after a timeout replays as ALREADY_APPLIED instead of
// returning the stock a second time.
//
// RPC_MISSING is returned (not thrown) when the migration has not been applied to the target
// project yet, so the caller can fall back to a clean refusal instead of surfacing a raw
// PostgREST error.
async function createSaleReturn({ returnId, billId, items, returnType, refundMethod, outstandingAmount, reason, source }) {
  assertCloudWritesAllowed('createSaleReturn');
  if (!returnId || !billId || !Array.isArray(items) || items.length === 0) {
    throw new Error('createSaleReturn requires returnId, billId and at least one item');
  }
  const payload = {
    return_id: returnId,
    bill_id: billId,
    return_type: returnType || 'RETURN',
    items: items.map((line) => ({
      sale_item_id: line.saleItemId || line.sale_item_id,
      quantity: Number(line.quantity),
      disposition: line.disposition || 'SALEABLE',
    })),
  };
  if (refundMethod) payload.refund_method = refundMethod;
  if (Number.isFinite(Number(outstandingAmount))) payload.outstanding_amount = Number(outstandingAmount);
  if (reason) payload.reason = reason;
  payload.source = source || 'vhc-pos-cloud-return';

  const { data, error } = await supabase.rpc('create_sale_return', { payload });
  if (error) {
    // PostgREST reports an absent function as PGRST202 / "Could not find the function".
    const code = String(error.code || '');
    const message = String(error.message || '');
    if (code === 'PGRST202' || /could not find the function|does not exist/i.test(message)) {
      return { status: 'RPC_MISSING', error: message };
    }
    throw error;
  }
  // The original sale is untouched, but stock and history both moved — refresh the caches the
  // Returns UI and inventory read from, exactly as createSale/deleteSale do.
  await Promise.all([fetchSalesHistory(), fetchInventory()]);
  return data;
}

// Read-only, per-line returnability of a cloud bill, computed on the server with exactly the same
// stock reconstruction create_sale_return uses (original BILL stock movements). The Return screen
// shows every line of a cloud bill and enables only the ones this marks returnable, so a line is
// never hidden just because the cloud stored it record-only (affects_stock = false).
// RPC_MISSING is returned (not thrown) when the migration has not been applied yet.
async function getSaleReturnEligibility(billId) {
  if (!billId) throw new Error('getSaleReturnEligibility requires billId');
  const { data, error } = await supabase.rpc('get_sale_return_eligibility', { p_bill_id: billId });
  if (error) {
    const code = String(error.code || '');
    const message = String(error.message || '');
    if (code === 'PGRST202' || /could not find the function|does not exist/i.test(message)) {
      return { status: 'RPC_MISSING', error: message, lines: [] };
    }
    throw error;
  }
  return data;
}

// Read-only feed for the Returns & Refunds report. The report merges these rows with the local
// SQLite ones (deduped by return id), so a cloud-origin return — one taken against a
// history-only bill, which by definition has no local sale row — is still counted. Only
// COMPLETED returns are reported: DRAFT/VOIDED must never move financial totals.
// The sales embed is disambiguated explicitly because sale_returns has two FKs to sales
// (original_sale_id and exchange_sale_id) and PostgREST refuses the ambiguous form.
async function getSaleReturnsForReports() {
  const { data, error } = await supabase
    .from('sale_returns')
    .select(
      'id,original_bill_id,created_at,return_amount,refund_amount,credit_amount,status,' +
      'sales!sale_returns_original_sale_id_fkey(patient_name),' +
      'sale_return_items(quantity,sale_items(drug_name))'
    )
    .eq('status', 'COMPLETED')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function deleteSale(saleId) {
  const { error } = await supabase.rpc('delete_sale_and_restore', { p_sale_id: saleId });
  if (error) throw error;
  await Promise.all([fetchSalesHistory(), fetchInventory()]);
}

// Convenience for the delete-bill UI, which only knows the local text billId
// (e.g. "BILL-1787...") — looks up the corresponding cloud sale (if any; a
// bill created before this integration, or while cloud sync was down, may
// have none) and deletes it. A no-op, not an error, when no match exists.
async function deleteSaleByBillId(billId) {
  if (!billId) return { deleted: false, reason: 'no billId given' };
  const { data, error } = await supabase.from('sales').select('id').eq('bill_id', billId).maybeSingle();
  if (error) throw error;
  if (!data) return { deleted: false, reason: 'no matching cloud sale' };
  await deleteSale(data.id);
  return { deleted: true };
}

// Bulk restore-from-backup for salesHistory[]: replays each historical bill
// through restore_sale_history (sales + sale_items only, never touches
// stock — see the SQL migration's header comment for why). Idempotent on
// bill_id. item_id is resolved read-only (never creates a catalog row) so a
// bulk backfill of hundreds of old bills can't flood the items table with
// one-off entries for long-discontinued drugs.
async function restoreSaleHistory(bills) {
  if (!Array.isArray(bills) || bills.length === 0) return { restored: 0, failed: 0, errors: [] };
  let restored = 0;
  const errors = [];
  for (const bill of bills) {
    try {
      if (!bill || !bill.billId) throw new Error('Missing billId');
      const locId = await ensurePharmacyLocation();
      const snapshot = bill.patientSnapshot || {};
      const patientId = await resolvePatientId(bill.patientId, { contact: snapshot.contact });
      const rpcPayload = {
        bill_id: bill.billId,
        patient_id: patientId,
        patient_name: bill.patientName || snapshot.name || null,
        doctor_name: bill.doctorName || null,
        payment_mode: bill.paymentMode || null,
        subtotal: bill.subtotal,
        total_tax: bill.totalTax,
        total_amount: bill.totalAmount,
        amount_received: bill.amountReceived ?? null,
        outstanding_amount: bill.outstandingAmount ?? null,
        payment_status: bill.paymentStatus || null,
        payment_breakdown: bill.paymentBreakdown || null,
        recorded_by: bill.recordedBy || null,
        gst_mode: bill.gstMode || null,
        discount: bill.discount,
        discount_percent: bill.discountPercent,
        location_id: locId,
        sale_date: bill.date || undefined,
        items: await Promise.all((bill.particulars || []).map((i) => mapSaleItem(i, { resolveItemFromName: true }))),
      };
      const { error } = await supabase.rpc('restore_sale_history', { payload: rpcPayload });
      if (error) throw error;
      restored++;
    } catch (e) {
      errors.push({ billId: bill && bill.billId, error: e.message || String(e) });
    }
  }
  return { restored, failed: errors.length, errors };
}

// ============================================================
// Stock ledger (read path — writes happen inside create_sale /
// delete_sale_and_restore, or directly for EDIT via updateInventoryItem)
// ============================================================

async function getStockMovements() {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) throw error;
  return data || [];
}

// ============================================================
// Alerts config
// ============================================================

async function getAlertsConfig() {
  const locId = await ensurePharmacyLocation();
  const { data } = await supabase.from('alerts_config').select('*').eq('location_id', locId).maybeSingle();
  return data ? { lowStockThreshold: data.low_stock_threshold, expiryAlertDays: data.expiry_alert_days } : { lowStockThreshold: 200, expiryAlertDays: 90 };
}

async function updateAlertsConfig(patch) {
  const locId = await ensurePharmacyLocation();
  const dbPatch = {};
  if (patch.lowStockThreshold !== undefined) dbPatch.low_stock_threshold = patch.lowStockThreshold;
  if (patch.expiryAlertDays !== undefined) dbPatch.expiry_alert_days = patch.expiryAlertDays;
  const { error } = await supabase.from('alerts_config').update(dbPatch).eq('location_id', locId);
  if (error) throw error;
}

// ============================================================
// Warehouse -> Pharmacy stock transfers ("Pending Stock Requests")
//
// Shares the exact transfer_orders / transfer_order_items tables, the same
// Pending -> Completed / Rejected status vocabulary, and the same accept
// semantics as the VHC Mobile app's WarehouseContext.jsx
// (createPharmacyTransferRequest / approvePharmacyTransfer /
// cancelPharmacyTransfer) — no separate transfer system, no separate stock
// logic, no new tables. The Warehouse side creates the Pending row (this app
// never does); it changes NO stock. Only Accept moves stock, and it does so
// exactly once no matter which app calls it, because the very first write is
// an atomic `UPDATE transfer_orders ... WHERE status='Pending'` — if Mobile
// (or another Desktop session) already claimed the row, this update affects
// zero rows and Accept fails with a clean "already processed" error instead
// of moving stock a second time. batchEq mirrors WarehouseContext.jsx's own
// helper: a null/blank batch must match a NULL batch_no, not the string "".
// ============================================================

let mainWarehouseLocationId = null;
const locationNameCache = new Map();
let pendingTransfersCache = [];

function getPendingPharmacyTransfers() {
  return pendingTransfersCache.length ? pendingTransfersCache : cacheGet('pendingTransfers') || [];
}

function batchEq(query, batch) {
  return batch ? query.eq('batch_no', batch) : query.is('batch_no', null);
}

async function ensureMainWarehouseLocation() {
  if (mainWarehouseLocationId) return mainWarehouseLocationId;
  const { data, error } = await supabase.from('locations').select('id').eq('type', 'warehouse_main').limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('No location of type warehouse_main found.');
  mainWarehouseLocationId = data.id;
  return mainWarehouseLocationId;
}

async function getLocationName(id) {
  if (!id) return 'Warehouse';
  if (locationNameCache.has(id)) return locationNameCache.get(id);
  const { data } = await supabase.from('locations').select('name').eq('id', id).maybeSingle();
  const name = (data && data.name) || 'Warehouse';
  locationNameCache.set(id, name);
  return name;
}

async function fetchPendingPharmacyTransfers() {
  const locId = await ensurePharmacyLocation();
  const { data, error } = await supabase
    .from('transfer_orders')
    .select('*, transfer_order_items(*)')
    .eq('to_location_id', locId)
    .eq('status', 'Pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  const mapped = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    transferNumber: r.transfer_number,
    requestDate: r.transfer_date || r.created_at,
    createdAt: r.created_at,
    fromLocationId: r.from_location_id,
    fromLocationName: await getLocationName(r.from_location_id),
    notes: r.notes || '',
    status: r.status,
    items: (r.transfer_order_items || []).map((it) => ({
      id: it.id,
      itemId: it.item_id,
      name: it.name,
      batch: it.batch_no,
      expiry: it.expiry_date,
      qty: it.qty,
      mrp: it.mrp,
      netRate: it.net_rate,
      // Unit snapshot (same columns VHC Mobile writes): qty is in Main Stock strips; see accept_pharmacy_transfer.
      transferUnit: it.transfer_unit ?? null,
      unitsPerPack: it.units_per_pack ?? null,
    })),
  })));
  pendingTransfersCache = mapped;
  cacheSet('pendingTransfers', mapped);
  return mapped;
}

// Accept a Pending Warehouse -> Pharmacy request (see accept_pharmacy_transfer in
// supabase/migrations/20261022000100_stock_correction_rpcs.sql).
async function acceptPharmacyTransfer(transferId) {
  // One server transaction (accept_pharmacy_transfer, SECURITY INVOKER so the caller's existing RLS applies):
  // the order row is locked, every Main Stock batch is checked first, then the status change, both stock
  // updates and both TRANSFER movements (with created_by) commit together — or nothing changes and the
  // request stays Pending. A second accept (double click, another desktop, Mobile) sees it Completed.
  const { data, error } = await supabase.rpc('accept_pharmacy_transfer', { payload: { transfer_id: transferId } });
  if (error) {
    if (isRpcMissing(error)) throw stockRpcError('RPC_MISSING', 'The transfer server update (accept_pharmacy_transfer) is not installed yet. Nothing was transferred.');
    throw error;
  }
  if (!data || data.status !== 'APPLIED') throw stockRpcError((data && data.status) || 'UNKNOWN', describeStockStatus(data), data);
  await fetchInventory();
  return { ok: true, transferNumber: data.transfer_number };
}

// Reject a Pending request: atomically claim Pending -> Rejected. No stock is
// touched — nothing was reserved at request time. The row is kept as an audit
// record (never deleted). A reason, if given, is appended to the existing
// `notes` field rather than a new column — visible on both apps without a
// schema change.
async function rejectPharmacyTransfer(transferId, reason) {
  const { data: t } = await supabase.from('transfer_orders').select('id, status, notes').eq('id', transferId).maybeSingle();
  if (t && t.status !== 'Pending') throw new Error(`This request is already "${t.status}".`);

  const { data: claimed, error } = await supabase
    .from('transfer_orders')
    .update({ status: 'Rejected' })
    .eq('id', transferId).eq('status', 'Pending').select('id');
  if (error) throw error;
  if (!claimed || claimed.length === 0) {
    throw new Error('This request can no longer be rejected (it was already accepted or rejected).');
  }

  if (reason && reason.trim()) {
    const existingNotes = (t && t.notes) || '';
    const appended = existingNotes ? `${existingNotes}\n[Rejected by Pharmacy: ${reason.trim()}]` : `[Rejected by Pharmacy: ${reason.trim()}]`;
    try {
      await supabase.from('transfer_orders').update({ notes: appended }).eq('id', transferId);
    } catch (e) {
      console.error('[VHC_CLOUD] rejectPharmacyTransfer: appending reason to notes failed (reject itself already succeeded):', e?.message || e);
    }
  }
  return { ok: true };
}

// ============================================================
// Realtime — one channel, per-table diff handlers. Each event re-fetches
// only that one changed row's table slice (not a full reload) and notifies
// the React bundle via a DOM CustomEvent.
// ============================================================

let realtimeChannel = null;

async function startRealtime() {
  if (realtimeChannel) return;
  const locId = await ensurePharmacyLocation();

  realtimeChannel = supabase
    .channel('pharmacy-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_batches', filter: `location_id=eq.${locId}` }, async (payload) => {
      await fetchInventory();
      emit('stock_batches', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, async (payload) => {
      await fetchSalesHistory();
      emit('sales', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sale_items' }, async (payload) => {
      emit('sale_items', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, async (payload) => {
      await fetchPatients();
      emit('patients', payload.eventType, payload.new || payload.old);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts_config', filter: `location_id=eq.${locId}` }, (payload) => {
      emit('alerts_config', payload.eventType, payload.new || payload.old);
    })
    // No location filter — matches WarehouseContext.jsx's own unfiltered
    // transfer_orders subscription; Pending Stock Requests are filtered
    // server-side (to_location_id + status) inside fetchPendingPharmacyTransfers.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transfer_orders' }, async (payload) => {
      await fetchPendingPharmacyTransfers();
      emit('transfer_orders', payload.eventType, payload.new || payload.old);
    })
    .subscribe((status, err) => {
      window.__vhcRealtimeStatus = { status, err: err?.message };
    });
}

function getRealtimeState() {
  return { channelState: realtimeChannel?.state, lastStatus: window.__vhcRealtimeStatus };
}

async function stopRealtime() {
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ============================================================
// Bootstrap: load session + initial data on script load
// ============================================================

// One-time recovery net: if the cloud has no inventory yet but this device's
// local storage does (either genuinely pre-migration data, or data written by
// a backup restore from before restores were wired to push to the cloud —
// see restoreInventoryFromBackup), push it up automatically so it isn't
// silently invisible. Gated so it only ever runs once per install.
async function autoRecoverLocalInventoryIfNeeded() {
  const ALREADY_RAN_KEY = 'vhc_cloud_auto_recovered_v1';
  if (localStorage.getItem(ALREADY_RAN_KEY)) return;
  try {
    if (inventoryCache.length === 0) {
      const raw = localStorage.getItem('pos_inventory');
      const local = raw ? JSON.parse(raw) : [];
      if (Array.isArray(local) && local.length > 0) {
        assertCloudWritesAllowed('autoRecoverLocalInventoryIfNeeded');
        const result = await restoreInventoryFromBackup(local);
        if (result.failed > 0) {
          console.error('[VHC_CLOUD] auto-recovery had failures, will retry next launch:', result.errors);
          return; // leave the flag unset so a real fix can retry automatically
        }
      }
    }
    localStorage.setItem(ALREADY_RAN_KEY, new Date().toISOString());
  } catch (e) {
    console.error('[VHC_CLOUD] auto-recovery failed, will retry next launch:', e);
  }
}

async function init() {
  installEnvironmentIndicator();
  await getSession();
  // No session is a failure the caller must see and retry. It used to return silently, so the app opened without the
  // realtime subscription (the only thing that refreshes the screens when the cloud changes) and nothing retried.
  if (!currentSession) throw Object.assign(new Error('No authenticated cloud session yet (caller must sign in, or retry)'), { code: 'AUTH_SESSION_MISSING' });
  await ensurePharmacyLocation();
  // Realtime must not depend on every initial fetch succeeding: it is started even when one of them fails, and that
  // failure is reported afterwards so the caller retries. init() is safe to repeat (the fetches are reads; realtime and
  // the transfer poll start only once).
  const initial = await Promise.allSettled([
    fetchInventory(), fetchPatients(), fetchSalesHistory(),
    fetchPendingPharmacyTransfers().catch((e) => console.error('[VHC_CLOUD] initial fetchPendingPharmacyTransfers failed:', e?.message || e)),
  ]);
  // Only after a SUCCESSFUL inventory read: a failed read must never look like an empty cloud inventory.
  if (initial[0].status === 'fulfilled') await autoRecoverLocalInventoryIfNeeded();
  await startRealtime();
  // Belt-and-suspenders alongside the transfer_orders realtime subscription above: a
  // Warehouse -> Pharmacy request must never depend solely on realtime actually being
  // configured (the table only joined the Supabase realtime publication via a migration
  // dated the same day this feature shipped — see supabase/migrations/20260909000100_
  // transfer_orders_realtime.sql). If that migration is ever rolled back or hasn't reached
  // this environment yet, this 45s poll still satisfies "no manual refresh required."
  if (!window.__vhcTransferPollTimer) {
    window.__vhcTransferPollTimer = setInterval(() => {
      fetchPendingPharmacyTransfers().then(() => emit('transfer_orders', 'change', null))
        .catch((e) => console.error('[VHC_CLOUD] poll fetchPendingPharmacyTransfers failed:', e?.message || e));
    }, 45000);
  }
  const failedInitial = initial.find((r) => r.status === 'rejected');
  if (failedInitial) throw failedInitial.reason;
}

window.VHC_CLOUD = {
  getEnvironmentConfig: () => ({
    environmentName: CLOUD_CONFIG.environmentName,
    supabaseUrl: CLOUD_CONFIG.supabaseUrl,
    isProductionUrl: CLOUD_CONFIG.isProductionUrl,
    cloudWritesAllowed: CLOUD_CONFIG.cloudWritesAllowed,
    disabledReason: CLOUD_CONFIG.disabledReason,
  }),
  signIn: withErrorReport(signIn),
  // Strict: it already fails closed internally, and the Settings screen treats a rejection as
  // "not an admin" — wrapping it in an error report would add noise without changing the gate.
  isPlatformAdmin,
  getSession,
  getAuthBootstrap,
  checkReachability,
  signOut: withErrorReport(signOut),
  init: withErrorReport(init),

  getInventory,
  fetchInventory: withErrorReport(fetchInventory),
  addInventoryItem: withErrorReport(addInventoryItem),
  addInventoryItemsBulk: withErrorReport(addInventoryItemsBulk),
  restoreInventoryFromBackup: withErrorReport(restoreInventoryFromBackup),
  updateInventoryItem: withErrorReport(updateInventoryItem),
  manualStockReasonProblem,
  newStockRequestKey,
  adjustStockBulk: withErrorReport(adjustStockBulk),
  reconcileStockMovement: withErrorReport(reconcileStockMovement),
  reconcileStockMovementStrict: reconcileStockMovement,
  applyBillStockMovementStrict: applyBillStockMovement,
  applyBillStockMovementsStrict: applyBillStockMovements,
  findStockMovementsByKeysStrict: findStockMovementsByKeys,
  restoreBillStock,
  isCurrentUserAdmin,
  findStockMovementByKey: withErrorReport(findStockMovementByKey),
  findStockMovementByKeyStrict: findStockMovementByKey,
  deleteInventoryItem: withErrorReport(deleteInventoryItem),

  getAllPatients,
  findPatientsByName,
  fetchPatients: withErrorReport(fetchPatients),
  upsertPatientFromOPD: withErrorReport(upsertPatientFromOPD),
  restorePatientsFromBackup: withErrorReport(restorePatientsFromBackup),
  addManualPatient: withErrorReport(addManualPatient),
  mergeManualPatientInto: withErrorReport(mergeManualPatientInto),

  getSalesHistory,
  fetchSalesHistory: withErrorReport(fetchSalesHistory),
  createSale: withErrorReport(createSale),
  findSaleByBillId: withErrorReport(findSaleByBillId),
  createSaleStrict: createSale,
  findSaleByBillIdStrict: findSaleByBillId,
  // Strict variant only: a return must surface its own failure to the caller, never be
  // swallowed into a generic error report, so the UI can tell a rejection apart from a
  // not-yet-migrated project.
  createSaleReturn,
  // Strict read: the Return screen must know a lookup failed rather than show an empty bill.
  getSaleReturnEligibility,
  // Strict read: the Reports screen catches failures itself and falls back to local-only rows,
  // so an offline/odd-cloud state must not be swallowed into a generic error report here.
  getSaleReturnsForReports,
  describeCloudError,
  deleteSale: withErrorReport(deleteSale),
  deleteSaleByBillId: withErrorReport(deleteSaleByBillId),
  restoreSaleHistory: withErrorReport(restoreSaleHistory),

  getStockMovements: withErrorReport(getStockMovements),
  getAlertsConfig: withErrorReport(getAlertsConfig),
  updateAlertsConfig: withErrorReport(updateAlertsConfig),
  getRealtimeState,

  getPendingPharmacyTransfers,
  fetchPendingPharmacyTransfers: withErrorReport(fetchPendingPharmacyTransfers),
  acceptPharmacyTransfer: withErrorReport(acceptPharmacyTransfer),
  rejectPharmacyTransfer: withErrorReport(rejectPharmacyTransfer),
};
