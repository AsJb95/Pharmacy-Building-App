'use strict';
// Behaviour tests for the manual stock-correction client paths (no network, no database).
// The REAL function source is extracted from BOTH cloud-src/vhc-cloud-sync.js and the shipped bundle
// dist/assets/vhc-cloud-sync.js and executed against a scripted fake Supabase, so the two copies are proven
// to behave identically. The Edit Item save handler (N) and the provider's updateItem are extracted from
// dist/assets/index-doBKNLAj.js and run with spied React setters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

function between(src, startMarker, endMarker, from = 0) {
  const a = src.indexOf(startMarker, from);
  if (a < 0) throw new Error('marker not found: ' + startMarker.slice(0, 60));
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error('end marker not found after: ' + startMarker.slice(0, 60));
  return src.slice(a, b + endMarker.length);
}
function extractCloud(file, indent) {
  const src = read(file);
  const close = '\n' + indent + '}';
  return [
    between(src, '// ─── Manual stock corrections', '\n' + indent + 'async function updateInventoryItem(').replace(new RegExp('\\n' + indent + 'async function updateInventoryItem\\($'), ''),
    between(src, 'async function updateInventoryItem(', close),
    between(src, 'async function adjustStockBulk(', close),
    between(src, 'async function acceptPharmacyTransfer(', close),
  ].join('\n');
}
function load(file, indent) {
  const code = extractCloud(file, indent);
  const factory = new Function('supabase', 'env', `
    let inventoryCache = env.cache;
    const ensurePharmacyLocation = async () => 'LOC-PHARMACY';
    const fetchInventory = async () => { env.fetched++; return inventoryCache; };
    const expiryToISODate = (x) => x;
    const cacheSet = () => {};
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    ${code}
    return { updateInventoryItem, adjustStockBulk, acceptPharmacyTransfer, manualStockReasonProblem, newStockRequestKey, describeStockStatus };`);
  return factory;
}
// Scripted fake Supabase: records every call; responses come from handlers.
function fake(handlers = {}) {
  const calls = [];
  const builder = (table) => {
    const ops = [];
    const b = {};
    for (const m of ['update', 'insert', 'eq', 'is', 'select', 'maybeSingle']) b[m] = (...a) => { ops.push([m, ...a]); return b; };
    b.then = (res, rej) => Promise.resolve().then(() => { calls.push({ table, ops }); return (handlers.from || (() => ({ data: [{ id: 'x' }], error: null })))(table, ops); }).then(res, rej);
    return b;
  };
  return {
    calls,
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return (handlers.rpc || (() => ({ data: { status: 'APPLIED' }, error: null })))(name, args); },
    from: builder,
  };
}
const writesTo = (calls, table) => calls.filter((c) => c.table === table && c.ops.some((o) => o[0] === 'update' || o[0] === 'insert'));
const ITEM = { id: 'batch-1', itemId: 'item-1', name: 'TEST Paracetamol', batch: 'B-1', stock: 25, category: 'medicine', unitsPerPack: 10 };
const envFor = () => ({ cache: [{ ...ITEM }, { id: 'batch-2', itemId: 'item-1', name: 'TEST Para B2', batch: 'B-2', stock: 4 }], fetched: 0 });
const KEY = '0c4a1b2e-7f00-4c3e-9d2a-1234567890ab';

