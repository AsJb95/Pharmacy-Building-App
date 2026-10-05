'use strict';

const assert = require('node:assert/strict');
const { resolveSupabaseConfig, assertSafeDestructiveTestTarget } = require('../tools/vhc_supabase_config.cjs');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}

test('TEST without credentials blocks writes', () => {
  const config = resolveSupabaseConfig({ VHC_SUPABASE_ENVIRONMENT: 'TEST' });
  assert.equal(config.cloudWritesAllowed, false);
  assert.equal(config.disabledReason, 'SAFE CLOUD TEST TARGET REQUIRED');
  assert.throws(() => assertSafeDestructiveTestTarget(config), /SAFE CLOUD TEST TARGET REQUIRED/);
});

test('TEST cannot target production hostname', () => {
  const config = resolveSupabaseConfig({
    VHC_SUPABASE_ENVIRONMENT: 'TEST',
    VHC_TEST_SUPABASE_URL: 'https://yrgtnhvnwkqudxdcrkhm.supabase.co/',
    VHC_TEST_SUPABASE_ANON_KEY: 'synthetic-key',
  });
  assert.equal(config.cloudWritesAllowed, false);
  assert.throws(() => assertSafeDestructiveTestTarget(config), /PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING/);
});

test('TEST accepts a distinct configured project', () => {
  const config = resolveSupabaseConfig({
    VHC_SUPABASE_ENVIRONMENT: 'TEST',
    VHC_TEST_SUPABASE_URL: 'https://vhc-safe-test.supabase.co',
    VHC_TEST_SUPABASE_ANON_KEY: 'synthetic-key',
  });
  assert.equal(config.cloudWritesAllowed, true);
  assert.equal(assertSafeDestructiveTestTarget(config), true);
});

test('PRODUCTION retains its configured project', () => {
  const config = resolveSupabaseConfig({ VHC_SUPABASE_ENVIRONMENT: 'PRODUCTION' });
  assert.equal(config.environmentName, 'PRODUCTION');
  assert.equal(config.isProductionUrl, true);
});

test('unknown environment cannot fall through to production', () => {
  const config = resolveSupabaseConfig({ VHC_SUPABASE_ENVIRONMENT: 'STAGING' });
  assert.equal(config.cloudWritesAllowed, false);
  assert.equal(config.supabaseUrl, '');
  assert.match(config.disabledReason, /Unsupported VHC Supabase environment/);
});

process.stdout.write(`${passed} passed, 0 failed\n`);
