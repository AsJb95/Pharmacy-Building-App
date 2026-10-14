(function (root) {
  'use strict';

  const TRANSPORT_CODES = new Set([
    'REACHABILITY_TIMEOUT', 'ABORT_ERR', 'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED',
    'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ]);
  const TRANSPORT_MESSAGES = /failed to fetch|fetch failed|networkerror when attempting to fetch|network request failed|err_internet_disconnected|err_name_not_resolved|err_connection_(?:closed|reset|refused|timed_out)|unable to connect|socket hang up/i;

  function isTransportFailure(error) {
    const seen = new Set();
    let current = error;
    for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
      if (typeof current === 'string') return TRANSPORT_MESSAGES.test(current);
      if (typeof current !== 'object') break;
      seen.add(current);
      const code = String(current.code || '').toUpperCase();
      if (TRANSPORT_CODES.has(code)) return true;
      if (TRANSPORT_MESSAGES.test(String(current.message || ''))) return true;
      current = current.cause || current.originalError || null;
    }
    return false;
  }

  function validOfflineIdentity(identity, projectHost) {
    if (!identity || identity.version !== 1) return false;
    if (typeof identity.userId !== 'string' || !identity.userId.trim()) return false;
    if (typeof identity.email !== 'string' || !identity.email.trim()) return false;
    if (typeof identity.projectHost !== 'string' || identity.projectHost !== projectHost) return false;
    const confirmedAt = Date.parse(identity.confirmedAt || '');
    return Number.isFinite(confirmedAt) && confirmedAt <= Date.now();
  }

  function decideAuthBootstrap({ session, authError, verificationError, offlineIdentity, projectHost, explicitLogout } = {}) {
    if (explicitLogout) return { mode: 'signin', reason: 'explicit-logout' };
    const error = verificationError || authError || null;
    if (session && !error) return { mode: 'online', session };
    if (!isTransportFailure(error)) return { mode: 'signin', reason: error ? 'auth-or-application-error' : 'no-session' };
    if (!validOfflineIdentity(offlineIdentity, projectHost)) return { mode: 'signin', reason: 'no-verified-offline-identity' };
    return {
      mode: 'offline',
      identity: { userId: offlineIdentity.userId, email: offlineIdentity.email },
    };
  }

  function compareBillSets(localBills, cloudRows, operations) {
    const locals = Array.isArray(localBills) ? localBills : [];
    const clouds = Array.isArray(cloudRows) ? cloudRows : [];
    const ops = Array.isArray(operations) ? operations : [];
    const idOf = (row) => row && (row.billId || row.bill_id) ? String(row.billId || row.bill_id) : '';
    const isDeleted = (row) => ['deleted', 'cancelled', 'canceled'].includes(String(row && row.status || '').toLowerCase());
    const activeLocals = locals.filter((row) => !isDeleted(row));
    const allLocalIds = new Set(locals.map(idOf).filter(Boolean));
    const deletedLocalIds = new Set(locals.filter(isDeleted).map(idOf).filter(Boolean));
    const localIds = new Set(activeLocals.map(idOf).filter(Boolean));
    const activeClouds = clouds.filter((row) => !isDeleted(row) && !row.deleted_at && !row.cancelled_at && !row.canceled_at);
    const cloudIds = new Set(activeClouds.map(idOf).filter(Boolean));
    const duplicateLocal = [];
    const seen = new Set();
    for (const bill of activeLocals) {
      const id = idOf(bill);
      if (!id) continue;
      if (seen.has(id) && !duplicateLocal.includes(id)) duplicateLocal.push(id);
      seen.add(id);
    }

    const duplicateCloud = [];
    const seenCloud = new Set();
    for (const sale of activeClouds) {
      const id = idOf(sale);
      if (!id) continue;
      if (seenCloud.has(id) && !duplicateCloud.includes(id)) duplicateCloud.push(id);
      seenCloud.add(id);
    }

    const opsByBill = new Map();
    for (const op of ops) {
      if (!op || op.operation_type !== 'UPLOAD_SALE' || !op.bill_id) continue;
      const id = String(op.bill_id);
      if (!opsByBill.has(id)) opsByBill.set(id, []);
      opsByBill.get(id).push(op);
    }
    const expectedPending = [];
    const expectedUnsynced = [];
    const localOnly = [];
    for (const id of localIds) {
      if (cloudIds.has(id)) continue;
      const matchingOps = opsByBill.get(id) || [];
      const op = matchingOps[0];
      const syncStatus = String(op && op.sync_status || '').toUpperCase();
      if (matchingOps.length === 1 && Number(op.contract_version) === 2 &&
          ['PENDING_CLOUD', 'SYNCING', 'SYNC_FAILED'].includes(syncStatus)) {
        expectedUnsynced.push(id);
        if (syncStatus === 'PENDING_CLOUD') expectedPending.push(id);
      } else {
        localOnly.push(id);
      }
    }

    for (const [id, matchingOps] of opsByBill) {
      if (cloudIds.has(id) || deletedLocalIds.has(id)) continue;
      if (!allLocalIds.has(id) && matchingOps.some((op) => ['CLOUD_CONFIRMED', 'SALE_CONFIRMED_STOCK_PENDING', 'STOCK_CONFLICT'].includes(String(op.sync_status).toUpperCase()))) {
        localOnly.push(id);
      }
    }

    const orphanOperations = [];
    for (const [id] of opsByBill) {
      if (!allLocalIds.has(id)) orphanOperations.push(id);
    }
    const deletedLocalCloudPresent = Array.from(deletedLocalIds).filter((id) => cloudIds.has(id)).sort();
    const remoteOnly = Array.from(cloudIds).filter((id) => !localIds.has(id) && !opsByBill.has(id)).sort();

    return {
      cloudOnly: [],
      remoteOnly,
      localOnly: Array.from(new Set(localOnly)).sort(),
      expectedPending: expectedPending.sort(),
      expectedUnsynced: expectedUnsynced.sort(),
      duplicateLocal: duplicateLocal.sort(),
      duplicateCloud: duplicateCloud.sort(),
      orphanOperations: orphanOperations.sort(),
      deletedLocalCloudPresent,
    };
  }

  root.VHC_RUNTIME_POLICY = { isTransportFailure, validOfflineIdentity, decideAuthBootstrap, compareBillSets };
})(typeof window !== 'undefined' ? window : globalThis);