for (const [label, file, indent] of [['cloud-src', 'cloud-src/vhc-cloud-sync.js', ''], ['dist bundle', 'dist/assets/vhc-cloud-sync.js', '  ']]) {
  const factory = load(file, indent);
  const mk = (handlers) => { const sb = fake(handlers), env = envFor(); return { sb, env, api: factory(sb, env) }; };

  test(`[${label}] CONFLICT_TRANSFER_UNIT is explained (nothing transferred, still Pending)`, async () => {
    const { api } = mk();
    const msg = api.describeStockStatus({ status: 'CONFLICT_TRANSFER_UNIT', name: 'X Tab', transfer_unit: 'strips', units_per_pack: null });
    assert.match(msg, /"X Tab" has a missing or unknown unit \(unit: strips, pack size: none\)/); assert.match(msg, /Nothing was transferred; the request is still Pending/);
  });
  test(`[${label}] NOT_PERMITTED from any stock RPC is surfaced as a permission message (not "not found")`, async () => {
    const { api } = mk();
    const msg = api.describeStockStatus({ status: 'NOT_PERMITTED' });
    assert.match(msg, /not allowed/); assert.match(msg, /Nothing was changed/); assert.doesNotMatch(msg, /not found/i);
    for (const call of [
      (a) => a.updateInventoryItem('batch-1', { stock: 30 }, 'Recount: 5 strips found', { expectedStock: 25, requestKey: KEY }),
      (a) => a.acceptPharmacyTransfer('0c4a1b2e-7f00-4c3e-9d2a-1234567890ff'),
    ]) {
      const { sb, api: a } = mk({ rpc: () => ({ data: { status: 'NOT_PERMITTED' }, error: null }) });
      await assert.rejects(call(a), (e) => e.code === 'NOT_PERMITTED' && /not allowed/.test(e.message));
      assert.equal(writesTo(sb.calls, 'stock_batches').length + writesTo(sb.calls, 'stock_movements').length, 0, 'no direct write fallback');
    }
  });
  test(`[${label}] generic / missing reason is rejected before any network call`, async () => {
    for (const reason of [undefined, '', '  ', 'UPDATE', 'update.', 'Stock update', 'n/a', 'edit']) {
      const { sb, api } = mk();
      await assert.rejects(api.updateInventoryItem('batch-1', { stock: 30 }, reason, { expectedStock: 25, requestKey: KEY }), (e) => e.code === 'REJECTED_REASON');
      assert.equal(sb.calls.length, 0, `no call for reason ${JSON.stringify(reason)}`);
    }
  });
  test(`[${label}] stock change goes ONLY through apply_stock_correction with the caller's key and starting quantity`, async () => {
    const { sb, api } = mk({ rpc: () => ({ data: { status: 'APPLIED', opening: 25, closing: 27.5 }, error: null }) });
    await api.updateInventoryItem('batch-1', { stock: 27.5, mrp: 12 }, ' Recount: 2.5 strips found ', { expectedStock: 25, requestKey: KEY });
    const rpc = sb.calls.find((c) => c.rpc);
    assert.equal(rpc.rpc, 'apply_stock_correction');
    assert.deepEqual(rpc.args.payload, { request_key: KEY, stock_batch_id: 'batch-1', expected_qty: 25, new_qty: 27.5, reason: 'Recount: 2.5 strips found' });
    assert.ok(!('created_by' in rpc.args.payload), 'actor is never sent by the client');
    assert.equal(writesTo(sb.calls, 'stock_movements').length, 0, 'no direct movement insert');
    const upd = writesTo(sb.calls, 'stock_batches');
    assert.equal(upd.length, 1); assert.ok(!('qty' in upd[0].ops.find((o) => o[0] === 'update')[1]), 'plain batch update never carries qty');
    assert.ok(sb.calls.indexOf(rpc) < sb.calls.indexOf(upd[0]), 'stock correction before the other fields');
  });
  test(`[${label}] server refusal (stale) -> error with code, nothing else written`, async () => {
    const { sb, api } = mk({ rpc: () => ({ data: { status: 'CONFLICT_STALE_OPENING', expected_qty: 25, current_qty: 21 }, error: null }) });
    await assert.rejects(api.updateInventoryItem('batch-1', { stock: 30, mrp: 9 }, 'Recount after audit', { expectedStock: 25, requestKey: KEY }),
      (e) => e.code === 'CONFLICT_STALE_OPENING' && /now 21/.test(e.message) && /Nothing was saved/.test(e.message));
    assert.equal(writesTo(sb.calls, 'stock_batches').length, 0);
  });
  test(`[${label}] database error / RPC not installed -> refused, never falls back to direct writes`, async () => {
    for (const err of [{ code: 'PGRST202', message: 'Could not find the function public.apply_stock_correction' }, { code: '40001', message: 'could not serialize' }]) {
      const { sb, api } = mk({ rpc: () => ({ data: null, error: err }) });
      await assert.rejects(api.updateInventoryItem('batch-1', { stock: 30 }, 'Recount after audit', { expectedStock: 25, requestKey: KEY }),
        (e) => (err.code === 'PGRST202' ? e.code === 'RPC_MISSING' : e === err || e.code === err.code));
      assert.equal(writesTo(sb.calls, 'stock_batches').length + writesTo(sb.calls, 'stock_movements').length, 0);
    }
  });
  test(`[${label}] correction saved but other fields not written -> STOCK_SAVED_DETAILS_FAILED (never silent success)`, async () => {
    const { api } = mk({ rpc: () => ({ data: { status: 'APPLIED' }, error: null }), from: () => ({ data: [], error: null }) });
    await assert.rejects(api.updateInventoryItem('batch-1', { stock: 30, mrp: 9 }, 'Recount after audit', { expectedStock: 25, requestKey: KEY }),
      (e) => e.code === 'STOCK_SAVED_DETAILS_FAILED' && /WAS saved/.test(e.message));
    const m2 = mk({ from: () => ({ data: null, error: { message: 'permission denied' } }) });
    await assert.rejects(m2.api.updateInventoryItem('batch-1', { mrp: 9, stock: 25 }, undefined, { expectedStock: 25 }), (e) => e.code === 'DETAILS_NOT_SAVED');
  });
  test(`[${label}] unchanged stock (incl. fractional / display-rewritten values) never calls the correction`, async () => {
    const { sb, api } = mk();
    await api.updateInventoryItem('batch-1', { stock: 25, mrp: 9 }, undefined, { expectedStock: 25 });
    await api.updateInventoryItem('batch-1', { stock: 2200, mrp: 9 }, undefined, { expectedStock: 2200 }); // UI showed 2200 although cache is 25
    assert.equal(sb.calls.filter((c) => c.rpc).length, 0);
  });
  test(`[${label}] RESTORE: per-batch idempotent RPC, lines summed, patient id only if a UUID`, async () => {
    const { sb, env, api } = mk({ rpc: (n, a) => ({ data: { status: 'APPLIED', opening: 1, closing: 1 + a.payload.quantity_delta }, error: null }) });
    await api.adjustStockBulk([{ id: 'batch-1', qty: 2 }, { id: 'batch-1', qty: 1 }, { id: 'batch-2', qty: 4 }],
      { billId: 'BILL-77', patientId: 'WALKIN-ABC', reason: 'Bill deleted — stock restored to inventory' });
    const rpcs = sb.calls.filter((c) => c.rpc);
    assert.deepEqual(rpcs.map((c) => [c.rpc, c.args.payload.stock_batch_id, c.args.payload.quantity_delta, c.args.payload.bill_id, c.args.payload.patient_id]),
      [['apply_stock_restore', 'batch-1', 3, 'BILL-77', null], ['apply_stock_restore', 'batch-2', 4, 'BILL-77', null]]);
    assert.equal(writesTo(sb.calls, 'stock_batches').length + writesTo(sb.calls, 'stock_movements').length, 0);
    assert.equal(env.fetched, 1);
    const m2 = mk({ rpc: () => ({ data: { status: 'APPLIED' }, error: null }) });
    await m2.api.adjustStockBulk([{ id: 'batch-1', qty: 1 }], { billId: 'B', patientId: '23d3385a-ced0-445e-9096-25c8ceabf205', reason: 'Bill deleted — stock restored' });
    assert.equal(m2.sb.calls.find((c) => c.rpc).args.payload.patient_id, '23d3385a-ced0-445e-9096-25c8ceabf205');
  });
  test(`[${label}] RESTORE: one failing batch is reported after every batch was attempted; needs a bill id`, async () => {
    const { sb, env, api } = mk({ rpc: (n, a) => (a.payload.stock_batch_id === 'batch-1' ? { data: { status: 'CONFLICT_BATCH_NOT_FOUND' }, error: null } : { data: { status: 'APPLIED' }, error: null }) });
    await assert.rejects(api.adjustStockBulk([{ id: 'batch-1', qty: 1 }, { id: 'batch-2', qty: 1 }], { billId: 'BILL-1', reason: 'Bill deleted — stock restored' }),
      (e) => e.code === 'RESTORE_INCOMPLETE' && /TEST Paracetamol/.test(e.message));
    assert.equal(sb.calls.filter((c) => c.rpc).length, 2); assert.equal(env.fetched, 1);
    const m2 = mk();
    await assert.rejects(m2.api.adjustStockBulk([{ id: 'batch-1', qty: 1 }], { reason: 'Bill deleted' }), (e) => e.code === 'RESTORE_NEEDS_BILL');
    assert.equal(m2.sb.calls.length, 0);
  });
  test(`[${label}] BILL (negative delta) legacy path unchanged: direct update then BILL movement, no RPC`, async () => {
    const { sb, api } = mk();
    const out = await api.adjustStockBulk([{ id: 'batch-1', qty: -2 }], { billId: 'BILL-5', patientId: null, reason: 'Bill:BILL-5' });
    assert.equal(sb.calls.filter((c) => c.rpc).length, 0);
    const [upd, ins] = [writesTo(sb.calls, 'stock_batches')[0], writesTo(sb.calls, 'stock_movements')[0]];
    assert.deepEqual(upd.ops.find((o) => o[0] === 'update')[1], { qty: 23 });
    assert.deepEqual(ins.ops.find((o) => o[0] === 'insert')[1], { item_id: 'item-1', location_id: 'LOC-PHARMACY', batch_no: 'B-1', type: 'BILL', qty: -2, opening: 25, closing: 23, bill_id: 'BILL-5', patient_id: null, reason: 'Bill:BILL-5' });
    assert.deepEqual(out, [{ id: 'batch-1', opening: 25, closing: 23 }]);
  });
  test(`[${label}] TRANSFER: single RPC; refusal and missing RPC never fall back to direct writes`, async () => {
    const ok = mk({ rpc: () => ({ data: { status: 'APPLIED', transfer_number: 'TR-9' }, error: null }) });
    assert.deepEqual(await ok.api.acceptPharmacyTransfer('t-1'), { ok: true, transferNumber: 'TR-9' });
    assert.deepEqual(ok.sb.calls.map((c) => c.rpc || c.table), ['accept_pharmacy_transfer']); assert.equal(ok.env.fetched, 1);
    const done = mk({ rpc: () => ({ data: { status: 'ALREADY_COMPLETED', transfer_number: 'TR-9' }, error: null }) });
    await assert.rejects(done.api.acceptPharmacyTransfer('t-1'), (e) => e.code === 'ALREADY_COMPLETED' && /already accepted/.test(e.message));
    const miss = mk({ rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) });
    await assert.rejects(miss.api.acceptPharmacyTransfer('t-1'), (e) => e.code === 'RPC_MISSING');
    assert.equal(miss.sb.calls.filter((c) => c.table).length, 0);
  });
}

