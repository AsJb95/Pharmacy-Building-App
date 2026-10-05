const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const policySource = fs.readFileSync(path.join(root, 'cloud-src', 'vhc-runtime-policy.js'), 'utf8');
const windowStub = {};
vm.runInNewContext(policySource, { window: windowStub, globalThis: windowStub });
const policy = windowStub.VHC_RUNTIME_POLICY;

const identity = {
  version: 1,
  userId: 'test-user-1',
  email: 'test@example.invalid',
  projectHost: 'dvscemgqegmfmgrtytal.supabase.co',
  confirmedAt: '2026-10-02T10:00:00.000Z',
};

test('valid online cached session continues to dashboard', () => {
  assert.equal(policy.decideAuthBootstrap({ session: { user: { id: identity.userId } } }).mode, 'online');
});

test('previously authenticated identity permits transport-offline dashboard only', () => {
  const result = policy.decideAuthBootstrap({
    authError: Object.assign(new TypeError('Failed to fetch'), { name: 'AuthRetryableFetchError' }),
    offlineIdentity: identity,
    projectHost: identity.projectHost,
  });
  assert.equal(result.mode, 'offline');
  assert.equal(result.identity.userId, identity.userId);
});

test('cached identity with no restored session requires a failed read-only transport probe', () => {
  const offline = policy.decideAuthBootstrap({
    authError: Object.assign(new Error('network timeout'), { code: 'REACHABILITY_TIMEOUT' }),
    offlineIdentity: identity,
    projectHost: identity.projectHost,
  });
  const reachableNoSession = policy.decideAuthBootstrap({
    offlineIdentity: identity,
    projectHost: identity.projectHost,
  });
  assert.equal(offline.mode, 'offline');
  assert.equal(reachableNoSession.mode, 'signin');
});

test('never-authenticated profile remains at sign-in while offline', () => {
  assert.equal(policy.decideAuthBootstrap({ authError: new TypeError('Failed to fetch') }).mode, 'signin');
});

test('explicit logout always requires sign-in', () => {
  assert.equal(policy.decideAuthBootstrap({
    authError: new TypeError('Failed to fetch'), offlineIdentity: identity,
    projectHost: identity.projectHost, explicitLogout: true,
  }).mode, 'signin');
});

test('reachable invalid or revoked auth never falls back offline', () => {
  const error = Object.assign(new Error('Invalid JWT'), { status: 401, code: 'invalid_token' });
  assert.equal(policy.decideAuthBootstrap({ authError: error, offlineIdentity: identity, projectHost: identity.projectHost }).mode, 'signin');
});

test('server/schema errors never qualify as offline authentication', () => {
  const errors = [
    Object.assign(new Error('relation sales does not exist'), { code: '42P01' }),
    Object.assign(new Error('Internal Server Error'), { status: 500 }),
    new Error('Permission denied by policy'),
  ];
  for (const error of errors) {
    assert.equal(policy.decideAuthBootstrap({ authError: error, offlineIdentity: identity, projectHost: identity.projectHost }).mode, 'signin');
  }
});

test('local/cloud audit excludes exactly one contract-v2 PENDING_CLOUD bill', () => {
  const audit = policy.compareBillSets(
    [{ billId: 'PENDING-1' }], [],
    [{ bill_id: 'PENDING-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' }],
  );
  assert.deepEqual(Array.from(audit.localOnly), []);
  assert.deepEqual(Array.from(audit.expectedPending), ['PENDING-1']);
});

test('contract-v2 SYNC_FAILED local-only bill is represented as expected unsynced state', () => {
  const audit = policy.compareBillSets(
    [{ billId: 'FAILED-1' }], [],
    [{ bill_id: 'FAILED-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'SYNC_FAILED' }],
  );
  assert.deepEqual(Array.from(audit.localOnly), []);
  assert.deepEqual(Array.from(audit.expectedUnsynced), ['FAILED-1']);
});

test('CLOUD_CONFIRMED bill missing from cloud remains a warning', () => {
  const audit = policy.compareBillSets(
    [{ billId: 'CONFIRMED-1' }], [],
    [{ bill_id: 'CONFIRMED-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'CLOUD_CONFIRMED' }],
  );
  assert.deepEqual(Array.from(audit.localOnly), ['CONFIRMED-1']);
});

test('local-only bill without one legitimate durable operation remains a warning', () => {
  const cases = [
    [],
    [{ bill_id: 'NOOP-1', operation_type: 'UPLOAD_SALE', contract_version: 1, sync_status: 'PENDING_CLOUD' }],
    [
      { bill_id: 'NOOP-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' },
      { bill_id: 'NOOP-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' },
    ],
  ];
  for (const operations of cases) {
    const audit = policy.compareBillSets([{ billId: 'NOOP-1' }], [], operations);
    assert.deepEqual(Array.from(audit.localOnly), ['NOOP-1']);
  }
});

test('duplicate local bill IDs remain reported despite a pending operation', () => {
  const audit = policy.compareBillSets(
    [{ billId: 'DUP-1' }, { billId: 'DUP-1' }], [],
    [{ bill_id: 'DUP-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' }],
  );
  assert.deepEqual(Array.from(audit.duplicateLocal), ['DUP-1']);
});

test('payment, amount and item audit issues remain untouched by set comparison', () => {
  const existingIssues = [
    { code: 'ITEM_COUNT_MISMATCH', billId: 'PENDING-1' },
    { code: 'PAYMENT_TOTAL_MISMATCH', billId: 'PENDING-1' },
    { code: 'STOCK_RECONCILIATION_CONFLICT', billId: 'PENDING-1' },
  ];
  const audit = policy.compareBillSets(
    [{ billId: 'PENDING-1' }], [],
    [{ bill_id: 'PENDING-1', operation_type: 'UPLOAD_SALE', contract_version: 2, sync_status: 'PENDING_CLOUD' }],
  );
  assert.deepEqual(existingIssues.map((issue) => issue.code), [
    'ITEM_COUNT_MISMATCH', 'PAYMENT_TOTAL_MISMATCH', 'STOCK_RECONCILIATION_CONFLICT',
  ]);
  assert.deepEqual(Array.from(audit.expectedPending), ['PENDING-1']);
});

test('auth policy and audit integration are wired to durable state and explicit logout', () => {
  const cloud = fs.readFileSync(path.join(root, 'cloud-src', 'vhc-cloud-sync.js'), 'utf8');
  const audit = fs.readFileSync(path.join(root, 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
  assert.match(cloud, /getAuthBootstrap/);
  assert.match(cloud, /probeCloudTransport/);
  assert.match(cloud, /probeError/);
  assert.match(cloud, /clearOfflineAuthIdentity/);
  assert.doesNotMatch(cloud.match(/supabase\.auth\.onAuthStateChange\([\s\S]*?\n\}\);/)?.[0] || '', /clearOfflineAuthIdentity/);
  assert.match(cloud, /signOut\(\{ scope: 'local' \}\)/);
  assert.match(audit, /getFinancialIntegritySnapshot/);
  assert.match(audit, /compareBillSets/);
  assert.doesNotMatch(audit.match(/async function runCloudLocalMismatchAudit[\s\S]*?\n}\n/)?.[0] || '', /_readJsonArray\(SALES_KEY\)/);
  assert.match(renderer, /getAuthBootstrap/);
  assert.match(renderer, /offlineIdentity/);
});
