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
  div.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:999999;background:#facc15;color:#111827;border:2px solid #92400e;border-radius:6px;padding:7px 10px;font:700 12px system-ui,-apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);';
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

// patch: { stock, reason, ... } — stock changes must carry a reason and are
// logged to stock_movements (type EDIT), same invariant vhc-audit-engine.js
// already enforces locally.
async function updateInventoryItem(id, patch, reason) {
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
  const stockChanged = patch.stock !== undefined && patch.stock !== current.stock;
  if (stockChanged) batchPatch.qty = patch.stock;

  if (Object.keys(batchPatch).length > 0) {
    const { error } = await supabase.from('stock_batches').update(batchPatch).eq('id', id);
    if (error) throw error;
  }

  if (stockChanged) {
    if (!reason || !reason.trim()) throw new Error('A reason is required for manual stock changes');
    await supabase.from('stock_movements').insert({
      item_id: current.itemId, location_id: await ensurePharmacyLocation(), batch_no: current.batch,
      type: 'EDIT', qty: patch.stock - current.stock, opening: current.stock, closing: patch.stock,
      reason: reason.trim(),
    });
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
          stock: parseInt(item.stock, 10) || 0,
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
  for (const d of deductions) {
    const current = inventoryCache.find((i) => i.id === d.id);
    if (!current) continue;
    const delta = parseFloat(d.qty) || 0;
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
  return results;
}

async function reconcileStockMovement(payload) {
  assertCloudWritesAllowed('reconcileStockMovement');
  const { data, error } = await supabase.rpc('reconcile_stock_movement', { payload });
  if (error) throw error;
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

async function deleteInventoryItem(id) {
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
    })),
  })));
  pendingTransfersCache = mapped;
  cacheSet('pendingTransfers', mapped);
  return mapped;
}

// Accept a Pending Warehouse -> Pharmacy request: live-check that Main Stock
// still has enough for every line, atomically claim the row (Pending ->
// Completed), then deduct Main Stock and add to Pharmacy, batch-matched, with
// a stock_movements ledger row per side. The status claim above is the sole
// guard against a double accept or a race with Mobile accepting first — safe
// to call from either app, or from two Desktop sessions, for the same request.
async function acceptPharmacyTransfer(transferId) {
  const pharmId = await ensurePharmacyLocation();
  const mainId = await ensureMainWarehouseLocation();

  const { data: t, error: readErr } = await supabase.from('transfer_orders').select('*, transfer_order_items(*)').eq('id', transferId).maybeSingle();
  if (readErr) throw readErr;
  if (!t) throw new Error('Request not found — refresh and try again.');
  if (t.status !== 'Pending') throw new Error(`This request is already "${t.status}".`);

  const lines = (t.transfer_order_items || []).filter((l) => (l.qty || 0) > 0);
  if (lines.length === 0) throw new Error('This request has no items to transfer.');

  const plan = [];
  for (const line of lines) {
    const { data: src, error: srcErr } = await batchEq(
      supabase.from('stock_batches').select('id, qty, gst, stockist, mrp, net_rate').eq('item_id', line.item_id).eq('location_id', mainId),
      line.batch_no,
    ).maybeSingle();
    if (srcErr) throw srcErr;
    if (!src || (src.qty || 0) < line.qty) {
      throw new Error(`Warehouse stock for "${line.name}" changed — only ${(src && src.qty) || 0} available (need ${line.qty}). Refresh and try again.`);
    }
    plan.push({ line, src });
  }

  const { data: claimed, error: claimErr } = await supabase
    .from('transfer_orders')
    .update({ status: 'Completed' })
    .eq('id', transferId).eq('status', 'Pending').select('id');
  if (claimErr) throw claimErr;
  if (!claimed || claimed.length === 0) {
    throw new Error('This request was already accepted or rejected.');
  }

  const problems = [];
  for (const { line, src } of plan) {
    try {
      const qty = line.qty;
      const { data: srcUpd, error: srcUpdErr } = await supabase
        .from('stock_batches').update({ qty: Math.max(0, (src.qty || 0) - qty) })
        .eq('id', src.id).eq('qty', src.qty).select('id');
      if (srcUpdErr) throw srcUpdErr;
      if (!srcUpd || srcUpd.length === 0) throw new Error('Warehouse stock changed during accept — this line needs manual review.');
      await supabase.from('stock_movements').insert({
        item_id: line.item_id, location_id: mainId, batch_no: line.batch_no,
        type: 'TRANSFER', qty: -qty, opening: src.qty, closing: Math.max(0, (src.qty || 0) - qty),
        reason: `Pharmacy transfer ${t.transfer_number} accepted (out of Main Stock)`,
      });

      const { data: destRow } = await batchEq(
        supabase.from('stock_batches').select('id, qty').eq('item_id', line.item_id).eq('location_id', pharmId),
        line.batch_no,
      ).maybeSingle();
      if (destRow) {
        const before = destRow.qty || 0;
        const { data: bumped, error: bumpErr } = await supabase
          .from('stock_batches').update({ qty: before + qty }).eq('id', destRow.id).eq('qty', before).select('id');
        if (bumpErr) throw bumpErr;
        if (!bumped || bumped.length === 0) throw new Error('Pharmacy stock changed during accept — this line needs manual review.');
        await supabase.from('stock_movements').insert({
          item_id: line.item_id, location_id: pharmId, batch_no: line.batch_no,
          type: 'TRANSFER', qty, opening: before, closing: before + qty,
          reason: `Pharmacy transfer ${t.transfer_number} accepted (into Pharmacy)`,
        });
      } else {
        const { error: insErr } = await supabase.from('stock_batches').insert({
          item_id: line.item_id, location_id: pharmId, batch_no: line.batch_no || null,
          expiry_date: line.expiry_date || null, mrp: line.mrp ?? null, net_rate: line.net_rate ?? null,
          gst: src.gst ?? null, stockist: src.stockist ?? null, qty,
        });
        if (insErr) throw insErr;
        await supabase.from('stock_movements').insert({
          item_id: line.item_id, location_id: pharmId, batch_no: line.batch_no,
          type: 'TRANSFER', qty, opening: 0, closing: qty,
          reason: `Pharmacy transfer ${t.transfer_number} accepted (into Pharmacy, new batch)`,
        });
      }
    } catch (e) {
      problems.push(`${line.name}: ${e.message || e}`);
    }
  }

  await fetchInventory();
  if (problems.length) {
    throw new Error(`Request marked Completed, but some lines need checking:\n${problems.join('\n')}`);
  }
  return { ok: true, transferNumber: t.transfer_number };
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
  if (!currentSession) return; // caller must signIn() first
  await ensurePharmacyLocation();
  await Promise.all([
    fetchInventory(), fetchPatients(), fetchSalesHistory(),
    fetchPendingPharmacyTransfers().catch((e) => console.error('[VHC_CLOUD] initial fetchPendingPharmacyTransfers failed:', e?.message || e)),
  ]);
  await autoRecoverLocalInventoryIfNeeded();
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
  adjustStockBulk: withErrorReport(adjustStockBulk),
  reconcileStockMovement: withErrorReport(reconcileStockMovement),
  reconcileStockMovementStrict: reconcileStockMovement,
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
