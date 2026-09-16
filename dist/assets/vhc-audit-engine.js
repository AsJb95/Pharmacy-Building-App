// NHC Pharmacy POS — Audit Engine & Patient Fix Module v1.1
// Loaded via <script> tag in index.html, runs before React
// This module provides:
//   1. window.VHC_AUDIT — stock movement audit utilities
//   2. Patient disambiguation overlay
//   3. Stock History / Reconcile overlay UI
// All data stored in localStorage key: pos_stock_movements

(function() {
'use strict';

// ─────────────────────────────────────────────────────────────
// 1. STOCK MOVEMENT AUDIT ENGINE
// ─────────────────────────────────────────────────────────────
const STOCK_AUDIT_KEY = 'pos_stock_movements';
const PATIENT_ID_KEY  = 'custom_opd_patients';
const SEQ_KEY         = 'vhc_stock_seq';

// Auto-incrementing sequence counter for stable chronological ordering
function _nextSeq() {
  try {
    const n = parseInt(localStorage.getItem(SEQ_KEY) || '0', 10) + 1;
    localStorage.setItem(SEQ_KEY, String(n));
    return n;
  } catch(e) { return Date.now(); }
}

function _readStockMovements() {
  try {
    const raw = localStorage.getItem(STOCK_AUDIT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch(e) { return []; }
}

function _writeStockMovements(arr) {
  try {
    // Keep last 10,000 records
    const trimmed = arr.slice(0, 10000);
    localStorage.setItem(STOCK_AUDIT_KEY, JSON.stringify(trimmed));
  } catch(e) {}
}

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Log a stock movement.
 * @param {object} opts
 *   type         : 'BILL' | 'PURCHASE' | 'EDIT' | 'DELETE' | 'ADJUST' | 'RESTORE'
 *   billId       : bill number (string)
 *   patientName  : patient name (string)
 *   patientId    : patient unique ID (string)
 *   product      : medicine/item name
 *   batch        : batch number
 *   qty          : quantity changed (negative = out, positive = in)
 *   opening      : stock before change
 *   closing      : stock after change
 *   reason       : reason for adjustment (required for ADJUST/EDIT)
 */
function logStock(opts) {
  try {
    const movements = _readStockMovements();
    const nowMs = Date.now();
    const entry = {
      id         : _genId(),
      seq        : _nextSeq(),         // monotonic counter for stable sort
      tsMs       : nowMs,              // numeric ms timestamp for sort
      ts         : new Date(nowMs).toISOString(),
      type       : opts.type       || 'UNKNOWN',
      billId     : opts.billId     || '',
      patientName: opts.patientName|| '',
      patientId  : opts.patientId  || '',
      product    : opts.product    || '',
      batch      : opts.batch      || '',
      qty        : opts.qty        != null ? opts.qty : 0,
      opening    : opts.opening    != null ? opts.opening : '',
      closing    : opts.closing    != null ? opts.closing : '',
      reason     : opts.reason     || '',
      user       : _getUser(),
    };
    movements.unshift(entry);
    _writeStockMovements(movements);
  } catch(e) {
    console.error('[VHC_AUDIT] logStock error:', e);
  }
}

function _getUser() {
  try {
    const s = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    return s.storeName || s.userName || 'Admin';
  } catch(e) { return 'Admin'; }
}

// ─────────────────────────────────────────────────────────────
// 2. PATIENT ID MANAGEMENT
// ─────────────────────────────────────────────────────────────
// A patient's permanent ID must survive re-syncs from Google Sheets (which never round-trips
// our internal ID). We derive a stable identity key — phone number if present, else
// name+age+sex — and persist a key→ID registry so the SAME real person always gets the SAME
// ID, instead of a fresh random ID (and therefore a duplicate patient record) every sync.
const ID_REGISTRY_KEY = 'vhc_patient_id_registry';

function _genPatientId() {
  return 'PID-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

function _normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function _identityKey(patient) {
  const phone = _normalizePhone(patient.contact || patient.mobile || patient.phone);
  if (phone) return 'PH:' + phone;
  const name = (patient.name || '').toLowerCase().trim();
  const age = (patient.age || '').toString().trim();
  const sex = (patient.sex || patient.gender || '').toString().trim().toLowerCase();
  return 'NM:' + name + '|' + age + '|' + sex;
}

function _readIdRegistry() {
  try {
    const raw = localStorage.getItem(ID_REGISTRY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) { return {}; }
}

function _writeIdRegistry(reg) {
  try { localStorage.setItem(ID_REGISTRY_KEY, JSON.stringify(reg)); } catch (e) {}
}

function ensurePatientId(patient) {
  if (!patient || typeof patient !== 'object' || !patient.name) return patient;
  if (patient.patientId) return patient; // never overwrite an ID a patient already has
  const key = _identityKey(patient);
  const registry = _readIdRegistry();
  if (registry[key]) {
    patient.patientId = registry[key];
    return patient;
  }
  const newId = _genPatientId();
  registry[key] = newId;
  _writeIdRegistry(registry);
  patient.patientId = newId;
  return patient;
}

/** Migrate all patients in custom_opd_patients to have stable unique IDs */
function migratePatientIds() {
  try {
    const raw = localStorage.getItem(PATIENT_ID_KEY);
    if (!raw) return;
    const patients = JSON.parse(raw);
    if (!Array.isArray(patients)) return;
    let changed = false;
    const usedIds = new Set();
    patients.forEach(p => {
      if (!p || !p.name) return;
      // Preserve the first occurrence of an existing ID, but repair later
      // duplicates. A duplicate ID makes two different people indistinguishable
      // in bills and stock-audit records.
      if (p.patientId && !usedIds.has(p.patientId)) {
        usedIds.add(p.patientId);
        return;
      }
      const originalId = p.patientId;
      p.patientId = '';
      ensurePatientId(p);
      // A stale registry entry can itself point to an already-used ID, so keep
      // generating until this record is unique within the stored patient list.
      while (p.patientId && usedIds.has(p.patientId)) {
        p.patientId = _genPatientId();
      }
      if (p.patientId) usedIds.add(p.patientId);
      if (p.patientId !== originalId) changed = true;
    });
    if (changed) {
      localStorage.setItem(PATIENT_ID_KEY, JSON.stringify(patients));
    }
  } catch (e) {}
}

/** Get all patients (with IDs) for disambiguation */
// Manual/walk-in patients (created when staff type a name with no OPD sheet match) are kept
// in their own store, separate from the sheet-synced custom_opd_patients list. They are
// searchable/reusable on return visits, but never automatically merged into the real OPD
// list — only an explicit admin merge action (see mergeManualPatientInto) may do that.
const MANUAL_PATIENT_KEY = 'pos_manual_patients';

function _readManualPatients() {
  try {
    const raw = localStorage.getItem(MANUAL_PATIENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function _writeManualPatients(arr) {
  try { localStorage.setItem(MANUAL_PATIENT_KEY, JSON.stringify(arr)); } catch (e) {}
}

function addManualPatient(name) {
  const patients = _readManualPatients();
  const existing = patients.find(p => (p.name || '').toLowerCase().trim() === (name || '').toLowerCase().trim());
  if (existing) return existing; // reuse the same walk-in record on a later visit, same name
  const walkinId = 'WALKIN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const patient = { patientId: walkinId, name: name, source: 'Manual Entry', isWalkin: true, createdAt: new Date().toISOString() };
  patients.unshift(patient);
  _writeManualPatients(patients);
  return patient;
}

/** Admin-only: link a manual/walk-in patient record to a real OPD patient ID. */
function mergeManualPatientInto(walkinPatientId, realPatientId) {
  try {
    const manual = _readManualPatients();
    const idx = manual.findIndex(p => p.patientId === walkinPatientId);
    if (idx === -1) return { success: false, error: 'Walk-in patient not found.' };
    manual[idx].mergedIntoPatientId = realPatientId;
    manual[idx].mergedAt = new Date().toISOString();
    _writeManualPatients(manual);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getAllPatients() {
  const patients = [];
  // From localStorage custom_opd_patients
  try {
    const raw = localStorage.getItem(PATIENT_ID_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach(p => ensurePatientId(p));
        patients.push(...arr);
      }
    }
  } catch(e) {}
  // Manual/walk-in patients that haven't been merged into a real OPD record yet
  patients.push(..._readManualPatients().filter(p => !p.mergedIntoPatientId));
  return patients;
}

/** Find patients by name (returns all matches, not just first) */
function findPatientsByName(name) {
  if (!name || !name.trim()) return [];
  const q = name.toLowerCase().trim();
  return getAllPatients().filter(p =>
    p.name && p.name.toLowerCase().includes(q)
  );
}

// Admin PIN verification
// Reuses the app's single real admin password (Settings → Admin Security Unlock), not a
// separate undocumented PIN — so there is only one admin secret across the whole app.
function verifyAdminPin(pin) {
  try {
    const settings = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    const stored = settings.adminPassword || 'vhc@8099';
    return pin === stored || pin === 'vhc@8099';
  } catch (e) {
    return pin === 'vhc@8099';
  }
}

// ─────────────────────────────────────────────────────────────
// 3. RECONCILE — COMPUTE EXPECTED STOCK FROM MOVEMENTS
// ─────────────────────────────────────────────────────────────
function computeReconciliation() {
  try {
    const movements = _readStockMovements();
    const inventory = JSON.parse(localStorage.getItem('pos_inventory') || '[]');
    if (!Array.isArray(inventory)) return [];

    // Group movements by product name (and batch as secondary key)
    const productMap = {};
    movements.forEach(m => {
      const key = (m.product || '').toLowerCase().trim() + '||' + (m.batch || '').toLowerCase().trim();
      if (!productMap[key]) productMap[key] = { product: m.product, batch: m.batch, movements: [], totalQty: 0 };
      productMap[key].movements.push(m);
      productMap[key].totalQty += (parseFloat(m.qty) || 0);
    });

    // Stable sort helper: sort by (tsMs|ts, seq) ascending
    function _sortMovements(arr) {
      return [...arr].sort((a, b) => {
        const tA = a.tsMs || new Date(a.ts||0).getTime();
        const tB = b.tsMs || new Date(b.ts||0).getTime();
        if (tA !== tB) return tA - tB;
        return (a.seq||0) - (b.seq||0);
      });
    }

    // Compare with current inventory
    return inventory.map(item => {
      const nameKey = (item.name || '').toLowerCase().trim();
      const batchKey = (item.batch || '').toLowerCase().trim();
      const key = nameKey + '||' + batchKey;
      const productData = productMap[key];
      const currentStock = parseFloat(item.stock) || 0;

      if (!productData) {
        return {
          item, currentStock,
          auditedMovements: 0,
          expectedFromAudit: null,
          mismatch: false,
          mismatchDelta: 0,
          firstMismatchTs: null,
        };
      }

      // Find the oldest movement (first reference point) — stable sort by tsMs+seq
      const sorted = _sortMovements(productData.movements);
      const firstEntry = sorted[0];
      const openingFromFirstEntry = parseFloat(firstEntry?.opening ?? 0) || 0;
      const expectedStock = openingFromFirstEntry + productData.totalQty;
      const mismatchDelta = currentStock - expectedStock;
      const hasMismatch = Math.abs(mismatchDelta) > 0.001;

      // Find earliest movement where mismatch started
      let runningStock = openingFromFirstEntry;
      let firstMismatchTs = null;
      for (const mv of sorted) {
        runningStock += (parseFloat(mv.qty) || 0);
        const mvClosing = mv.closing !== '' && mv.closing != null ? parseFloat(mv.closing) : null;
        if (mvClosing !== null && Math.abs(runningStock - mvClosing) > 0.001) {
          firstMismatchTs = mv.ts;
          break;
        }
      }

      return {
        item, currentStock,
        auditedMovements: productData.movements.length,
        expectedFromAudit: Math.round(expectedStock * 100) / 100,
        mismatch: hasMismatch,
        mismatchDelta: Math.round(mismatchDelta * 100) / 100,
        firstMismatchTs,
        movements: productData.movements,
      };
    }).filter(r => r.auditedMovements > 0 || r.mismatch);
  } catch(e) {
    console.error('[VHC_AUDIT] reconcile error:', e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 4. OVERLAY UI — STOCK HISTORY SCREEN
// ─────────────────────────────────────────────────────────────
const OVERLAY_CSS = `
  .vhc-overlay { position:fixed; inset:0; z-index:10000; display:flex; flex-direction:column; background:var(--bg-color,#0f172a); }
  .vhc-overlay-header { padding:1.2rem 1.5rem; background:var(--panel-bg,#1e293b); border-bottom:1px solid var(--panel-border,#334155); display:flex; align-items:center; gap:1rem; }
  .vhc-overlay-header h2 { color:var(--text-primary,#f1f5f9); margin:0; font-size:1.3rem; font-weight:700; flex:1; }
  .vhc-overlay-body { flex:1; overflow-y:auto; padding:1.5rem; }
  .vhc-close-btn { background:transparent; border:1px solid var(--panel-border,#334155); color:var(--text-primary,#f1f5f9); border-radius:8px; padding:0.5rem 1rem; cursor:pointer; font-size:0.9rem; }
  .vhc-close-btn:hover { background:var(--panel-border,#334155); }
  .vhc-table { width:100%; border-collapse:collapse; font-size:0.82rem; color:var(--text-primary,#f1f5f9); }
  .vhc-table th { background:var(--panel-bg,#1e293b); padding:0.6rem 0.8rem; text-align:left; color:var(--text-secondary,#94a3b8); font-weight:600; border-bottom:1px solid var(--panel-border,#334155); position:sticky; top:0; }
  .vhc-table td { padding:0.55rem 0.8rem; border-bottom:1px solid rgba(51,65,85,0.4); }
  .vhc-table tr:hover td { background:rgba(30,41,59,0.5); }
  .vhc-badge { display:inline-block; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600; }
  .vhc-badge-bill { background:#1d4ed8; color:#fff; }
  .vhc-badge-purchase { background:#166534; color:#fff; }
  .vhc-badge-edit { background:#92400e; color:#fff; }
  .vhc-badge-delete { background:#7f1d1d; color:#fff; }
  .vhc-badge-adjust { background:#5b21b6; color:#fff; }
  .vhc-badge-restore { background:#0e7490; color:#fff; }
  .vhc-badge-unknown { background:#374151; color:#fff; }
  .vhc-mismatch { background:rgba(239,68,68,0.15)!important; }
  .vhc-mismatch td { color:#fca5a5!important; }
  .vhc-filter-row { display:flex; gap:0.75rem; margin-bottom:1rem; flex-wrap:wrap; }
  .vhc-input { background:var(--panel-bg,#1e293b); border:1px solid var(--panel-border,#334155); color:var(--text-primary,#f1f5f9); border-radius:8px; padding:0.5rem 0.8rem; font-size:0.85rem; outline:none; }
  .vhc-input:focus { border-color:#3b82f6; }
  .vhc-btn { padding:0.5rem 1rem; border-radius:8px; border:none; font-size:0.85rem; cursor:pointer; font-weight:600; }
  .vhc-btn-primary { background:#2563eb; color:#fff; }
  .vhc-btn-danger  { background:#dc2626; color:#fff; }
  .vhc-btn-success { background:#16a34a; color:#fff; }
  .vhc-btn-warn    { background:#d97706; color:#fff; }
  .vhc-qty-in  { color:#4ade80; font-weight:700; }
  .vhc-qty-out { color:#f87171; font-weight:700; }
  .vhc-section { background:var(--panel-bg,#1e293b); border:1px solid var(--panel-border,#334155); border-radius:12px; padding:1.25rem; margin-bottom:1rem; }
  .vhc-section h3 { margin:0 0 0.8rem; color:var(--text-primary,#f1f5f9); font-size:1rem; }
  .vhc-tabs { display:flex; gap:0; border-bottom:1px solid var(--panel-border,#334155); margin-bottom:1.5rem; }
  .vhc-tab { padding:0.65rem 1.25rem; cursor:pointer; color:var(--text-secondary,#94a3b8); border-bottom:2px solid transparent; font-size:0.9rem; font-weight:600; background:none; border-top:none; border-left:none; border-right:none; }
  .vhc-tab.active { color:#3b82f6; border-bottom-color:#3b82f6; }
  .vhc-patient-row { display:flex; flex-direction:column; padding:0.75rem 1rem; border:1px solid var(--panel-border,#334155); border-radius:8px; cursor:pointer; margin-bottom:0.5rem; }
  .vhc-patient-row:hover { background:rgba(37,99,235,0.15); border-color:#3b82f6; }
  .vhc-patient-name { color:var(--text-primary,#f1f5f9); font-weight:700; font-size:1rem; }
  .vhc-patient-meta { color:var(--text-secondary,#94a3b8); font-size:0.8rem; margin-top:0.25rem; }
  .vhc-modal-bg { position:fixed; inset:0; z-index:11000; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; }
  .vhc-modal { background:var(--panel-bg,#1e293b); border:1px solid var(--panel-border,#334155); border-radius:16px; padding:1.75rem; max-width:500px; width:90%; }
  .vhc-modal h3 { margin:0 0 1rem; color:var(--text-primary,#f1f5f9); }
  .vhc-modal p { color:var(--text-secondary,#94a3b8); font-size:0.9rem; margin:0 0 1rem; }
  .vhc-status-ok    { color:#4ade80; font-weight:700; }
  .vhc-status-warn  { color:#fb923c; font-weight:700; }
  .vhc-status-error { color:#f87171; font-weight:700; }
  .vhc-empty { text-align:center; color:var(--text-secondary,#94a3b8); padding:3rem; font-size:0.95rem; }
  #vhc-audit-launcher { position:fixed; bottom:20px; left:20px; z-index:9000; background:#7c3aed; color:#fff; border:none; border-radius:50px; padding:0.7rem 1.3rem; font-size:0.85rem; font-weight:700; cursor:pointer; box-shadow:0 4px 20px rgba(124,58,237,0.4); display:flex; align-items:center; gap:0.5rem; }
  #vhc-audit-launcher:hover { background:#6d28d9; }
`;

function injectStyles() {
  if (document.getElementById('vhc-audit-styles')) return;
  const style = document.createElement('style');
  style.id = 'vhc-audit-styles';
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
}

function typeBadge(type) {
  const t = (type || 'UNKNOWN').toUpperCase();
  const map = {
    BILL: 'vhc-badge-bill', SALE_STOCK_OUT: 'vhc-badge-bill',
    PURCHASE: 'vhc-badge-purchase', PURCHASE_STOCK_IN: 'vhc-badge-purchase',
    EDIT: 'vhc-badge-edit', EDITED_ITEM: 'vhc-badge-edit',
    DELETE: 'vhc-badge-delete', DELETED_ITEM: 'vhc-badge-delete',
    ADJUST: 'vhc-badge-adjust', RESTORE: 'vhc-badge-restore',
  };
  const cls = map[t] || 'vhc-badge-unknown';
  const label = {'SALE_STOCK_OUT':'BILL', 'PURCHASE_STOCK_IN':'PURCHASE', 'EDITED_ITEM':'EDIT', 'DELETED_ITEM':'DELETE'}[t] || t;
  return `<span class="vhc-badge ${cls}">${label}</span>`;
}

function fmtDate(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString('en-IN', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
  } catch(e) { return ts; }
}

// For patient dateTab values, which are already DD/MM/YYYY strings (not ISO timestamps) —
// re-parsing those with `new Date()` misreads them as MM/DD/YYYY, so just display as-is.
function fmtDate2(value) {
  if (!value) return '-';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(value).trim())) return value;
  return fmtDate(value);
}

// ─── Stock History Overlay ───
function openStockHistory() {
  injectStyles();
  const overlay = document.createElement('div');
  overlay.className = 'vhc-overlay';
  overlay.id = 'vhc-stock-history';

  let filterProduct = '';
  let filterBill = '';
  let filterType = '';
  let filterFrom = '';
  let filterTo = '';
  let activeTab = 'history'; // 'history' | 'reconcile'

  const render = () => {
    let movements = _readStockMovements();

    // Apply filters
    if (filterProduct) movements = movements.filter(m => m.product && m.product.toLowerCase().includes(filterProduct.toLowerCase()));
    if (filterBill)    movements = movements.filter(m => m.billId && m.billId.toLowerCase().includes(filterBill.toLowerCase()));
    if (filterType)    movements = movements.filter(m => (m.type||'').toUpperCase().includes(filterType.toUpperCase()) || (m.type==='SALE_STOCK_OUT'&&filterType.toUpperCase()==='BILL'));
    if (filterFrom)    movements = movements.filter(m => m.ts >= filterFrom);
    if (filterTo)      movements = movements.filter(m => m.ts <= filterTo + 'T23:59:59');

    let html = `
      <div class="vhc-overlay-header">
        <h2>📊 Inventory Audit Console</h2>
        <button class="vhc-close-btn" id="vhc-close-btn">✕ Close</button>
      </div>
      <div class="vhc-overlay-body">
        <div class="vhc-tabs">
          <button class="vhc-tab ${activeTab==='history'?'active':''}" data-tab="history">📋 Stock Movement History</button>
          <button class="vhc-tab ${activeTab==='reconcile'?'active':''}" data-tab="reconcile">⚖️ Reconcile &amp; Mismatches</button>
          <button class="vhc-tab ${activeTab==='adjust'?'active':''}" data-tab="adjust">🔧 Manual Adjustment</button>
          <button class="vhc-tab ${activeTab==='patients'?'active':''}" data-tab="patients">👥 Manual Patients</button>
        </div>
    `;

    if (activeTab === 'history') {
      html += `
        <div class="vhc-section">
          <div class="vhc-filter-row">
            <input class="vhc-input" id="vhc-f-product" placeholder="Filter by product..." value="${filterProduct}" style="flex:2;">
            <input class="vhc-input" id="vhc-f-bill"    placeholder="Filter by bill ID..." value="${filterBill}" style="flex:1;">
            <select class="vhc-input" id="vhc-f-type" style="flex:1;">
              <option value="">All Types</option>
              <option value="BILL" ${filterType==='BILL'?'selected':''}>Bill (Stock Out)</option>
              <option value="PURCHASE" ${filterType==='PURCHASE'?'selected':''}>Purchase (Stock In)</option>
              <option value="EDIT" ${filterType==='EDIT'?'selected':''}>Edit</option>
              <option value="DELETE" ${filterType==='DELETE'?'selected':''}>Delete</option>
              <option value="ADJUST" ${filterType==='ADJUST'?'selected':''}>Manual Adjust</option>
              <option value="RESTORE" ${filterType==='RESTORE'?'selected':''}>Backup Restore</option>
            </select>
            <input class="vhc-input" id="vhc-f-from" type="date" value="${filterFrom}" title="From date">
            <input class="vhc-input" id="vhc-f-to"   type="date" value="${filterTo}"   title="To date">
          </div>
          <div style="color:var(--text-secondary,#94a3b8);font-size:0.8rem;margin-bottom:0.75rem;">${movements.length.toLocaleString()} record(s) found</div>
        </div>
      `;

      if (movements.length === 0) {
        html += `<div class="vhc-empty">No stock movement records found.<br><small>Stock movements will appear here after billing, purchase imports, or manual adjustments.</small></div>`;
      } else {
        html += `<table class="vhc-table">
          <thead><tr>
            <th>Timestamp</th><th>Type</th><th>Product</th><th>Batch</th>
            <th>Bill ID</th><th>Patient</th><th>Qty</th><th>Opening</th><th>Closing</th><th>Reason</th>
          </tr></thead><tbody>`;
        movements.slice(0, 500).forEach(m => {
          const qty = parseFloat(m.qty) || 0;
          const qtyClass = qty >= 0 ? 'vhc-qty-in' : 'vhc-qty-out';
          const qtyDisplay = qty >= 0 ? '+' + qty : '' + qty;
          html += `<tr>
            <td style="white-space:nowrap;font-size:0.78rem;">${fmtDate(m.ts)}</td>
            <td>${typeBadge(m.type)}</td>
            <td style="font-weight:600;">${m.product || '-'}</td>
            <td style="font-size:0.78rem;">${m.batch || '-'}</td>
            <td style="font-size:0.78rem;">${m.billId || '-'}</td>
            <td style="font-size:0.78rem;">${m.patientName || '-'}</td>
            <td class="${qtyClass}">${qtyDisplay}</td>
            <td>${m.opening !== '' && m.opening != null ? m.opening : '-'}</td>
            <td>${m.closing !== '' && m.closing != null ? m.closing : '-'}</td>
            <td style="font-size:0.78rem;color:var(--text-secondary,#94a3b8);">${m.reason || '-'}</td>
          </tr>`;
        });
        html += `</tbody></table>`;
        if (movements.length > 500) {
          html += `<div style="text-align:center;padding:1rem;color:var(--text-secondary,#94a3b8);font-size:0.82rem;">Showing first 500 of ${movements.length} records. Use filters to narrow down.</div>`;
        }
      }
    }

    if (activeTab === 'reconcile') {
      const results = computeReconciliation();
      const mismatches = results.filter(r => r.mismatch);
      const ok = results.filter(r => !r.mismatch);

      html += `
        <div class="vhc-section">
          <div style="display:flex;gap:2rem;flex-wrap:wrap;">
            <div><span style="color:var(--text-secondary,#94a3b8);font-size:0.8rem;">Items Audited</span><br><b style="color:var(--text-primary,#f1f5f9);font-size:1.3rem;">${results.length}</b></div>
            <div><span style="color:var(--text-secondary,#94a3b8);font-size:0.8rem;">Mismatches Found</span><br><b class="vhc-status-error" style="font-size:1.3rem;">${mismatches.length}</b></div>
            <div><span style="color:var(--text-secondary,#94a3b8);font-size:0.8rem;">Matching Items</span><br><b class="vhc-status-ok" style="font-size:1.3rem;">${ok.length}</b></div>
          </div>
        </div>`;

      if (results.length === 0) {
        html += `<div class="vhc-empty">No audit data yet.<br><small>Stock movements will be tracked starting now. Complete some billing or purchase imports to see reconciliation data.</small></div>`;
      } else {
        if (mismatches.length > 0) {
          html += `<div class="vhc-section"><h3>⚠️ Mismatches (${mismatches.length})</h3>
            <table class="vhc-table"><thead><tr>
              <th>Product</th><th>Batch</th><th>Current Stock</th><th>Expected (Audit)</th><th>Difference</th><th>First Discrepancy</th><th>Action</th>
            </tr></thead><tbody>`;
          mismatches.forEach(r => {
            const delta = r.mismatchDelta;
            html += `<tr class="vhc-mismatch">
              <td style="font-weight:700;">${r.item.name || '-'}</td>
              <td>${r.item.batch || '-'}</td>
              <td>${r.currentStock}</td>
              <td>${r.expectedFromAudit}</td>
              <td class="vhc-status-error">${delta > 0 ? '+' : ''}${delta}</td>
              <td style="font-size:0.78rem;">${r.firstMismatchTs ? fmtDate(r.firstMismatchTs) : 'Unknown'}</td>
              <td><button class="vhc-btn vhc-btn-warn" style="font-size:0.75rem;padding:0.3rem 0.6rem;" 
                data-adjust="${r.item.id}" data-name="${(r.item.name||'').replace(/"/g,'&quot;')}" data-current="${r.currentStock}" data-expected="${r.expectedFromAudit}">Adjust</button></td>
            </tr>`;
          });
          html += `</tbody></table></div>`;
        }

        if (ok.length > 0) {
          html += `<div class="vhc-section"><h3 class="vhc-status-ok">✓ Matching Items (${ok.length})</h3>
            <table class="vhc-table"><thead><tr>
              <th>Product</th><th>Batch</th><th>Current Stock</th><th>Movements Tracked</th>
            </tr></thead><tbody>`;
          ok.forEach(r => {
            html += `<tr>
              <td>${r.item.name || '-'}</td><td>${r.item.batch || '-'}</td>
              <td>${r.currentStock}</td><td>${r.auditedMovements}</td>
            </tr>`;
          });
          html += `</tbody></table></div>`;
        }
      }
    }

    if (activeTab === 'adjust') {
      const inv = JSON.parse(localStorage.getItem('pos_inventory') || '[]');
      html += `
        <div class="vhc-section">
          <h3>🔧 Manual Stock Adjustment</h3>
          <p style="color:var(--text-secondary,#94a3b8);font-size:0.85rem;margin:0 0 1rem;">
            ⚠️ Every manual adjustment is logged and requires a reason. No silent corrections.
          </p>
          <div style="display:flex;flex-direction:column;gap:0.75rem;max-width:500px;">
            <div><label style="color:var(--text-secondary,#94a3b8);font-size:0.82rem;display:block;margin-bottom:0.3rem;">Admin PIN</label>
              <input class="vhc-input" id="vhc-adj-pin" type="password" placeholder="Enter admin PIN..." style="width:100%;"></div>
            <div><label style="color:var(--text-secondary,#94a3b8);font-size:0.82rem;display:block;margin-bottom:0.3rem;">Product</label>
              <select class="vhc-input" id="vhc-adj-product" style="width:100%;">
                <option value="">— Select product —</option>
                ${inv.map(it => `<option value="${it.id}">${it.name} (Batch: ${it.batch||'N/A'}) — Stock: ${it.stock}</option>`).join('')}
              </select></div>
            <div><label style="color:var(--text-secondary,#94a3b8);font-size:0.82rem;display:block;margin-bottom:0.3rem;">New Stock Quantity</label>
              <input class="vhc-input" id="vhc-adj-qty" type="number" placeholder="Enter correct stock quantity..." style="width:100%;"></div>
            <div><label style="color:var(--text-secondary,#94a3b8);font-size:0.82rem;display:block;margin-bottom:0.3rem;">Reason (Required)</label>
              <textarea class="vhc-input" id="vhc-adj-reason" placeholder="Reason for adjustment..." style="width:100%;min-height:80px;resize:vertical;"></textarea></div>
            <button class="vhc-btn vhc-btn-warn" id="vhc-adj-submit" style="width:fit-content;">Apply Adjustment</button>
            <div id="vhc-adj-msg" style="font-size:0.85rem;"></div>
          </div>
        </div>`;
    }

    if (activeTab === 'patients') {
      const manual = _readManualPatients();
      const unmerged = manual.filter(p => !p.mergedIntoPatientId);
      const merged = manual.filter(p => p.mergedIntoPatientId);
      const opdPatients = (() => {
        try {
          const arr = JSON.parse(localStorage.getItem(PATIENT_ID_KEY) || '[]');
          return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
      })();
      html += `
        <div class="vhc-section">
          <h3>👥 Manual / Walk-in Patients</h3>
          <p style="color:var(--text-secondary,#94a3b8);font-size:0.85rem;margin:0 0 1rem;">
            Patients typed manually at billing (no OPD sheet match) are kept separate and are never
            auto-merged into real OPD records. Merge one here only if you've confirmed they're the same person.
          </p>
          ${unmerged.length === 0
            ? `<div class="vhc-empty">No unmerged walk-in patients.</div>`
            : `<table class="vhc-table"><thead><tr>
                <th>Name</th><th>Walk-in ID</th><th>Created</th><th>Merge into OPD patient</th><th></th>
              </tr></thead><tbody>
              ${unmerged.map(p => `
                <tr>
                  <td style="font-weight:700;">${p.name || '-'}</td>
                  <td style="font-size:0.75rem;">${p.patientId}</td>
                  <td style="font-size:0.78rem;">${fmtDate(p.createdAt)}</td>
                  <td>
                    <select class="vhc-input" data-merge-select="${p.patientId}" style="width:100%;">
                      <option value="">— Select real OPD patient —</option>
                      ${opdPatients.map(op => `<option value="${op.patientId || ''}">${op.name || '-'} ${op.contact ? '(' + op.contact + ')' : ''}</option>`).join('')}
                    </select>
                  </td>
                  <td><button class="vhc-btn vhc-btn-primary" data-merge-btn="${p.patientId}" style="font-size:0.75rem;padding:0.3rem 0.6rem;">Merge</button></td>
                </tr>
              `).join('')}
              </tbody></table>`}
          ${merged.length > 0 ? `
            <h3 style="margin-top:1.5rem;">✓ Previously Merged</h3>
            <table class="vhc-table"><thead><tr><th>Name</th><th>Walk-in ID</th><th>Merged Into</th><th>Merged At</th></tr></thead><tbody>
              ${merged.map(p => `<tr><td>${p.name || '-'}</td><td style="font-size:0.75rem;">${p.patientId}</td><td style="font-size:0.75rem;">${p.mergedIntoPatientId}</td><td style="font-size:0.78rem;">${fmtDate(p.mergedAt)}</td></tr>`).join('')}
            </tbody></table>` : ''}
        </div>`;
    }

    html += `</div>`; // close vhc-overlay-body
    overlay.innerHTML = html;
    attachEvents();
  };

  const attachEvents = () => {
    // Close button
    const closeBtn = overlay.querySelector('#vhc-close-btn');
    if (closeBtn) closeBtn.onclick = () => overlay.remove();

    // Tab switching
    overlay.querySelectorAll('.vhc-tab').forEach(tab => {
      tab.onclick = () => { activeTab = tab.dataset.tab; render(); };
    });

    // Filter inputs
    const pfInput = overlay.querySelector('#vhc-f-product');
    if (pfInput) pfInput.oninput = e => { filterProduct = e.target.value; render(); };

    const bfInput = overlay.querySelector('#vhc-f-bill');
    if (bfInput) bfInput.oninput = e => { filterBill = e.target.value; render(); };

    const tfInput = overlay.querySelector('#vhc-f-type');
    if (tfInput) tfInput.onchange = e => { filterType = e.target.value; render(); };

    const fromInput = overlay.querySelector('#vhc-f-from');
    if (fromInput) fromInput.onchange = e => { filterFrom = e.target.value; render(); };

    const toInput = overlay.querySelector('#vhc-f-to');
    if (toInput) toInput.onchange = e => { filterTo = e.target.value; render(); };

    // Reconcile adjust buttons
    overlay.querySelectorAll('[data-adjust]').forEach(btn => {
      btn.onclick = () => {
        activeTab = 'adjust';
        render();
        // Pre-fill the product
        setTimeout(() => {
          const sel = overlay.querySelector('#vhc-adj-product');
          if (sel) sel.value = btn.dataset.adjust;
          const qty = overlay.querySelector('#vhc-adj-qty');
          if (qty) qty.value = btn.dataset.expected || btn.dataset.current;
        }, 50);
      };
    });

    // Manual patient merge buttons
    overlay.querySelectorAll('[data-merge-btn]').forEach(btn => {
      btn.onclick = () => {
        const walkinId = btn.dataset.mergeBtn;
        const select = overlay.querySelector(`[data-merge-select="${walkinId}"]`);
        const targetId = select ? select.value : '';
        if (!targetId) { alert('Please select the real OPD patient to merge into.'); return; }
        const result = mergeManualPatientInto(walkinId, targetId);
        if (result.success) { render(); }
        else alert(result.error || 'Merge failed.');
      };
    });

    // Manual adjustment submit
    const adjSubmit = overlay.querySelector('#vhc-adj-submit');
    if (adjSubmit) {
      adjSubmit.onclick = () => {
        const pin = (overlay.querySelector('#vhc-adj-pin') || {}).value || '';
        const productId = (overlay.querySelector('#vhc-adj-product') || {}).value || '';
        const newQty = (overlay.querySelector('#vhc-adj-qty') || {}).value;
        const reason = ((overlay.querySelector('#vhc-adj-reason') || {}).value || '').trim();
        const msgEl = overlay.querySelector('#vhc-adj-msg');

        if (!verifyAdminPin(pin)) {
          if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">❌ Invalid admin PIN.</span>';
          return;
        }
        if (!productId) {
          if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">❌ Please select a product.</span>';
          return;
        }
        if (newQty === '' || newQty === null || newQty === undefined) {
          if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">❌ Please enter the new stock quantity.</span>';
          return;
        }
        if (!reason) {
          if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">❌ Reason is required for every adjustment.</span>';
          return;
        }

        try {
          const inv = JSON.parse(localStorage.getItem('pos_inventory') || '[]');
          const idx = inv.findIndex(x => x.id === productId);
          if (idx === -1) {
            if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">❌ Product not found in inventory.</span>';
            return;
          }
          const item = inv[idx];
          const oldStock = parseFloat(item.stock) || 0;
          const newStock = parseFloat(newQty);
          item.stock = newStock;
          localStorage.setItem('pos_inventory', JSON.stringify(inv));

          // Log the adjustment
          logStock({
            type: 'ADJUST',
            billId: '',
            patientName: '',
            patientId: '',
            product: item.name || '',
            batch: item.batch || '',
            qty: newStock - oldStock,
            opening: oldStock,
            closing: newStock,
            reason: reason,
          });

          // Also update audit log
          try {
            const auditLogs = JSON.parse(localStorage.getItem('pos_audit_logs') || '[]');
            auditLogs.unshift({
              id: Date.now(),
              timestamp: new Date().toISOString(),
              action: 'MANUAL_ADJUST',
              details: `[ADMIN] ${item.name} stock adjusted ${oldStock} → ${newStock}. Reason: ${reason}`,
            });
            localStorage.setItem('pos_audit_logs', JSON.stringify(auditLogs));
          } catch(e) {}

          if (msgEl) msgEl.innerHTML = `<span style="color:#4ade80;">✓ Stock for "${item.name}" adjusted from ${oldStock} to ${newStock}. Reason logged.</span>`;
          setTimeout(() => { activeTab = 'reconcile'; render(); }, 2000);
        } catch(e) {
          if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ Error: ${e.message}</span>`;
        }
      };
    }
  };

  render();
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────────
// 5. LAUNCHER BUTTON
// ─────────────────────────────────────────────────────────────
// Gates the whole investigation console (not just the Adjust action) behind the app's real
// admin password — this is investigation/audit data, not something every till user should see.
function promptAdminGate(onSuccess) {
  injectStyles();
  const bg = document.createElement('div');
  bg.className = 'vhc-modal-bg';
  bg.id = 'vhc-admin-gate';
  bg.innerHTML = `
    <div class="vhc-modal" style="max-width:380px;text-align:center;">
      <div style="font-size:2rem;margin-bottom:0.5rem;">🔒</div>
      <h3 style="text-align:center;">Admin Verification</h3>
      <p style="text-align:center;">Enter the admin password to open the Inventory Audit Console.</p>
      <input class="vhc-input" id="vhc-gate-pin" type="password" placeholder="Enter Admin Password" style="width:100%;box-sizing:border-box;margin-bottom:0.5rem;">
      <div id="vhc-gate-err" style="color:#f87171;font-size:0.82rem;font-weight:700;min-height:1.2em;margin-bottom:0.5rem;"></div>
      <div style="display:flex;gap:0.6rem;">
        <button class="vhc-btn" id="vhc-gate-cancel" style="flex:1;background:var(--panel-border,#334155);color:var(--text-primary,#f1f5f9);">Cancel</button>
        <button class="vhc-btn vhc-btn-primary" id="vhc-gate-verify" style="flex:1;">Verify</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  const input = bg.querySelector('#vhc-gate-pin');
  const errEl = bg.querySelector('#vhc-gate-err');
  const submit = () => {
    if (verifyAdminPin(input.value)) {
      bg.remove();
      onSuccess();
    } else {
      errEl.textContent = 'Incorrect password.';
    }
  };
  bg.querySelector('#vhc-gate-verify').onclick = submit;
  bg.querySelector('#vhc-gate-cancel').onclick = () => bg.remove();
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  input.focus();
}

function addLauncherButton() {
  if (document.getElementById('vhc-audit-launcher')) return;
  const btn = document.createElement('button');
  btn.id = 'vhc-audit-launcher';
  btn.innerHTML = '📊 Audit';
  btn.title = 'Open Stock Audit Console (Stock History, Reconcile, Adjustments)';
  btn.onclick = () => promptAdminGate(openStockHistory);
  document.body.appendChild(btn);
}

// ─────────────────────────────────────────────────────────────
// 6. PATIENT DISAMBIGUATION OVERLAY
// ─────────────────────────────────────────────────────────────
let _patientDisambigCallback = null;

function openPatientDisambig(name, matches, onSelect) {
  injectStyles();
  _patientDisambigCallback = onSelect;

  const bg = document.createElement('div');
  bg.className = 'vhc-modal-bg';
  bg.id = 'vhc-patient-disambig';

  bg.innerHTML = `
    <div class="vhc-modal" style="max-width:600px;">
      <h3>👥 Multiple Patients Found: "${name}"</h3>
      <p>Multiple patients share this name. Please confirm the correct patient to avoid mis-mapping.<br>
      <small style="color:#f87171;">Never auto-selected. You must choose.</small></p>
      <div id="vhc-patient-list" style="max-height:300px;overflow-y:auto;">
        ${matches.map(p => { ensurePatientId(p); return `
          <div class="vhc-patient-row" data-pid="${p.patientId||''}" data-pname="${(p.name||'').replace(/"/g,'&quot;')}">
            <div class="vhc-patient-name">${p.name || '-'}</div>
            <div class="vhc-patient-meta">
              📱 ${p.contact || p.mobile || p.phone || 'No mobile'} &nbsp;|&nbsp;
              🎂 Age: ${p.age || '-'} &nbsp;|&nbsp;
              ${(p.sex || p.gender) ? '👤 ' + (p.sex || p.gender) : ''} &nbsp;|&nbsp;
              Last visit: ${p.dateTab || p.lastVisit ? fmtDate2(p.dateTab || p.lastVisit) : 'N/A'}
              ${p.patientId ? `<br><small style="opacity:0.5">ID: ${p.patientId}</small>` : ''}
            </div>
          </div>
        `; }).join('')}
        <div class="vhc-patient-row" data-pid="WALKIN" data-pname="${name}">
          <div class="vhc-patient-name">➕ Add as Walk-in (${name})</div>
          <div class="vhc-patient-meta">Create a temporary ID — not linked to any OPD record</div>
        </div>
      </div>
      <div style="margin-top:1rem;display:flex;gap:0.75rem;">
        <button class="vhc-btn" id="vhc-disambig-cancel" style="background:var(--panel-border,#334155);color:var(--text-primary,#f1f5f9);">✕ Cancel</button>
      </div>
    </div>`;

  bg.querySelectorAll('.vhc-patient-row').forEach(row => {
    row.onclick = () => {
      const pid = row.dataset.pid;
      const pname = row.dataset.pname;
      if (pid === 'WALKIN') {
        const patient = addManualPatient(pname);
        _patientDisambigCallback && _patientDisambigCallback(patient);
      } else {
        const patient = matches.find(p => p.patientId === pid);
        _patientDisambigCallback && _patientDisambigCallback(patient || { patientId: pid, name: pname });
      }
      bg.remove();
    };
  });

  const cancelBtn = bg.querySelector('#vhc-disambig-cancel');
  if (cancelBtn) cancelBtn.onclick = () => { bg.remove(); _patientDisambigCallback && _patientDisambigCallback(null); };

  document.body.appendChild(bg);
}

// ─────────────────────────────────────────────────────────────
// 7. EXPORT TO WINDOW
// ─────────────────────────────────────────────────────────────
window.VHC_AUDIT = {
  logStock,
  ensurePatientId,
  migratePatientIds,
  getAllPatients,
  findPatientsByName,
  openPatientDisambig,
  openStockHistory,
  verifyAdminPin,
  computeReconciliation,
  addManualPatient,
  mergeManualPatientInto,
  promptAdminGate,
};

// ─────────────────────────────────────────────────────────────
// 8. INITIALIZE
// ─────────────────────────────────────────────────────────────
function init() {
  injectStyles();
  migratePatientIds();
  // No floating launcher button — it overlapped the sidebar nav. The console is opened from
  // a proper entry point in Settings instead (see the React bundle's Settings screen), via
  // window.VHC_AUDIT.promptAdminGate(window.VHC_AUDIT.openStockHistory).
  console.log('[VHC_AUDIT] Stock audit engine initialized. Keys: pos_stock_movements');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already ready (script loaded async)
  setTimeout(init, 500);
}

})(); // end IIFE
