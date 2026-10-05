const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const policySource = fs.readFileSync(path.join(root, 'cloud-src', 'vhc-runtime-policy.js'), 'utf8');
const auditSource = fs.readFileSync(path.join(root, 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');

function createAudit({
  reachability = 'offline', localBills = [], cachedBills = [], cloudResult = [],
  rendererBills = localBills, cloudFailure, operations = [], initialAlerts = [], initialWarningType = null,
} = {}) {
  const data = new Map([
    ['vhc_pos_sales_history', JSON.stringify(rendererBills)],
    ['vhc_financial_integrity_alerts', JSON.stringify(initialAlerts)],
    ['pos_financial_audit_logs', '[]'],
  ]);
  const elements = new Map();
  const storage = {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  let fetchCalls = 0;
  const document = {
    readyState: 'loading',
    addEventListener() {},
    getElementById: (id) => elements.get(id) || null,
    createElement: () => ({
      dataset: {}, style: {},
      set innerHTML(value) { this._html = value; },
      querySelector: () => null,
      remove() { elements.delete(this.id); },
    }),
    body: { appendChild(element) { elements.set(element.id, element); } },
  };
  if (initialWarningType) {
    elements.set('vhc-financial-integrity-warning', {
      id: 'vhc-financial-integrity-warning', dataset: { vhcWarningType: initialWarningType },
      remove() { elements.delete(this.id); },
    });
  }
  const window = {
    addEventListener() {}, dispatchEvent() {},
    VHC_CLOUD: {
      checkReachability: async () => true,
      getSalesHistory: () => cachedBills,
      fetchSalesHistory: async () => {
        fetchCalls += 1;
        if (cloudFailure) throw cloudFailure;
        return cloudResult;
      },
    },
    VHC_FINANCIAL_SYNC: { getReachabilityState: () => reachability },
    electronAPI: { getFinancialIntegritySnapshot: async () => ({ success: true, sales: localBills, operations }) },
  };
  const context = vm.createContext({
    window, document, localStorage: storage, navigator: { onLine: reachability !== 'offline' },
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Map, Set, Array, Object, String,
  });
  vm.runInContext(policySource, context);
  vm.runInContext(auditSource, context);
  return {
    setReachability: async () => {
      context.navigator.onLine = reachability !== 'offline';
      return window.VHC_FINANCIAL_SYNC.checkReachability({ source: 'test' });
    },
    run: (opts) => window.VHC_AUDIT.runCloudLocalMismatchAudit(opts),
    alerts: () => JSON.parse(storage.getItem('vhc_financial_integrity_alerts') || '[]'),
    logs: () => JSON.parse(storage.getItem('pos_financial_audit_logs') || '[]'),
    warning: () => elements.get('vhc-financial-integrity-warning') || null,
    fetchCalls: () => fetchCalls,
  };
}

test('offline cached cloud-only bill skips mismatch comparison without warning', async () => {
  const audit = createAudit({ cachedBills: [{ bill_id: 'CACHED-CLOUD-1' }] });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_OFFLINE');
  assert.equal(result.cloudAuditStatus, 'UNKNOWN');
  assert.equal(result.authoritative, false);
  assert.deepEqual(Array.from(result.cloudOnly), []);
  assert.equal(audit.alerts().length, 0);
  assert.equal(audit.warning(), null);
  assert.equal(audit.fetchCalls(), 0);
});

test('offline cached cloud data with no local sales is explicitly unknown', async () => {
  const audit = createAudit({ cachedBills: [{ bill_id: 'REMOTE-BILL' }] });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_OFFLINE');
  assert.equal(result.cloudAuditStatus, 'UNKNOWN');
  assert.equal(result.localCount, undefined);
  assert.equal(audit.alerts().some((row) => row.auditType === 'LOCAL_CLOUD_MISMATCH_AUDIT'), false);
});

test('transport failure with no cloud rows is not interpreted as authoritative empty set', async () => {
  const audit = createAudit({
    reachability: 'online',
    cloudFailure: Object.assign(new TypeError('Failed to fetch'), { code: 'ERR_NETWORK' }),
    localBills: [{ billId: 'LOCAL-1' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_OFFLINE');
  assert.equal(result.authoritative, false);
  assert.equal(result.localOnly.length, 0);
  assert.equal(audit.alerts().length, 0);
});

test('transport failure returned as a cloud error object is not an authoritative empty set', async () => {
  const audit = createAudit({
    reachability: 'online', cloudResult: { error: 'Failed to fetch', code: 'ERR_NETWORK' },
    localBills: [{ billId: 'LOCAL-1' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_OFFLINE');
  assert.equal(result.authoritative, false);
  assert.deepEqual(Array.from(result.localOnly), []);
  assert.equal(audit.alerts().length, 0);
});

test('reachable cloud application error is skipped without being classified offline', async () => {
  const audit = createAudit({
    reachability: 'online', cloudResult: { error: 'Permission denied', code: '42501' },
    localBills: [{ billId: 'LOCAL-1' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_CLOUD_UNVERIFIED');
  assert.equal(result.authoritative, false);
  assert.equal(audit.alerts().length, 0);
});

test('other-terminal cloud-only bill in fresh data is shared remote data, not a mismatch', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ bill_id: 'BILL-A', status: 'active' }],
    cloudResult: [{ bill_id: 'BILL-A' }, { bill_id: 'BILL-B' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.cloudAuditStatus, 'FRESH_AUTHORITATIVE');
  assert.equal(result.authoritative, true);
  assert.deepEqual(Array.from(result.remoteOnly), ['BILL-B']);
  assert.deepEqual(Array.from(result.cloudOnly), []);
  assert.equal(audit.alerts().some((row) => row.auditType === 'LOCAL_CLOUD_MISMATCH_AUDIT'), false);
  assert.equal(audit.warning(), null);
});

test('validated packaged bill and another profile bill produce zero ownership mismatch', async () => {
  const audit = createAudit({
    reachability: 'online',
    localBills: [{ bill_id: 'BILL-1791012955384', status: 'active' }],
    cloudResult: [
      { bill_id: 'BILL-1791012955384' },
      { bill_id: 'BILL-1790968280328' },
    ],
    operations: [{
      bill_id: 'BILL-1791012955384', operation_type: 'UPLOAD_SALE',
      contract_version: 2, sync_status: 'CLOUD_CONFIRMED',
    }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), []);
  assert.deepEqual(Array.from(result.remoteOnly), ['BILL-1790968280328']);
  assert.deepEqual(Array.from(result.duplicateLocal), []);
  assert.deepEqual(Array.from(result.duplicateCloud), []);
  assert.equal(audit.alerts().length, 0);
  assert.equal(audit.warning(), null);
});

test('durable SQLite bill snapshot, not renderer Local Storage, defines local ownership', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ bill_id: 'BILL-A', status: 'active' }],
    rendererBills: [{ billId: 'STALE-RENDERER-BILL' }], cloudResult: [{ bill_id: 'BILL-A' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), []);
  assert.equal(audit.alerts().length, 0);
});

test('online fresh local-only bill without a durable pending-v2 op still warns', async () => {
  const audit = createAudit({ reachability: 'online', localBills: [{ billId: 'LOCAL-ONLY-1' }], cloudResult: [] });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), ['LOCAL-ONLY-1']);
});

test('online fresh comparison retains the contract-v2 PENDING_CLOUD exemption', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ billId: 'PENDING-1' }], cloudResult: [],
    operations: [{ bill_id: 'PENDING-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), []);
  assert.deepEqual(Array.from(result.expectedPending), ['PENDING-1']);
});

test('contract-v2 SYNCING and SYNC_FAILED local bills are expected unsynced state', async () => {
  for (const sync_status of ['SYNCING', 'SYNC_FAILED']) {
    const billId = `UNSYNCED-${sync_status}`;
    const audit = createAudit({
      reachability: 'online', localBills: [{ bill_id: billId, status: 'active' }], cloudResult: [],
      operations: [{ bill_id: billId, operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status }],
    });
    await audit.setReachability();
    const result = await audit.run();
    assert.deepEqual(Array.from(result.localOnly), []);
    assert.deepEqual(Array.from(result.expectedUnsynced), [billId]);
    assert.equal(audit.alerts().length, 0);
  }
});

test('CLOUD_CONFIRMED local bill missing from fresh cloud remains a warning', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ billId: 'CONFIRMED-1' }], cloudResult: [],
    operations: [{ bill_id: 'CONFIRMED-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'CLOUD_CONFIRMED' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), ['CONFIRMED-1']);
});

test('duplicate local bill IDs still warn while the cloud snapshot is unavailable', async () => {
  const audit = createAudit({ localBills: [{ billId: 'DUP-1' }, { billId: 'DUP-1' }] });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.status, 'SKIPPED_OFFLINE');
  assert.deepEqual(Array.from(result.duplicateLocal), ['DUP-1']);
  assert.equal(audit.alerts()[0].auditType, 'LOCAL_DUPLICATE_BILL_AUDIT');
  assert.equal(audit.warning().dataset.vhcWarningType, 'LOCAL_DUPLICATE_BILL_AUDIT');
});

test('duplicate cloud bill IDs in fresh data remain a warning', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ bill_id: 'BILL-A', status: 'active' }],
    cloudResult: [{ bill_id: 'BILL-A' }, { bill_id: 'BILL-A' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.duplicateCloud), ['BILL-A']);
  assert.equal(audit.alerts()[0].duplicateCloudCount, 1);
  assert.equal(audit.warning().dataset.vhcWarningType, 'LOCAL_CLOUD_MISMATCH_AUDIT');
});

test('confirmed operation remains responsible if its local sale row is missing', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [], cloudResult: [],
    operations: [{ bill_id: 'CONFIRMED-ORPHAN', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'CLOUD_CONFIRMED' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), ['CONFIRMED-ORPHAN']);
  assert.deepEqual(Array.from(result.orphanOperations), ['CONFIRMED-ORPHAN']);
  assert.equal(audit.alerts()[0].issueCount, 1);
});

test('deleted local bill with retained confirmed operation is not reported missing from cloud', async () => {
  const audit = createAudit({
    reachability: 'online', localBills: [{ bill_id: 'DELETED-1', status: 'deleted' }], cloudResult: [],
    operations: [{ bill_id: 'DELETED-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'CLOUD_CONFIRMED' }],
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.deepEqual(Array.from(result.localOnly), []);
  assert.equal(audit.alerts().length, 0);
});

test('fresh clean cloud audit retires only obsolete cloud mismatch warnings', async () => {
  const oldCloudWarning = { id: 'old-cloud', cloudOnlyCount: 1, localOnlyCount: 0, cloudOnly: ['OLD'] };
  const localWarning = { id: 'local-warning', issueCount: 1, issues: [{ code: 'PAYMENT_TOTAL_MISMATCH' }] };
  const audit = createAudit({
    reachability: 'online', cloudResult: [], initialAlerts: [oldCloudWarning, localWarning],
    initialWarningType: 'LOCAL_CLOUD_MISMATCH_AUDIT',
  });
  await audit.setReachability();
  const result = await audit.run();
  assert.equal(result.cloudAuditStatus, 'FRESH_AUTHORITATIVE');
  assert.deepEqual(audit.alerts().map((row) => row.id), ['local-warning']);
  assert.equal(audit.warning(), null);
});
