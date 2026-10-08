#!/usr/bin/env node
// Reports date-filter default must be the user's LOCAL calendar day, not the UTC day.
// Before the fix it was new Date().toISOString().slice(0, 10), so between local midnight and the
// UTC rollover (00:00–05:30 in India) Reports opened on YESTERDAY and today's bills looked missing.
// Each case runs in a child process with TZ set, so the real Date/Intl behaviour is exercised.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-doBKNLAj.js'), 'utf8');
const grab = (name) => {
  const start = bundle.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in bundle`);
  // The bundle uses CRLF line endings; match the closing brace of a top-level function either way.
  const m = /\r?\n\}\r?\n/.exec(bundle.slice(start));
  assert.ok(m, `end of ${name} not found`);
  return bundle.slice(start, start + m.index + m[0].length);
};
const helpers = [grab('vhcBillEpochMs'), grab('vhcBusinessDate'), grab('vhcLocalDateString')].join('\n');

const runIn = (tz, body) => {
  const r = spawnSync(process.execPath, ['-e', `${helpers}\n${body}`], {
    env: { ...process.env, TZ: tz, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr || 'child failed');
  return JSON.parse(r.stdout.trim());
};

let pass = 0, fail = 0;
const check = (n, fn) => { try { fn(); console.log('  PASS  ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + ' — ' + e.message); fail++; } };

check('bundle no longer defaults the report date/month to a UTC slice', () => {
  assert.ok(!bundle.includes('useState)(new Date().toISOString().slice(0, 10))'));
  assert.ok(!bundle.includes('useState)(new Date().toISOString().slice(0, 7))'));
  assert.ok(bundle.includes('[m, h] = (0, _.useState)(vhcLocalDateString())'));
  assert.ok(bundle.includes('[g, v] = (0, _.useState)(vhcLocalDateString().slice(0, 7))'));
});

check('helper hardcodes no timezone', () => {
  const src = grab('vhcLocalDateString');
  assert.ok(!/Asia\/Kolkata|timeZone|\+05:30|330/.test(src), src);
});

check('IST 00:30 (the bug window): local default is TODAY, UTC slice was YESTERDAY', () => {
  const r = runIn('Asia/Kolkata', `const d=new Date(2026,9,8,0,30);console.log(JSON.stringify({local:vhcLocalDateString(d),utc:d.toISOString().slice(0,10)}))`);
  assert.strictEqual(r.local, '2026-10-08');
  assert.strictEqual(r.utc, '2026-10-07', 'precondition: the old UTC default really was yesterday');
});

check('IST: default day agrees with the bill business day across the whole day', () => {
  const r = runIn('Asia/Kolkata', `const out=[];for(let h=0;h<24;h++){for(const mi of [0,29,31,59]){const d=new Date(2026,9,8,h,mi);out.push(vhcLocalDateString(d)===vhcBusinessDate(d.toISOString()));}}console.log(JSON.stringify({all:out.every(Boolean),n:out.length}))`);
  assert.ok(r.all, 'local default and bill business day must match for every minute sampled');
});

check('IST: month default is the local month at the month boundary (00:15 on the 1st)', () => {
  const r = runIn('Asia/Kolkata', `const d=new Date(2026,10,1,0,15);console.log(JSON.stringify({m:vhcLocalDateString(d).slice(0,7),utc:d.toISOString().slice(0,7)}))`);
  assert.strictEqual(r.m, '2026-11');
  assert.strictEqual(r.utc, '2026-10');
});

check('another zone (America/New_York 23:30) uses that machine\'s own calendar day', () => {
  const r = runIn('America/New_York', `const d=new Date(2026,9,7,23,30);console.log(JSON.stringify({local:vhcLocalDateString(d),utc:d.toISOString().slice(0,10)}))`);
  assert.strictEqual(r.local, '2026-10-07');
  assert.strictEqual(r.utc, '2026-10-08', 'precondition: UTC would have jumped ahead a day');
});

check('zero-padding is correct', () => {
  const r = runIn('UTC', `console.log(JSON.stringify(vhcLocalDateString(new Date(2026,0,5,12,0))))`);
  assert.strictEqual(r, '2026-01-05');
});

console.log('\n' + (fail === 0 ? `ALL REPORTS LOCAL-DATE TESTS PASSED (${pass})` : `${fail} FAILED / ${pass} passed`));
process.exit(fail === 0 ? 0 : 1);
