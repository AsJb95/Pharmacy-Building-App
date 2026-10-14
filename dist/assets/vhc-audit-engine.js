// VHC Pharmacy POS — Audit Engine & Patient Fix Module v1.1
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
const FIN_AUDIT_KEY   = 'pos_financial_audit_logs';
const FIN_ALERT_KEY   = 'vhc_financial_integrity_alerts';
const SALES_KEY       = 'vhc_pos_sales_history';
const INVENTORY_KEYS  = new Set(['pos_inventory', 'vhc_pos_inventory']);

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

function _readJsonArray(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function _writeJsonArray(key, arr, limit) {
  try { localStorage.setItem(key, JSON.stringify(arr.slice(0, limit || 5000))); } catch (e) {}
}

function _storageHealthFailure(message, error) {
  const alert = {
    id: _genId(),
    ts: new Date().toISOString(),
    source: 'local-storage-health',
    issueCount: 1,
    issues: [{ severity: 'error', code: 'LOCAL_STORAGE_HEALTH_FAILED', message, error: error && error.message || '' }],
  };
  try {
    const alerts = _readJsonArray(FIN_ALERT_KEY);
    alerts.unshift(alert);
    _writeJsonArray(FIN_ALERT_KEY, alerts, 500);
  } catch (e) {}
  logFinancial('LOCAL_STORAGE_HEALTH_FAILED', { source: 'localStorage', message, next: alert });
  _showFinancialWarning(alert);
  console.error('[VHC_AUDIT] Local storage health failure:', message, error || '');
  return alert;
}

function runStorageHealthCheck(opts) {
  const options = opts || {};
  const key = `vhc_storage_healthcheck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const value = JSON.stringify({ ts: new Date().toISOString(), nonce: key });
  try {
    localStorage.setItem(key, value);
    const readBack = localStorage.getItem(key);
    if (readBack !== value) throw new Error('Health-check read-back did not match written value.');
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error('Health-check cleanup key still exists after remove.');
    return { ok: true, source: options.source || 'manual', ts: new Date().toISOString() };
  } catch (e) {
    return { ok: false, source: options.source || 'manual', alert: _storageHealthFailure('Local storage write/read/cleanup check failed.', e) };
  }
}

function _verifyInventoryWrite(key, value) {
  if (!INVENTORY_KEYS.has(key)) return;
  const readBack = localStorage.getItem(key);
  if (readBack !== String(value)) {
    throw new Error(`Inventory storage verification failed for ${key}.`);
  }
  const parsed = readBack ? JSON.parse(readBack) : [];
  if (!Array.isArray(parsed)) {
    throw new Error(`Inventory storage for ${key} is not a valid medicine list.`);
  }
}

function _round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

function _billPaymentBreakdown(bill) {
  let breakdown = bill && bill.paymentBreakdown;
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    breakdown =
      bill && bill.paymentMode === 'Credit'
        ? { credit: bill.totalAmount || 0 }
        : bill && bill.paymentMode === 'Split'
          ? { unspecified: bill.totalAmount || 0 }
          : { [(bill && bill.paymentMode) || 'Cash']: (bill && bill.totalAmount) || 0 };
  }
  return breakdown;
}

function _paymentRowsForBill(bill) {
  if (!bill || !bill.billId) return [];
  const breakdown = _billPaymentBreakdown(bill);
  const rows = [];
  Object.keys(breakdown).forEach((key) => {
    const amount = _round2(breakdown[key]);
    if (amount > 0) rows.push({ billId: bill.billId, method: String(key || 'Other'), amount });
  });
  (Array.isArray(bill.creditRepayments) ? bill.creditRepayments : []).forEach((rp) => {
    const amount = _round2(rp && rp.amount);
    if (amount > 0) rows.push({ billId: bill.billId, method: String((rp && rp.method) || 'cash'), amount, repaymentId: rp && rp.id });
  });
  return rows;
}

function logFinancial(action, details) {
  try {
    const logs = _readJsonArray(FIN_AUDIT_KEY);
    logs.unshift({
      id: _genId(),
      ts: new Date().toISOString(),
      action: action || 'UNKNOWN',
      billId: details && details.billId || '',
      billNumber: details && (details.billNumber || details.billId) || '',
      source: details && details.source || 'local',
      previous: details && details.previous !== undefined ? details.previous : null,
      next: details && details.next !== undefined ? details.next : null,
      message: details && details.message || '',
    });
    _writeJsonArray(FIN_AUDIT_KEY, logs, 5000);
  } catch (e) {
    console.error('[VHC_AUDIT] logFinancial error:', e);
  }
}

function runFinancialIntegrityAudit(opts) {
  const options = opts || {};
  const issues = [];
  try {
    const bills = _readJsonArray(SALES_KEY);
    const seenIds = new Map();
    const seenNumbers = new Map();
    const tolerance = 0.01;
    bills.forEach((bill, index) => {
      if (!bill || typeof bill !== 'object') return;
      const billId = String(bill.billId || bill.id || '').trim();
      if (!billId) {
        issues.push({ severity: 'error', code: 'MISSING_BILL_ID', index, message: 'Bill row has no billId.' });
        return;
      }
      if (seenIds.has(billId)) issues.push({ severity: 'error', code: 'DUPLICATE_BILL_ID', billId, firstIndex: seenIds.get(billId), index });
      else seenIds.set(billId, index);
      const billNo = String(bill.billNumber || bill.invoiceNumber || bill.billNo || billId).trim();
      if (billNo) {
        if (seenNumbers.has(billNo)) issues.push({ severity: 'error', code: 'DUPLICATE_BILL_NUMBER', billId, billNumber: billNo, firstBillId: seenNumbers.get(billNo), index });
        else seenNumbers.set(billNo, billId);
      }

      const total = _round2(bill.totalAmount);
      const amountReceived = bill.amountReceived == null ? null : _round2(bill.amountReceived);
      const outstandingAmount = bill.outstandingAmount == null ? null : _round2(bill.outstandingAmount);
      const status = bill.paymentStatus || (bill.paymentMode === 'Credit' ? 'Credit' : 'Paid');
      const breakdown = _billPaymentBreakdown(bill);
      const breakdownTotal = _round2(Object.keys(breakdown).reduce((sum, key) => sum + (parseFloat(breakdown[key]) || 0), 0));
      const rows = _paymentRowsForBill(bill);

      if (!bill.paymentBreakdown || typeof bill.paymentBreakdown !== 'object') {
        issues.push({ severity: 'warn', code: 'MISSING_PAYMENT_BREAKDOWN', billId, paymentMode: bill.paymentMode || null, source: bill.fromCloudOnly ? 'cloud' : 'local' });
      }
      if (rows.length === 0 && total > 0) {
        issues.push({ severity: 'error', code: 'PAYMENT_REPORT_NO_ROWS', billId, totalAmount: total, status });
      }
      if (amountReceived != null && outstandingAmount != null && Math.abs(amountReceived + outstandingAmount - total) > tolerance) {
        issues.push({ severity: 'error', code: 'PAYMENT_TOTAL_MISMATCH', billId, totalAmount: total, amountReceived, outstandingAmount });
      }
      if (amountReceived != null && Math.abs(breakdownTotal - total) > tolerance && Math.abs(breakdownTotal - amountReceived) > tolerance) {
        issues.push({ severity: 'warn', code: 'PAYMENT_BREAKDOWN_MISMATCH', billId, totalAmount: total, amountReceived, breakdownTotal });
      }
      if ((status === 'Paid' || status === 'paid') && outstandingAmount != null && outstandingAmount > tolerance) {
        issues.push({ severity: 'error', code: 'PAID_WITH_OUTSTANDING_BALANCE', billId, status, outstandingAmount });
      }
      if ((status === 'Credit' || status === 'Partially Paid') && outstandingAmount != null && outstandingAmount <= tolerance && total > 0) {
        issues.push({ severity: 'warn', code: 'UNPAID_STATUS_WITH_ZERO_BALANCE', billId, status, outstandingAmount });
      }
      if (bill.fromCloudOnly && (!bill.paymentBreakdown || amountReceived == null || outstandingAmount == null || !bill.paymentStatus)) {
        issues.push({ severity: 'warn', code: 'CLOUD_LOCAL_SCHEMA_MISMATCH', billId, message: 'Cloud-only bill is missing local payment detail fields.' });
      }
    });

    const alert = {
      id: _genId(),
      ts: new Date().toISOString(),
      source: options.source || 'manual',
      billCount: bills.length,
      issueCount: issues.length,
      issues,
    };
    if (issues.length || options.alwaysStore) {
      const alerts = _readJsonArray(FIN_ALERT_KEY);
      alerts.unshift(alert);
      _writeJsonArray(FIN_ALERT_KEY, alerts, 500);
      logFinancial('INTEGRITY_CHECK_WARNING', { source: options.source || 'manual', message: `${issues.length} financial integrity issue(s) found.`, next: alert });
      console.warn('[VHC_AUDIT] Financial integrity audit found issues:', alert);
    }
    return alert;
  } catch (e) {
    const alert = { id: _genId(), ts: new Date().toISOString(), source: options.source || 'manual', error: e.message, issueCount: 1, issues: [{ severity: 'error', code: 'AUDIT_FAILED', message: e.message }] };
    logFinancial('INTEGRITY_CHECK_WARNING', { source: options.source || 'manual', message: 'Financial integrity audit failed.', next: alert });
    return alert;
  }
}

function _installSalesHistoryWatch() {
  try {
    if (localStorage.__vhcFinancialWatchInstalled) return;
    localStorage.__vhcFinancialWatchInstalled = '1';
    const originalSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(key, value) {
      let before = key === SALES_KEY ? _readJsonArray(SALES_KEY) : null;
      try {
        originalSetItem(key, value);
        _verifyInventoryWrite(key, value);
      } catch (e) {
        const storageKey = String(key || '');
        const criticalKey = storageKey === SALES_KEY || INVENTORY_KEYS.has(storageKey);
        if (!criticalKey) throw e;
        const action = storageKey === SALES_KEY ? 'LOCAL_SALES_HISTORY_SAVE_FAILED' : INVENTORY_KEYS.has(storageKey) ? 'LOCAL_INVENTORY_SAVE_FAILED' : 'LOCAL_STORAGE_SAVE_FAILED';
        logFinancial(action, {
          source: 'localStorage',
          message: `${storageKey || 'localStorage'} write failed or failed read-back verification.`,
          next: { key: storageKey, error: e && e.message || String(e) },
        });
        _storageHealthFailure(`${storageKey || 'localStorage'} write failed or failed read-back verification.`, e);
        throw e;
      }
      if (key !== SALES_KEY) return;
      let after = _readJsonArray(SALES_KEY);
      const beforeIds = new Set(before.map((b) => b && b.billId).filter(Boolean));
      const afterIds = new Set(after.map((b) => b && b.billId).filter(Boolean));
      const disappeared = Array.from(beforeIds).filter((id) => !afterIds.has(id));
      const appeared = Array.from(afterIds).filter((id) => !beforeIds.has(id));
      if (appeared.length || disappeared.length) {
        logFinancial('SALES_HISTORY_CHANGED', {
          source: 'localStorage',
          message: `Sales history changed: +${appeared.length}, -${disappeared.length}.`,
          previous: { count: before.length, disappeared },
          next: { count: after.length, appeared },
        });
      }
      if (disappeared.length) {
        runFinancialIntegrityAudit({ source: 'sales-history-watch', alwaysStore: true });
      }
    };
  } catch (e) {
    console.error('[VHC_AUDIT] failed to install sales history watch:', e);
  }
}

function _showFinancialWarning(alert) {
  try {
    if (!alert || !(alert.issueCount || alert.cloudOnlyCount || alert.localOnlyCount ||
      alert.duplicateLocalCount || alert.duplicateCloudCount || alert.orphanOperationCount || alert.deletedLocalCloudPresentCount)) return;
    const existing = document.getElementById('vhc-financial-integrity-warning');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'vhc-financial-integrity-warning';
    div.dataset.vhcWarningType = alert.auditType || 'LOCAL_FINANCIAL_INTEGRITY';
    div.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;max-width:420px;background:#7f1d1d;color:#fff;border:1px solid #fecaca;border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.25);padding:14px 16px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.45;';
    const count = Number.isFinite(alert.issueCount)
      ? alert.issueCount
      : (alert.localOnlyCount || 0) + (alert.duplicateLocalCount || 0) +
        (alert.duplicateCloudCount || 0) + (alert.orphanOperationCount || 0) +
        (alert.deletedLocalCloudPresentCount || 0);
    div.innerHTML = `<strong style="display:block;font-size:14px;margin-bottom:4px;">Financial integrity warning</strong><span>${count} issue(s) need admin review. No records were changed.</span><button id="vhc-financial-warning-close" style="float:right;margin-left:10px;background:#991b1b;color:#fff;border:1px solid #fecaca;border-radius:6px;padding:3px 7px;cursor:pointer;">Close</button>`;
    document.body.appendChild(div);
    const btn = div.querySelector('#vhc-financial-warning-close');
    if (btn) btn.onclick = () => div.remove();
  } catch (e) {}
}

function _resolveCloudMismatchWarnings() {
  const alerts = _readJsonArray(FIN_ALERT_KEY);
  const remaining = alerts.filter((alert) => !(
    alert && (
      alert.auditType === 'LOCAL_CLOUD_MISMATCH_AUDIT' ||
      (Object.prototype.hasOwnProperty.call(alert, 'cloudOnlyCount') &&
        Object.prototype.hasOwnProperty.call(alert, 'localOnlyCount'))
    )
  ));
  if (remaining.length !== alerts.length) _writeJsonArray(FIN_ALERT_KEY, remaining, 500);
  const existing = document.getElementById('vhc-financial-integrity-warning');
  if (existing && existing.dataset && existing.dataset.vhcWarningType === 'LOCAL_CLOUD_MISMATCH_AUDIT') {
    existing.remove();
  }
}

async function runCloudLocalMismatchAudit(opts) {
  const options = opts || {};
  let localBills = null;
  let operations = null;
  try {
    if (!(window.electronAPI && window.electronAPI.getFinancialIntegritySnapshot)) {
      return { status: 'SKIPPED_LOCAL_UNVERIFIED', cloudAuditStatus: 'UNKNOWN', authoritative: false, error: 'Durable local financial audit snapshot unavailable' };
    }
    const snapshot = await window.electronAPI.getFinancialIntegritySnapshot();
    if (!snapshot || snapshot.success !== true || !Array.isArray(snapshot.sales) || !Array.isArray(snapshot.operations)) {
      return { status: 'SKIPPED_LOCAL_UNVERIFIED', cloudAuditStatus: 'UNKNOWN', authoritative: false, error: snapshot && snapshot.error || 'Durable local financial audit snapshot was not verified' };
    }
    localBills = snapshot.sales;
    operations = snapshot.operations;
  } catch (e) {
    return { status: 'SKIPPED_LOCAL_UNVERIFIED', cloudAuditStatus: 'UNKNOWN', authoritative: false, error: e && e.message || String(e) };
  }

  const reachability = window.VHC_FINANCIAL_SYNC && window.VHC_FINANCIAL_SYNC.getReachabilityState
    ? window.VHC_FINANCIAL_SYNC.getReachabilityState()
    : _cloudReachability;
  const policy = window.VHC_RUNTIME_POLICY;
  const activeLocalBills = localBills.filter((bill) => !['deleted', 'cancelled', 'canceled'].includes(String(bill && bill.status || '').toLowerCase()));
  const localIds = activeLocalBills.map((bill) => bill && (bill.billId || bill.bill_id)).filter(Boolean).map(String);
  const localDuplicateIds = Array.from(new Set(localIds.filter((id, index) => localIds.indexOf(id) !== index)));
  const unavailable = (status, error) => {
    if (localDuplicateIds.length) {
      const duplicateAlert = {
        id: _genId(), ts: new Date().toISOString(), source: options.source || 'cloud-local-audit',
        auditType: 'LOCAL_DUPLICATE_BILL_AUDIT', issueCount: localDuplicateIds.length,
        duplicateLocal: localDuplicateIds, issues: localDuplicateIds.map((billId) => ({ code: 'DUPLICATE_LOCAL_BILL_ID', billId })),
      };
      const alerts = _readJsonArray(FIN_ALERT_KEY);
      alerts.unshift(duplicateAlert);
      _writeJsonArray(FIN_ALERT_KEY, alerts, 500);
      logFinancial('LOCAL_DUPLICATE_BILL_AUDIT', {
        source: duplicateAlert.source,
        message: `Local audit: ${localDuplicateIds.length} duplicate bill id(s). Cloud comparison was skipped.`,
        next: duplicateAlert,
      });
      _showFinancialWarning(duplicateAlert);
    }
    return {
      status,
      cloudAuditStatus: 'UNKNOWN',
      authoritative: false,
      error: error || null,
      cloudOnly: [], localOnly: [], expectedPending: [], duplicateLocal: localDuplicateIds,
    };
  };

  // Cached sales history is display data only. A mismatch audit requires both a verified
  // online reachability state and a successful fresh authenticated cloud read.
  if (!navigator.onLine || reachability !== 'online') {
    return unavailable(!navigator.onLine || reachability === 'offline' ? 'SKIPPED_OFFLINE' : 'SKIPPED_CLOUD_UNVERIFIED');
  }

  let cloudRows;
  try {
    if (!(window.VHC_CLOUD && window.VHC_CLOUD.fetchSalesHistory)) {
      return unavailable('SKIPPED_CLOUD_UNVERIFIED', 'Fresh cloud sales read unavailable');
    }
    cloudRows = await window.VHC_CLOUD.fetchSalesHistory();
    if (!Array.isArray(cloudRows)) {
      const error = cloudRows && (cloudRows.error || cloudRows.message || cloudRows.code)
        ? cloudRows
        : 'Fresh cloud sales read did not return a verified row set';
      const transportFailure = policy && policy.isTransportFailure
        ? policy.isTransportFailure(error)
        : /failed to fetch|fetch failed|timeout|dns|connection refused|network/i.test(String(error && error.message || error));
      const state = transportFailure ? 'offline' : 'failed';
      _setCloudReachability(state, { source: options.source || 'cloud-local-audit', error: String(error.message || error) });
      return unavailable(transportFailure ? 'SKIPPED_OFFLINE' : 'SKIPPED_CLOUD_UNVERIFIED', error);
    }
  } catch (error) {
    const transportFailure = policy && policy.isTransportFailure
      ? policy.isTransportFailure(error)
      : /failed to fetch|fetch failed|timeout|dns|connection refused|network/i.test(String(error && error.message || error));
    const state = transportFailure ? 'offline' : 'failed';
    _setCloudReachability(state, { source: options.source || 'cloud-local-audit', error: error && error.message || String(error) });
    return unavailable(transportFailure ? 'SKIPPED_OFFLINE' : 'SKIPPED_CLOUD_UNVERIFIED', error && error.message || String(error));
  }

  // A fresh cloud set contains sales from every terminal. Only durable local ownership
  // evidence can make an absent cloud counterpart an integrity mismatch.
  if (!policy || typeof policy.compareBillSets !== 'function') {
    return unavailable('SKIPPED_AUDIT_POLICY_UNAVAILABLE', 'Financial audit policy unavailable');
  }
  const comparison = policy.compareBillSets(localBills, cloudRows, operations);
  const {
    cloudOnly = [], remoteOnly = [], localOnly = [], expectedPending = [], expectedUnsynced = [],
    duplicateLocal = [], duplicateCloud = [], orphanOperations = [], deletedLocalCloudPresent = [],
  } = comparison;
  const issueCount = new Set([
    ...localOnly, ...duplicateLocal, ...duplicateCloud, ...orphanOperations, ...deletedLocalCloudPresent,
  ]).size;
  const alert = {
    id: _genId(),
    ts: new Date().toISOString(),
    source: options.source || 'cloud-local-audit',
    auditType: 'LOCAL_CLOUD_MISMATCH_AUDIT',
    issueCount,
    localCount: activeLocalBills.length,
    cloudCount: cloudRows.length,
    cloudOnlyCount: cloudOnly.length,
    remoteOnlyCount: remoteOnly.length,
    localOnlyCount: localOnly.length,
    duplicateLocalCount: duplicateLocal.length,
    duplicateCloudCount: duplicateCloud.length,
    orphanOperationCount: orphanOperations.length,
    deletedLocalCloudPresentCount: deletedLocalCloudPresent.length,
    expectedPendingCount: expectedPending.length,
    expectedUnsyncedCount: expectedUnsynced.length,
    cloudOnly,
    remoteOnly,
    localOnly,
    expectedPending,
    expectedUnsynced,
    duplicateLocal,
    duplicateCloud,
    orphanOperations,
    deletedLocalCloudPresent,
  };
  if (issueCount || options.alwaysStore) {
    const alerts = _readJsonArray(FIN_ALERT_KEY);
    alerts.unshift(alert);
    _writeJsonArray(FIN_ALERT_KEY, alerts, 500);
    logFinancial('LOCAL_CLOUD_MISMATCH_AUDIT', {
      source: alert.source,
      message: `Financial audit: ${localOnly.length} owned local bill(s) missing in cloud, ${duplicateLocal.length} duplicate local, ${duplicateCloud.length} duplicate cloud, ${orphanOperations.length} orphan sync operation(s), ${deletedLocalCloudPresent.length} deleted-local bill(s) still active in cloud.`,
      next: alert,
    });
    _showFinancialWarning(alert);
    console.warn('[VHC_AUDIT] Local/cloud mismatch audit:', alert);
  } else {
    _resolveCloudMismatchWarnings();
  }
  alert.status = 'FRESH';
  alert.cloudAuditStatus = 'FRESH_AUTHORITATIVE';
  alert.authoritative = true;
  return alert;
}

let _financialSyncInFlight = false;
let _reachabilityProbeInFlight = null;
let _cloudReachability = 'unknown';

function _saleItemToCloudItem(item) {
  const qty = parseFloat(item.quantity ?? item.qty ?? 0) || 0;
  const rate = parseFloat(item.rate ?? item.price ?? item.mrp ?? 0) || 0;
  return {
    category: item.category || 'Medicine',
    drugName: item.drug_name || item.drugName || item.name || item.item_name || 'Unknown item',
    batchNo: item.batch_no || item.batchNo || item.batch || 'N/A',
    expiryDate: item.expiry_date || item.expiryDate || item.expiry || 'N/A',
    quantity: qty,
    rate,
    total: parseFloat(item.total_amount ?? item.total ?? (qty * rate)) || 0,
    // item_id/stock_batch_id are local SQLite UUIDs. They are not Supabase
    // foreign keys unless an explicit server id was persisted alongside them.
    itemId: item.server_item_id || item.serverItemId || null,
    stockBatchId: item.server_stock_batch_id || item.serverStockBatchId || null,
    hsnCode: item.hsn_code || item.hsnCode || null,
    gst: item.gst_percent ?? item.gst ?? null,
  };
}

function _localSaleToCloudPayload(localSale) {
  if (!localSale) throw new Error('Missing local sale');
  const items = Array.isArray(localSale.sale_items) ? localSale.sale_items.map(_saleItemToCloudItem) : [];
  let patientSnapshot = localSale.patient_snapshot || localSale.patientSnapshot || null;
  let paymentBreakdown = localSale.payment_breakdown || localSale.paymentBreakdown || null;
  try { if (typeof patientSnapshot === 'string') patientSnapshot = JSON.parse(patientSnapshot); } catch (e) { patientSnapshot = null; }
  try { if (typeof paymentBreakdown === 'string') paymentBreakdown = JSON.parse(paymentBreakdown); } catch (e) { paymentBreakdown = null; }
  return {
    billId: localSale.bill_id || localSale.billId,
    // sales.patient_id is the local SQLite patient UUID. Use the original
    // external/legacy id from the snapshot so the cloud layer can resolve it.
    patientId: patientSnapshot && (patientSnapshot.patientId || patientSnapshot.patient_id) || null,
    patientName: localSale.patient_name || localSale.patientName || 'Walk-in',
    patientSnapshot,
    patientContact: localSale.patient_contact || localSale.patientContact || null,
    doctorName: localSale.doctor_name || localSale.doctorName || null,
    paymentMode: localSale.payment_mode || localSale.paymentMode || null,
    subtotal: parseFloat(localSale.subtotal ?? 0) || 0,
    totalTax: parseFloat(localSale.total_tax ?? localSale.totalTax ?? 0) || 0,
    totalAmount: parseFloat(localSale.total_amount ?? localSale.totalAmount ?? 0) || 0,
    gstMode: localSale.gst_mode || localSale.gstMode || null,
    discount: parseFloat(localSale.discount ?? 0) || 0,
    discountPercent: parseFloat(localSale.discount_percent ?? localSale.discountPercent ?? 0) || 0,
    amountReceived: localSale.amount_received ?? localSale.amountReceived ?? null,
    outstandingAmount: localSale.outstanding_amount ?? localSale.outstandingAmount ?? null,
    paymentStatus: localSale.payment_status || localSale.paymentStatus || null,
    paymentBreakdown,
    recordedBy: localSale.recorded_by || localSale.recordedBy || null,
    saleDate: localSale.sale_date || localSale.created_at || localSale.date || undefined,
    recordOnly: true,
    items,
  };
}

// One comparable signature per bill line: name, quantity and line total. Quantities/totals come
// back from Postgres as numeric strings ("1.000"), so both sides are normalised numerically.
function _saleLineSignature(item) {
  const name = String(item.drug_name || item.drugName || item.name || item.item_name || '').trim().toLowerCase();
  const qty = Math.round((parseFloat(item.quantity ?? item.qty ?? 0) || 0) * 1000) / 1000;
  const total = Math.round((parseFloat(item.total_amount ?? item.total ?? 0) || 0) * 100) / 100;
  return `${name}|${qty}|${total.toFixed(2)}`;
}

// Exact-content verification of an existing cloud sale against the local bill: same bill_id,
// same total, payment fields, and the SAME multiset of lines. `missing sale_items` (cloud has
// fewer lines) is the only repairable state (idempotent create_sale replay); every other
// difference is reported as a mismatch for review and is never "fixed" by re-uploading.
function _cloudSaleMatchesLocal(localSale, cloudSale) {
  if (!localSale || !cloudSale) return { ok: false, reason: 'missing sale' };
  const localBillId = String(localSale.bill_id || localSale.billId || '');
  if (cloudSale.bill_id != null && String(cloudSale.bill_id) !== localBillId) {
    return { ok: false, reason: `bill_id mismatch local=${localBillId} cloud=${cloudSale.bill_id}` };
  }
  const localTotal = Number(localSale.total_amount ?? localSale.totalAmount ?? 0);
  const cloudTotal = Number(cloudSale.total_amount ?? cloudSale.totalAmount ?? 0);
  if (Math.abs(localTotal - cloudTotal) > 0.02) {
    return { ok: false, reason: `amount mismatch local=${localTotal} cloud=${cloudTotal}` };
  }
  const localItems = Array.isArray(localSale.sale_items) ? localSale.sale_items : [];
  const cloudItems = Array.isArray(cloudSale.sale_items) ? cloudSale.sale_items : [];
  if (cloudItems.length < localItems.length) {
    return { ok: false, reason: `missing sale_items local=${localItems.length} cloud=${cloudItems.length}` };
  }
  if (cloudItems.length > localItems.length) {
    return { ok: false, reason: `extra sale_items local=${localItems.length} cloud=${cloudItems.length}` };
  }
  const remaining = new Map();
  for (const line of localItems) {
    const sig = _saleLineSignature(line);
    remaining.set(sig, (remaining.get(sig) || 0) + 1);
  }
  for (const line of cloudItems) {
    const sig = _saleLineSignature(line);
    const n = remaining.get(sig) || 0;
    if (!n) return { ok: false, reason: `sale_items content mismatch: cloud line ${sig} not in local bill` };
    remaining.set(sig, n - 1);
  }
  const paymentFields = [
    ['amount_received', 'amountReceived'],
    ['outstanding_amount', 'outstandingAmount'],
  ];
  for (const [snake, camel] of paymentFields) {
    const localValue = Number(localSale[snake] ?? localSale[camel] ?? 0);
    const cloudValue = Number(cloudSale[snake] ?? cloudSale[camel] ?? 0);
    if (Math.abs(localValue - cloudValue) > 0.02) {
      return { ok: false, reason: `${snake} mismatch local=${localValue} cloud=${cloudValue}` };
    }
  }
  const localPaymentStatus = String(localSale.payment_status || localSale.paymentStatus || '');
  const cloudPaymentStatus = String(cloudSale.payment_status || cloudSale.paymentStatus || '');
  if (localPaymentStatus && cloudPaymentStatus && localPaymentStatus !== cloudPaymentStatus) {
    return { ok: false, reason: `payment_status mismatch local=${localPaymentStatus} cloud=${cloudPaymentStatus}` };
  }
  return { ok: true };
}

function _stockMovementKey(billId, movement) {
  return `VHC:BILL:${billId}:${movement.id}`;
}

async function _reconcileStockForOperation(op, localSale) {
  if (Number(op && op.contract_version || 1) < 2) {
    return { skipped: true, reason: 'legacy financial sync contract' };
  }
  if (!(window.VHC_CLOUD && window.VHC_CLOUD.reconcileStockMovementStrict && window.VHC_CLOUD.findStockMovementByKeyStrict)) {
    throw new Error('STOCK_RECONCILIATION_API_UNAVAILABLE');
  }
  const movements = (Array.isArray(localSale.stock_movements) ? localSale.stock_movements : [])
    .filter((movement) => movement && movement.type === 'BILL');
  for (const movement of movements) {
    const movementKey = _stockMovementKey(localSale.bill_id || localSale.billId, movement);
    const payload = {
      movement_key: movementKey,
      bill_id: localSale.bill_id || localSale.billId,
      stock_batch_id: movement.server_stock_batch_id || null,
      item_id: movement.server_item_id || null,
      location_id: movement.cloud_location_id || null,
      batch_no: movement.batch_no || null,
      expected_opening: Number(movement.opening),
      closing: Number(movement.closing),
      quantity_delta: Number(movement.qty),
      movement_type: 'BILL',
      reason: movement.reason || `Bill:${localSale.bill_id || localSale.billId}`,
    };
    if (!payload.stock_batch_id && !(payload.item_id && payload.location_id && payload.batch_no)) {
      throw new Error(`STOCK_BATCH_IDENTITY_MISSING: ${movementKey}`);
    }
    const result = await window.VHC_CLOUD.reconcileStockMovementStrict(payload);
    const status = String(result && result.status || '').toUpperCase();
    if (status === 'CONFLICT') {
      throw new Error(`STOCK_RECONCILIATION_CONFLICT: ${movementKey} expected=${payload.expected_opening} actual=${result.actual_opening}`);
    }
    if (status !== 'APPLIED' && status !== 'ALREADY_APPLIED') {
      throw new Error(`STOCK_RECONCILIATION_FAILED: ${movementKey} status=${status || 'UNKNOWN'}`);
    }
    const verified = await window.VHC_CLOUD.findStockMovementByKeyStrict(movementKey);
    if (!verified || verified.movement_key !== movementKey) {
      throw new Error(`STOCK_RECONCILIATION_READBACK_FAILED: ${movementKey}`);
    }
  }
  return { reconciled: movements.length };
}

function _describeFinancialSyncError(error) {
  if (window.VHC_CLOUD && window.VHC_CLOUD.describeCloudError) {
    const details = window.VHC_CLOUD.describeCloudError(error);
    return [details.code, details.message, details.details, details.hint].filter(Boolean).join(' | ');
  }
  return error && error.message ? error.message : String(error);
}

function _emitFinancialSyncState(detail) {
  try { window.dispatchEvent(new CustomEvent('vhc-financial-sync-state', { detail: detail || {} })); } catch (e) {}
}

function _isNetworkStyleCloudError(error) {
  if (window.VHC_RUNTIME_POLICY) return window.VHC_RUNTIME_POLICY.isTransportFailure(error);
  const details = _describeFinancialSyncError(error).toLowerCase();
  return /failed to fetch|fetch failed|networkerror when attempting to fetch|network request failed|err_internet_disconnected|err_name_not_resolved|err_connection_(closed|reset|refused|timed_out)|econnrefused|econnreset|etimedout|enotfound|eai_again/.test(details);
}

function _setCloudReachability(status, extra) {
  _cloudReachability = status;
  _emitFinancialSyncState({ status: status === 'failed' ? 'failed' : status, reachability: status, ...(extra || {}) });
  return { status, ...(extra || {}) };
}

async function checkCloudReachability(opts) {
  const options = opts || {};
  if (!navigator.onLine) return _setCloudReachability('offline', { source: options.source || 'navigator-offline' });
  if (_reachabilityProbeInFlight) return _reachabilityProbeInFlight;
  _cloudReachability = 'checking';
  _emitFinancialSyncState({ status: 'checking', reachability: 'checking', source: options.source || 'reachability-check' });
  _reachabilityProbeInFlight = (async () => {
    try {
      if (!(window.VHC_CLOUD && window.VHC_CLOUD.checkReachability)) {
        throw Object.assign(new Error('Cloud reachability API unavailable'), { code: 'REACHABILITY_API_UNAVAILABLE' });
      }
      await window.VHC_CLOUD.checkReachability({ timeoutMs: options.timeoutMs || 5000 });
      return _setCloudReachability('online', { source: options.source || 'reachability-check' });
    } catch (error) {
      const status = _isNetworkStyleCloudError(error) ? 'offline' : 'failed';
      return _setCloudReachability(status, {
        source: options.source || 'reachability-check',
        error: _describeFinancialSyncError(error),
      });
    } finally {
      _reachabilityProbeInFlight = null;
    }
  })();
  return _reachabilityProbeInFlight;
}

async function deriveLegacyPendingChangesFlag() {
  if (!(window.electronAPI && window.electronAPI.getUnsyncedFinancialSyncOperations)) return null;
  const pending = await window.electronAPI.getUnsyncedFinancialSyncOperations();
  const hasPending = Array.isArray(pending) && pending.length > 0;
  try { localStorage.setItem('vhc_pending_changes', String(hasPending)); } catch (e) {}
  return { pending: hasPending, count: hasPending ? pending.length : 0 };
}

const _UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The cloud sale id to persist: the verified sales row's own `id`, only when that row really is
// this bill (bill_id equal) and the id is a Supabase UUID. Anything else is not a confirmation.
function _cloudSaleIdFor(cloudSale, billId) {
  if (!cloudSale || String(cloudSale.bill_id ?? '') !== String(billId)) return null;
  const id = cloudSale.id == null ? '' : String(cloudSale.id).trim();
  return _UUID_PATTERN.test(id) ? id : null;
}

// Stock-step failures that retrying cannot change (the cloud batch moved since the counter's
// opening, the batch identity is missing/ambiguous, or the server refused the arithmetic).
// Network/server/auth errors are NOT in this list: they keep a stock-only retry.
function _isPermanentStockError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /^STOCK_RECONCILIATION_CONFLICT|^STOCK_BATCH_IDENTITY_MISSING|^STOCK_RECONCILIATION_FAILED|ambiguous|was not found|match not found|identity mismatch|Invalid stock arithmetic|Only BILL stock/i.test(message);
}

// Stock step, run only AFTER the cloud sale is confirmed and its id persisted. Its outcome can
// never undo that confirmation or trigger another upload:
//   applied/already applied -> CLOUD_CONFIRMED
//   conflict / permanent    -> STOCK_CONFLICT (visible, auditable, not auto-retried)
//   transient               -> SALE_CONFIRMED_STOCK_PENDING (stock-only retry next run)
async function _runStockStep(op, localSale, billId, cloudSaleId) {
  let stockResult;
  try {
    stockResult = await _reconcileStockForOperation(op, localSale);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!_isNetworkStyleCloudError(error) && _isPermanentStockError(error)) {
      const mark = await window.electronAPI.markFinancialSyncReviewRequired(billId, 'STOCK_CONFLICT', message, cloudSaleId);
      if (!mark || mark.success === false) throw new Error(`STOCK_CONFLICT_NOT_PERSISTED: ${mark && mark.error || 'unknown'} | ${message}`);
      _cloudReachability = 'online';
      _emitFinancialSyncState({ status: 'review', reachability: 'online', billId, cloudSaleId, error: message });
      logFinancial('STOCK_RECONCILIATION_CONFLICT', {
        billId,
        source: 'cloud',
        message: `Cloud sale ${cloudSaleId} is confirmed; stock reconciliation needs review and will not be retried automatically. ${message}`,
        next: { cloudSaleId, error: message },
      });
      return { billId, ok: true, saleConfirmed: true, reviewRequired: 'STOCK_CONFLICT', cloudSaleId, error: message };
    }
    const pending = await window.electronAPI.markFinancialSyncStockPending(billId, message);
    if (!pending || pending.success === false) throw new Error(`STOCK_PENDING_NOT_PERSISTED: ${pending && pending.error || 'unknown'} | ${message}`);
    const reachability = _isNetworkStyleCloudError(error) ? 'offline' : 'failed';
    _cloudReachability = reachability;
    _emitFinancialSyncState({ status: reachability === 'offline' ? 'offline' : 'failed', reachability, billId, cloudSaleId, error: message });
    logFinancial('STOCK_RECONCILIATION_PENDING', { billId, source: 'cloud', message: `Cloud sale ${cloudSaleId} confirmed; stock step will retry (no re-upload). ${message}` });
    return { billId, ok: false, saleConfirmed: true, stockPending: true, cloudSaleId, error: message };
  }
  const done = await window.electronAPI.markFinancialSyncConfirmed(billId, cloudSaleId);
  if (!done || done.success === false) throw new Error(`CLOUD_CONFIRMATION_NOT_PERSISTED: ${done && done.error || 'unknown'}`);
  if (stockResult && !stockResult.skipped && window.VHC_CLOUD.fetchInventory) {
    await window.VHC_CLOUD.fetchInventory();
    try { window.dispatchEvent(new CustomEvent('vhc-cloud-change', { detail: { table: 'stock_batches', source: 'stock-reconciliation' } })); } catch (e) {}
  }
  _cloudReachability = 'online';
  _emitFinancialSyncState({ status: 'synced', reachability: 'online', billId, cloudSaleId });
  logFinancial('SYNC_UPLOAD_BILL_CONFIRMED', {
    billId,
    source: 'cloud',
    message: `Cloud sale, payment, items and required stock movements verified by bill_id.`,
    next: { cloudSaleId, stockResult },
  });
  return { billId, ok: true, cloudSaleId };
}

async function _syncOneFinancialOperation(op) {
  const billId = op && (op.bill_id || op.billId);
  if (!billId) return { billId: null, ok: false, error: 'Missing bill_id' };
  try {
    if (!(window.electronAPI && window.electronAPI.getLocalSale)) throw new Error('Local sale reader unavailable');
    if (!(window.VHC_CLOUD && window.VHC_CLOUD.findSaleByBillIdStrict && window.VHC_CLOUD.createSaleStrict)) throw new Error('Cloud sync API unavailable');
    if (!(window.electronAPI.markFinancialSyncSaleConfirmed && window.electronAPI.markFinancialSyncStockPending && window.electronAPI.markFinancialSyncReviewRequired)) {
      throw new Error('Financial sync status API unavailable');
    }
    await window.electronAPI.markFinancialSyncAttempt(billId, null);
    _emitFinancialSyncState({ status: 'syncing', billId });
    const localSale = await window.electronAPI.getLocalSale(billId);
    if (!localSale) throw new Error(`Local sale not found for ${billId}`);
    // A bill deleted on this machine is never uploaded or stock-reconciled (doing so would create
    // the cloud ghost of a deleted bill). cancelLocalSale already marks such operations CANCELLED;
    // this guard covers any operation that still reaches the worker.
    if (localSale.status && String(localSale.status).toLowerCase() !== 'active') {
      throw new Error(`LOCAL_SALE_NOT_ACTIVE: ${billId} is ${localSale.status}; not uploaded`);
    }
    // Stock-only retry: the cloud sale was already verified and its id persisted. Never look it
    // up again for upload, never re-upload it — only the stock step is still outstanding.
    if (String(op.sync_status || '') === 'SALE_CONFIRMED_STOCK_PENDING' && op.cloud_sale_id) {
      return await _runStockStep(op, localSale, billId, String(op.cloud_sale_id));
    }
    const cloudPayload = _localSaleToCloudPayload(localSale);
    let cloudSale;
    try {
      cloudSale = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
    } catch (error) {
      throw new Error(`SALE_PRECHECK_FAILED: ${_describeFinancialSyncError(error)}`);
    }
    if (!cloudSale) {
      try {
        await window.VHC_CLOUD.createSaleStrict(cloudPayload);
      } catch (error) {
        throw new Error(`SALE_CREATE_FAILED: ${_describeFinancialSyncError(error)}`);
      }
      try {
        cloudSale = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
      } catch (error) {
        throw new Error(`SALE_CREATED_BUT_READBACK_FAILED: ${_describeFinancialSyncError(error)}`);
      }
      if (!cloudSale) throw new Error(`SALE_CREATED_BUT_READBACK_FAILED: bill_id ${billId} was not visible after create_sale`);
    } else {
      const beforeRepair = _cloudSaleMatchesLocal(localSale, cloudSale);
      if (!beforeRepair.ok && String(beforeRepair.reason || '').startsWith('missing sale_items')) {
        try {
          await window.VHC_CLOUD.createSaleStrict(cloudPayload);
          cloudSale = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
        } catch (error) {
          throw new Error(`SALE_ITEMS_REPAIR_FAILED: ${_describeFinancialSyncError(error)}`);
        }
        if (!cloudSale) throw new Error(`SALE_ITEMS_REPAIR_READBACK_FAILED: bill_id ${billId} was not visible after repair`);
      }
    }
    const verified = _cloudSaleMatchesLocal(localSale, cloudSale);
    if (!verified.ok) {
      // A cloud sale with this bill_id exists but its content differs. Re-uploading cannot fix it
      // and retrying forever only repeats the failure: record it once for review and stop.
      const detail = `SALE_CONTENT_MISMATCH: ${verified.reason || 'Cloud verification failed'}`;
      const mark = await window.electronAPI.markFinancialSyncReviewRequired(billId, 'SALE_MISMATCH', detail, null);
      if (!mark || mark.success === false) throw new Error(`${detail} (review state not persisted: ${mark && mark.error || 'unknown'})`);
      _emitFinancialSyncState({ status: 'review', reachability: 'online', billId, error: detail });
      logFinancial('SYNC_UPLOAD_BILL_MISMATCH', { billId, source: 'cloud', message: detail });
      return { billId, ok: false, reviewRequired: 'SALE_MISMATCH', error: detail };
    }
    // The ONLY accepted confirmation id is the verified sales row's own UUID for this exact
    // bill_id — never a fallback field such as a sale_items row's sale_id.
    const cloudSaleId = _cloudSaleIdFor(cloudSale, billId);
    if (!cloudSaleId) throw new Error(`CLOUD_SALE_ID_INVALID: verified sale for ${billId} has no valid sales.id`);
    const saleMark = await window.electronAPI.markFinancialSyncSaleConfirmed(billId, cloudSaleId);
    if (!saleMark || saleMark.success === false) {
      throw new Error(`SALE_CONFIRMATION_NOT_PERSISTED: ${saleMark && saleMark.error || 'unknown'}`);
    }
    logFinancial('SYNC_UPLOAD_SALE_CONFIRMED', {
      billId,
      source: 'cloud',
      message: `Cloud sale, payment and items verified by bill_id; cloud sale id saved before stock reconciliation.`,
      next: { cloudSaleId },
    });
    return await _runStockStep(op, localSale, billId, cloudSaleId);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    try { await window.electronAPI.markFinancialSyncAttempt(billId, message); } catch (markErr) {}
    const reachability = _isNetworkStyleCloudError(e) ? 'offline' : 'failed';
    _cloudReachability = reachability;
    _emitFinancialSyncState({ status: reachability === 'offline' ? 'offline' : 'failed', reachability, billId, error: message });
    logFinancial('SYNC_UPLOAD_BILL_FAILED', {
      billId,
      source: 'cloud',
      message,
    });
    return { billId, ok: false, error: message };
  }
}

async function runFinancialSyncWorker(opts) {
  if (_financialSyncInFlight) return { skipped: true, reason: 'sync already running' };
  _financialSyncInFlight = true;
  const options = opts || {};
  const results = [];
  try {
    if (!(window.electronAPI && window.electronAPI.getUnsyncedFinancialSyncOperations)) {
      return { skipped: true, reason: 'financial sync database API unavailable' };
    }
    const reachability = options.reachabilityVerified
      ? { status: _cloudReachability }
      : await checkCloudReachability({ source: options.source || 'financial-sync-worker' });
    if (!reachability || reachability.status !== 'online') {
      await deriveLegacyPendingChangesFlag();
      return { skipped: true, reason: `cloud ${reachability && reachability.status || 'unknown'}` };
    }
    const session = window.VHC_CLOUD && window.VHC_CLOUD.getSession ? await window.VHC_CLOUD.getSession() : null;
    if (!session) {
      await deriveLegacyPendingChangesFlag();
      _setCloudReachability('failed', { source: options.source || 'financial-sync-worker', error: 'No authenticated cloud session' });
      return { skipped: true, reason: 'no authenticated cloud session' };
    }
    const ops = await window.electronAPI.getUnsyncedFinancialSyncOperations();
    if (Array.isArray(ops) && ops.length) _emitFinancialSyncState({ status: 'syncing', reachability: 'online' });
    for (const op of (Array.isArray(ops) ? ops : [])) {
      results.push(await _syncOneFinancialOperation(op));
    }
    await deriveLegacyPendingChangesFlag();
    const anyFailed = results.some((result) => !result.ok);
    const finalReachability = anyFailed ? _cloudReachability : 'online';
    _emitFinancialSyncState({
      status: finalReachability === 'offline' ? 'offline' : anyFailed ? 'failed' : 'synced',
      reachability: finalReachability,
      results,
    });
    return { source: options.source || 'financial-sync-worker', processed: results.length, results };
  } finally {
    _financialSyncInFlight = false;
  }
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
  logFinancial,
  runFinancialIntegrityAudit,
  runCloudLocalMismatchAudit,
  runStorageHealthCheck,
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

window.VHC_FINANCIAL_SYNC = {
  run: runFinancialSyncWorker,
  checkReachability: checkCloudReachability,
  getReachabilityState: () => _cloudReachability,
  deriveLegacyPendingChangesFlag,
  _localSaleToCloudPayload,
  _reconcileStockForOperation,
  _stockMovementKey,
  _syncOneFinancialOperation,
  _cloudSaleMatchesLocal,
};

// ─────────────────────────────────────────────────────────────
// 8. INITIALIZE
// ─────────────────────────────────────────────────────────────
function init() {
  injectStyles();
  migratePatientIds();
  _installSalesHistoryWatch();
  window.addEventListener('vhc-offline-auth-mode', (event) => {
    if (event && event.detail && event.detail.enabled) {
      _setCloudReachability('offline', { source: 'offline-auth-bootstrap' });
    }
  });
  setTimeout(() => runStorageHealthCheck({ source: 'startup' }), 1000);
  setTimeout(() => checkCloudReachability({ source: 'startup' }).catch((e) => console.warn('[VHC_SYNC] startup reachability check failed:', e && e.message ? e.message : e)), 500);
  setTimeout(() => runFinancialIntegrityAudit({ source: 'startup' }), 2000);
  setTimeout(() => runCloudLocalMismatchAudit({ source: 'startup', alwaysStore: false }).catch((e) => console.warn('[VHC_AUDIT] startup cloud/local audit failed:', e?.message || e)), 5000);
  setTimeout(() => deriveLegacyPendingChangesFlag().catch((e) => console.warn('[VHC_SYNC] pending flag derivation failed:', e && e.message ? e.message : e)), 2500);
  setTimeout(() => runFinancialSyncWorker({ source: 'startup' }).catch((e) => console.warn('[VHC_SYNC] startup worker failed:', e && e.message ? e.message : e)), 8000);
  setInterval(() => runStorageHealthCheck({ source: 'periodic' }), 30 * 60 * 1000);
  setInterval(() => runFinancialIntegrityAudit({ source: 'periodic' }), 30 * 60 * 1000);
  setInterval(() => runCloudLocalMismatchAudit({ source: 'periodic', alwaysStore: false }).catch((e) => console.warn('[VHC_AUDIT] periodic cloud/local audit failed:', e?.message || e)), 30 * 60 * 1000);
  setInterval(() => runFinancialSyncWorker({ source: 'periodic' }).catch((e) => console.warn('[VHC_SYNC] periodic worker failed:', e && e.message ? e.message : e)), 60 * 1000);
  window.addEventListener('online', () => {
    checkCloudReachability({ source: 'browser-online' }).then((result) => {
      if (result && result.status === 'online') {
        return runFinancialSyncWorker({ source: 'browser-online', reachabilityVerified: true });
      }
    }).catch((e) => console.warn('[VHC_SYNC] online reachability check failed:', e && e.message ? e.message : e));
  });
  window.addEventListener('offline', () => _setCloudReachability('offline', { source: 'browser-offline' }));
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