test('cloud-src and dist bundle carry the identical stock-correction helper block', () => {
  const a = extractCloud('cloud-src/vhc-cloud-sync.js', '').split('async function updateInventoryItem(')[0].split('// patch: { stock, reason')[0]; // the pre-existing comment above updateInventoryItem is not in the esbuild bundle
  const b = extractCloud('dist/assets/vhc-cloud-sync.js', '  ').split('async function updateInventoryItem(')[0];
  const dedent = (t) => t.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l).trimEnd()).join('\n').trim();
  assert.equal(a.split('\n').map((l) => l.trimEnd()).join('\n').trim(), dedent(b));
});

// ─── UI: Edit Item save handler (N) and provider updateItem, extracted from the shipped bundle ───
const bundle = read('dist/assets/index-doBKNLAj.js');
const nSource = between(bundle, '    N = async () => {', '\n    },\n    P = (e) => {').replace(/^ {4}N = /, '').replace(/,\n {4}P = \(e\) => \{$/, '');
const cloud = load('cloud-src/vhc-cloud-sync.js', '')(fake(), envFor());
function editForm(overrides = {}) {
  const env = {
    b: { name: 'TEST Paracetamol', batch: 'B-1', expiry: '', netRate: '8', price: '10', gst: '5', stockist: '', stock: '30', unitsPerPack: '10', category: 'medicine' },
    v: 'batch-1', originalStockForEdit: 25, stockAdjustReason: 'Recount: 5 strips found on back shelf',
    editSaveRef: { current: { inFlight: false, key: null, fingerprint: null } },
    DEFAULT_CATEGORY: 'medicine', log: [],
    window: { VHC_CLOUD: { manualStockReasonProblem: cloud.manualStockReasonProblem, newStockRequestKey: () => 'key-' + (++env.keys) }, VHC_AUDIT: { logStock: (x) => env.log.push(['logStock', x]) } },
    keys: 0,
  };
  env.r = overrides.r || (async (...a) => { env.log.push(['updateItem', ...a]); return { ok: true }; });
  env.t = (...a) => env.log.push(['addItem', ...a]);
  env.f = (x) => env.log.push(['modal', x]);
  env.toastFn = (msg, kind) => env.log.push(['toast', kind, msg]);
  env.setSavingEdit = (x) => env.log.push(['saving', x]);
  env.setOriginalStockForEdit = (x) => { env.log.push(['setOriginal', x]); env.originalStockForEdit = x; };
  env.setStockAdjustReason = (x) => { env.log.push(['setReason', x]); env.stockAdjustReason = x; };
  Object.assign(env, overrides.env || {});
  env.N = new Function('env', `with (env) { return (${nSource}); }`)(env);
  return env;
}
const kinds = (env, k) => env.log.filter((x) => x[0] === k);

test('UI: double-clicking Save sends exactly one correction', async () => {
  let release; const pending = new Promise((r) => (release = r));
  const env = editForm({ r: async (...a) => { env.log.push(['updateItem', ...a]); await pending; return { ok: true }; } });
  const p1 = env.N(), p2 = env.N(), p3 = env.N();
  release(); await Promise.all([p1, p2, p3]);
  assert.equal(kinds(env, 'updateItem').length, 1);
  assert.deepEqual(kinds(env, 'saving').map((x) => x[1]), [true, false]);
});
test('UI: success closes the modal and writes the local audit mirror only AFTER the server confirmed', async () => {
  const env = editForm();
  await env.N();
  const order = env.log.map((x) => x[0]);
  assert.ok(order.indexOf('updateItem') < order.indexOf('logStock') && order.indexOf('logStock') < order.lastIndexOf('modal'));
  const [, id, item, reason, opts] = kinds(env, 'updateItem')[0];
  assert.equal(id, 'batch-1'); assert.equal(item.stock, 30); assert.equal(reason, 'Recount: 5 strips found on back shelf');
  assert.deepEqual(opts, { requestKey: 'key-1', expectedStock: 25 });
  assert.deepEqual(kinds(env, 'modal'), [['modal', false]]);
  assert.equal(kinds(env, 'toast')[0][1], 'success');
});
test('UI: a database failure shows an error, keeps the modal open and the input, writes no success audit', async () => {
  const env = editForm({ r: async (...a) => { env.log.push(['updateItem', ...a]); return { error: 'Stock for this batch is now 21 …', code: 'CONFLICT_STALE_OPENING' }; } });
  await env.N();
  assert.equal(kinds(env, 'modal').length, 0); assert.equal(kinds(env, 'logStock').length, 0);
  assert.equal(kinds(env, 'toast')[0][1], 'error'); assert.match(kinds(env, 'toast')[0][2], /Not saved/);
  assert.equal(env.b.stock, '30'); assert.equal(env.stockAdjustReason, 'Recount: 5 strips found on back shelf');
  const thrown = editForm({ r: async () => { throw new Error('network down'); } });
  await thrown.N();
  assert.equal(kinds(thrown, 'modal').length, 0); assert.match(kinds(thrown, 'toast')[0][2], /network down/);
  assert.deepEqual(kinds(thrown, 'saving').map((x) => x[1]), [true, false]);
});
test('UI: a retry of the same change reuses its request key; a different change gets a new key', async () => {
  let fail = true;
  const env = editForm({ r: async (...a) => { env.log.push(['updateItem', ...a]); return fail ? { error: 'timeout', code: 'NETWORK' } : { ok: true }; } });
  await env.N(); await env.N();
  const keys = kinds(env, 'updateItem').map((x) => x[4].requestKey);
  assert.equal(keys[0], keys[1]);
  env.b.stock = '31'; await env.N();
  assert.notEqual(kinds(env, 'updateItem')[2][4].requestKey, keys[0]);
  fail = false; await env.N();
  assert.equal(kinds(env, 'updateItem')[3][4].requestKey, kinds(env, 'updateItem')[2][4].requestKey);
});
test('UI: missing / generic reason is refused before any request', async () => {
  for (const reason of ['', 'update', 'N/A']) {
    const env = editForm({ env: { stockAdjustReason: reason } });
    await env.N();
    assert.equal(kinds(env, 'updateItem').length, 0); assert.equal(kinds(env, 'toast')[0][1], 'warning');
  }
});
test('UI: fractional stock is kept (no parseInt truncation); non-stock edits send no reason', async () => {
  const env = editForm({ env: { b: { name: 'X', batch: 'B', expiry: '', netRate: '1', price: '2', gst: '5', stockist: '', stock: '12.5', unitsPerPack: '10', category: 'medicine' }, originalStockForEdit: 12 } });
  await env.N();
  assert.equal(kinds(env, 'updateItem')[0][2].stock, 12.5);
  const same = editForm({ env: { b: { ...editForm().b, stock: '25' }, stockAdjustReason: '' } });
  await same.N();
  assert.equal(kinds(same, 'updateItem')[0][3], undefined);
});
test('UI: stock saved but details failed -> starting stock advanced so a retry cannot re-apply the correction', async () => {
  const env = editForm({ r: async (...a) => { env.log.push(['updateItem', ...a]); return { error: 'The stock correction WAS saved, but …', code: 'STOCK_SAVED_DETAILS_FAILED' }; } });
  await env.N();
  assert.deepEqual(kinds(env, 'setOriginal'), [['setOriginal', 30]]); assert.deepEqual(kinds(env, 'setReason'), [['setReason', '']]);
  assert.equal(kinds(env, 'modal').length, 0);
});
test('UI provider: updateItem sends the user\'s raw stock (not the display mapper\'s rewrite) and logs only on success', async () => {
  const src = between(bundle, '        updateItem: async (e, t, reason, options) => {', '\n        },').replace(/^ +updateItem: /, '').replace(/,$/, '');
  const log = [];
  const env = {
    c: (x) => ({ ...x, unitsPerPack: 10, stock: x.stock === 220 ? 2200 : parseInt(x.stock, 10) }), // mimics the bundle's display mapper
    l: async () => log.push('refresh'), p: (...a) => log.push(['audit', ...a]),
    window: { VHC_CLOUD: { updateInventoryItem: async (...a) => { log.push(['cloud', ...a]); return env.result; } } },
    result: { ok: true },
  };
  const updateItem = new Function('env', `with (env) { return (${src.trim()}); }`)(env);
  await updateItem('batch-1', { name: 'MNERWIN NT PLUS', stock: 220.5 }, 'r', { requestKey: 'k' });
  assert.equal(log.find((x) => x[0] === 'cloud')[2].stock, 220.5);
  assert.ok(log.some((x) => x[0] === 'audit'));
  env.result = { error: 'refused' }; log.length = 0;
  const res = await updateItem('batch-1', { name: 'X', stock: 1 }, 'r', {});
  assert.deepEqual(res, { error: 'refused' }); assert.ok(!log.some((x) => x[0] === 'audit'));
});

test('UI: a batch with unsynced local bills refuses a stock correction (other fields still save)', async () => {
  const env = editForm({ env: { editSaveRef: { current: { inFlight: false, key: null, fingerprint: null, pendingSync: true } } } });
  await env.N();
  assert.equal(kinds(env, 'updateItem').length, 0);
  assert.match(kinds(env, 'toast')[0][2], /not synced/); assert.equal(kinds(env, 'modal').length, 0);
  const details = editForm({ env: { b: { ...editForm().b, stock: '25', price: '11' }, stockAdjustReason: '', editSaveRef: { current: { inFlight: false, key: null, fingerprint: null, pendingSync: true } } } });
  await details.N();
  assert.equal(kinds(details, 'updateItem').length, 1, 'a non-stock edit is still allowed');
});
test('Inventory mapper c(): stock shown/edited/saved exactly as stored (no MNERWIN 220->2200, no truncation)', () => {
  const src = between(bundle, '      c = (e) => {', '\n      },\n      l = async () => {').replace(/^ +c = /, '').replace(/,\n +l = async \(\) => \{$/, '');
  const c = new Function(`return (${src.trim()});`)();
  assert.equal(c({ name: 'MNERWIN NT PLUS', stock: 220 }).stock, 220);
  assert.equal(c({ name: 'MNERWIN NT PLUS', stock: '220' }).stock, 220);
  assert.equal(c({ name: 'TEST SYRUP 100ML', stock: '12.5' }).stock, 12.5);
  assert.equal(c({ name: 'X', stock: null }).stock, 0);
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /MNERWIN|2200/, 'no special-case rule left in the code (comments excluded)');
});
test('Inventory loader marks overlay (unsynced) batches with stockPendingSync', () => {
  const block = between(bundle, '          let cloudInventory = (Array.isArray(fetched) ? fetched : window.VHC_CLOUD.getInventory()).map(c);', '          a(cloudInventory);');
  assert.equal((block.match(/stockPendingSync: !0/g) || []).length, 2);
});

test('both cloud copies map the transfer line unit snapshot (transfer_unit, units_per_pack) for the request list', () => {
  for (const f of ['cloud-src/vhc-cloud-sync.js', 'dist/assets/vhc-cloud-sync.js']) {
    const s = read(f); const a = s.indexOf('async function fetchPendingPharmacyTransfers'); const body = s.slice(a, s.indexOf('pendingTransfersCache = mapped', a));
    assert.match(body, /transferUnit: it\.transfer_unit \?\? null/, f); assert.match(body, /unitsPerPack: it\.units_per_pack \?\? null/, f);
  }
});
test('desktop request list shows the unit with the same rule as the server (5 strips x 10 = 50 units; legacy 1:1; malformed flagged)', () => {
  const src = read('dist/assets/index-doBKNLAj.js');
  const fnSrc = between(src, 'function describeTransferLineQty(it) {', '\n}\n');
  const d = new Function(fnSrc + '\nreturn describeTransferLineQty;')();
  assert.deepEqual(d({ qty: 5, transferUnit: 'strips', unitsPerPack: 10 }), { ok: true, text: '5 strips × 10/strip = 50 units to Pharmacy' });
  assert.deepEqual(d({ qty: 3.5, transferUnit: 'units', unitsPerPack: '10' }), { ok: true, text: '3.5 strips × 10/strip = 35 units to Pharmacy (requested in units)' });
  assert.deepEqual(d({ qty: 1, transferUnit: 'strips', unitsPerPack: 1 }), { ok: true, text: '1 strip × 1/strip = 1 units to Pharmacy' });
  assert.deepEqual(d({ qty: 2.5, transferUnit: null, unitsPerPack: null }), { ok: true, text: '2.5 (no unit recorded — added 1:1)' });
  assert.deepEqual(d({ qty: 2.5 }), { ok: true, text: '2.5 (no unit recorded — added 1:1)' }, 'TEST schema rows have no unit columns');
  for (const bad of [{ qty: 5, transferUnit: 'strips', unitsPerPack: null }, { qty: 5, transferUnit: null, unitsPerPack: 10 }, { qty: 5, transferUnit: 'boxes', unitsPerPack: 10 }, { qty: 5, transferUnit: 'units', unitsPerPack: 0 }]) {
    const r = d(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.text, /Accept will be refused/);
  }
  assert.ok(src.includes('children: describeTransferLineQty(it).text'), 'the request list renders it');
});
