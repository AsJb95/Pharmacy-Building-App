const assert = require('assert');
const { canonicalTimestamp, businessDateInTimeZone, displayDateTime, billIdEpochMs } = require('../tools/vhc_time_utils.cjs');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e && e.stack || e);
    failed++;
  }
}

test('12h and 24h display are display-only for the same canonical timestamp', () => {
  const iso = '2026-09-25T07:15:00.000Z'; // 12:45 IST
  assert.strictEqual(businessDateInTimeZone(iso), '2026-09-25');
  assert.notStrictEqual(displayDateTime(iso, { hour12: true }), displayDateTime(iso, { hour12: false }));
  assert.strictEqual(businessDateInTimeZone(iso), '2026-09-25');
});

test('Sep 25 00:01 IST belongs to Sep 25 business date', () => {
  assert.strictEqual(businessDateInTimeZone('2026-09-24T18:31:00.000Z'), '2026-09-25');
});

test('Sep 24 23:59 IST belongs to Sep 24 business date', () => {
  assert.strictEqual(businessDateInTimeZone('2026-09-24T18:29:00.000Z'), '2026-09-24');
});

test('UTC calendar date is not used as clinic business date', () => {
  const iso = '2026-09-24T20:00:00.000Z'; // Sep 25 01:30 IST
  assert.strictEqual(iso.slice(0, 10), '2026-09-24');
  assert.strictEqual(businessDateInTimeZone(iso), '2026-09-25');
});

test('bill ID epoch can derive fallback business date', () => {
  const ms = Date.parse('2026-09-24T18:31:00.000Z');
  const billId = `BILL-${ms}`;
  assert.strictEqual(billIdEpochMs(billId), ms);
  assert.strictEqual(businessDateInTimeZone(billIdEpochMs(billId)), '2026-09-25');
});

test('canonicalTimestamp preserves ISO instants', () => {
  assert.strictEqual(canonicalTimestamp('2026-09-25T00:00:00.000Z'), '2026-09-25T00:00:00.000Z');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
