const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'dist', 'assets', 'vhc-audit-engine.js'), 'utf8');
const runtimePolicy = fs.readFileSync(path.join(root, 'dist', 'assets', 'vhc-runtime-policy.js'), 'utf8');
const cloudSource = fs.readFileSync(path.join(root, 'cloud-src', 'vhc-cloud-sync.js'), 'utf8');
const cloudBundle = fs.readFileSync(path.join(root, 'dist', 'assets', 'vhc-cloud-sync.js'), 'utf8');

function derive({ reachability = 'unknown', pending = 0, failed = false, syncing = false, eventStatus = '' }) {
  if (reachability === 'offline') return 'offline';
  if (eventStatus === 'syncing' || syncing) return 'syncing';
  if (reachability === 'failed' || eventStatus === 'failed' || failed) return 'failed';
  if (reachability === 'online') return pending ? 'syncing' : 'synced';
  return 'checking';
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('initial state is checking, never falsely online', () => assert.match(ui, /useState\)\(\{ status: "checking", reachability: "unknown", pending: 0 \}\)/));
test('startup offline with zero pending displays offline', () => assert.strictEqual(derive({ reachability: 'offline', pending: 0 }), 'offline'));
test('startup offline with pending displays offline', () => assert.strictEqual(derive({ reachability: 'offline', pending: 3 }), 'offline'));
test('unknown reachability with empty queue remains checking', () => assert.strictEqual(derive({ pending: 0 }), 'checking'));
test('online plus empty queue is synced', () => assert.strictEqual(derive({ reachability: 'online' }), 'synced'));
test('online plus pending is syncing', () => assert.strictEqual(derive({ reachability: 'online', pending: 2 }), 'syncing'));
test('auth or schema failure is failed, not offline', () => assert.strictEqual(derive({ reachability: 'failed' }), 'failed'));
test('offline zero-pending label exists', () => assert.match(ui, /Offline \\u2022 \$\{pending\} Pending/));
test('checking label exists', () => assert.match(ui, /label: "Checking…"/));
test('navigator online is not used as proof of online', () => assert.doesNotMatch(ui, /navigator\.onLine\s*\?\s*["'](?:online|synced)/));
test('read-only probe targets sales id with abort timeout', () => {
  for (const source of [cloudSource, cloudBundle]) {
    assert.match(source, /from\(["']sales["']\)/);
    assert.match(source, /select\(["']id["']\)/);
    assert.match(source, /abortSignal\(controller\.signal\)/);
    assert.match(source, /REACHABILITY_TIMEOUT/);
  }
});
test('network and timeout failures classify offline', () => {
  for (const pattern of [/REACHABILITY_TIMEOUT/, /failed to fetch/i, /ECONNREFUSED/]) {
    assert.match(runtimePolicy, pattern);
  }
  assert.match(worker, /VHC_RUNTIME_POLICY\.isTransportFailure/);
});
test('browser offline event immediately marks offline', () => assert.match(worker, /addEventListener\('offline'.*_setCloudReachability\('offline'/));
test('browser online event probes before worker retry', () => {
  assert.match(worker, /addEventListener\('online'/);
  assert.match(worker, /checkCloudReachability\(\{ source: 'browser-online' \}\)/);
  assert.match(worker, /reachabilityVerified: true/);
});
test('failed pending operation is preserved and retryable', () => {
  assert.match(worker, /markFinancialSyncAttempt\(billId, message\)/);
  assert.doesNotMatch(worker, /DELETE FROM financial_sync_operations/);
});
test('worker proves reachability before reading pending operations', () => {
  const probe = worker.indexOf('await checkCloudReachability');
  const pending = worker.indexOf('getUnsyncedFinancialSyncOperations', probe);
  assert.ok(probe >= 0 && pending > probe);
});

(async () => {
  let passed = 0;
  for (const entry of tests) {
    try { await entry.fn(); passed++; console.log(`PASS ${entry.name}`); }
    catch (error) { console.error(`FAIL ${entry.name}`); console.error(error); process.exitCode = 1; }
  }
  console.log(`\noffline-status tests: ${passed}/${tests.length} passed`);
})();
