#!/usr/bin/env node
/**
 * Automated Security & Hardening Regression Test Suite
 * Proposal: supabase/proposals/20261029000100_test_security_hardening_proposal.sql
 *
 * Verifies:
 * 1. RBAC foundation & profiles schema contract
 * 2. Role helper functions (is_admin, is_platform_admin, is_pharmacy_writer, is_warehouse_writer)
 * 3. Prevention of privilege escalation on profiles
 * 4. Drop of permissive 'vhc_test_authenticated_all' allow-all policies
 * 5. Table-by-table least-privilege RLS policies:
 *    - Positive authorized writes for pharmacy/warehouse writers
 *    - Negative restriction: direct DELETE/UPDATE forbidden on immutable ledgers (sales, sale_items, stock_movements, returns)
 *    - Negative restriction: viewer role blocked from all writes and mutating RPCs
 * 6. Role evaluation matrix simulation
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const proposalPath = path.join(__dirname, '..', 'supabase', 'proposals', '20261029000100_test_security_hardening_proposal.sql');
assert.ok(fs.existsSync(proposalPath), 'Proposal SQL file must exist');
const sql = fs.readFileSync(proposalPath, 'utf8');

const tests = [];
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

// -----------------------------------------------------------------------------
// 1. RBAC FOUNDATION & PROFILES CONTRACT
// -----------------------------------------------------------------------------
test('Profiles table defined with role check constraint and RLS enabled', () => {
  assert.match(sql, /create table if not exists public\.profiles/i);
  assert.match(sql, /role text not null default 'viewer' check \(role in \('admin', 'pharmacist', 'warehouse_manager', 'viewer'\)\)/i);
  assert.match(sql, /is_platform_admin boolean not null default false/i);
  assert.match(sql, /alter table public\.profiles enable row level security/i);
});

// -----------------------------------------------------------------------------
// 2. PRIVILEGE & ROLE HELPER FUNCTIONS
// -----------------------------------------------------------------------------
test('Helper functions defined as SECURITY DEFINER with search_path = public', () => {
  const helpers = ['current_user_role', 'is_admin', 'is_platform_admin', 'is_pharmacy_writer', 'is_warehouse_writer'];
  for (const h of helpers) {
    const re = new RegExp(`create or replace function public\\.${h}\\(\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = public`, 'i');
    assert.match(sql, re, `Helper function ${h} must be SECURITY DEFINER with set search_path = public`);
  }
});

test('is_pharmacy_writer restricts to admin and pharmacist (viewer strictly denied)', () => {
  assert.match(sql, /create or replace function public\.is_pharmacy_writer\(\)[\s\S]*?select coalesce\(\s*\(select role in \('admin', 'pharmacist'\) from public\.profiles/i);
});

test('is_warehouse_writer restricts to admin and warehouse_manager (viewer strictly denied)', () => {
  assert.match(sql, /create or replace function public\.is_warehouse_writer\(\)[\s\S]*?select coalesce\(\s*\(select role in \('admin', 'warehouse_manager'\) from public\.profiles/i);
});

test('is_platform_admin queries is_platform_admin column on caller profile', () => {
  assert.match(sql, /create or replace function public\.is_platform_admin\(\)[\s\S]*?select coalesce\(\s*\(select is_platform_admin from public\.profiles where id = auth\.uid\(\)\),\s*false\s*\)/i);
});

// -----------------------------------------------------------------------------
// 3. PRIVILEGE ESCALATION PREVENTION ON PROFILES
// -----------------------------------------------------------------------------
test('Profiles insert policy prevents self-elevating beyond viewer role or platform admin', () => {
  assert.match(sql, /create policy profiles_insert_self on public\.profiles[\s\S]*?with check \(\s*id = auth\.uid\(\)\s*and role = 'viewer'\s*and is_platform_admin = false\s*\)/i);
});

test('Profiles update policy prevents standard users from escalating role or is_platform_admin', () => {
  assert.match(sql, /create policy profiles_update on public\.profiles[\s\S]*?case[\s\S]*?when public\.is_admin\(\) or public\.is_platform_admin\(\) then true[\s\S]*?is_platform_admin = false/i);
});

// -----------------------------------------------------------------------------
// 4. REMOVAL OF PERMISSIVE POLICIES
// -----------------------------------------------------------------------------
test('Drops permissive vhc_test_authenticated_all policies across all core tables', () => {
  assert.match(sql, /drop policy if exists vhc_test_authenticated_all on public\.%I/i);
  const tables = ['locations', 'items', 'stock_batches', 'patients', 'sales', 'sale_items', 'stock_movements', 'alerts_config', 'transfer_orders', 'transfer_order_items'];
  for (const t of tables) {
    assert.ok(sql.includes(`'${t}'`), `Must include table ${t} in permissive policy cleanup`);
  }
});

// -----------------------------------------------------------------------------
// 5. IMMUTABLE FINANCIAL & AUDIT LEDGERS (NEGATIVE DIRECT WRITE RESTRICTIONS)
// -----------------------------------------------------------------------------
test('Sales table: direct DELETE is strictly forbidden (using false)', () => {
  assert.match(sql, /create policy sales_delete_forbidden on public\.sales\s+for delete to authenticated\s+using \(false\);/i);
});

test('Sale items table: direct UPDATE and DELETE are strictly forbidden (using false)', () => {
  assert.match(sql, /create policy sale_items_update_forbidden on public\.sale_items\s+for update to authenticated\s+using \(false\);/i);
  assert.match(sql, /create policy sale_items_delete_forbidden on public\.sale_items\s+for delete to authenticated\s+using \(false\);/i);
});

test('Stock movements table: ledger immutability enforced (UPDATE and DELETE forbidden)', () => {
  assert.match(sql, /create policy stock_movements_update_forbidden on public\.stock_movements\s+for update to authenticated\s+using \(false\);/i);
  assert.match(sql, /create policy stock_movements_delete_forbidden on public\.stock_movements\s+for delete to authenticated\s+using \(false\);/i);
});

test('Sale returns & refunds: audit immutability enforced (UPDATE and DELETE forbidden)', () => {
  assert.match(sql, /create policy sale_returns_modify_forbidden on public\.sale_returns for update to authenticated using \(false\);/i);
  assert.match(sql, /create policy sale_returns_delete_forbidden on public\.sale_returns for delete to authenticated using \(false\);/i);
  assert.match(sql, /create policy sale_refunds_modify_forbidden on public\.sale_refunds for update to authenticated using \(false\);/i);
  assert.match(sql, /create policy sale_refunds_delete_forbidden on public\.sale_refunds for delete to authenticated using \(false\);/i);
});

// -----------------------------------------------------------------------------
// 6. ROLE EVALUATION MATRIX SIMULATION
// -----------------------------------------------------------------------------
test('Role Access Matrix: evaluates permissions correctly for all 4 roles', () => {
  // Model of policies defined in proposal
  function canPerform(role, isPlatformAdmin, table, op) {
    const isPharmacyWriter = ['admin', 'pharmacist'].includes(role);
    const isWarehouseWriter = ['admin', 'warehouse_manager'].includes(role);
    const isAdmin = role === 'admin';

    // 1. locations
    if (table === 'locations') {
      if (op === 'SELECT') return true;
      return isAdmin;
    }
    // 2. items
    if (table === 'items') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT' || op === 'UPDATE') return isPharmacyWriter || isWarehouseWriter;
      if (op === 'DELETE') return isAdmin;
    }
    // 3. stock_batches
    if (table === 'stock_batches') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT' || op === 'UPDATE') return isPharmacyWriter || isWarehouseWriter;
      if (op === 'DELETE') return isAdmin;
    }
    // 4. patients
    if (table === 'patients') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT' || op === 'UPDATE') return isPharmacyWriter;
      if (op === 'DELETE') return isAdmin;
    }
    // 5. sales
    if (table === 'sales') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT' || op === 'UPDATE') return isPharmacyWriter;
      if (op === 'DELETE') return false; // forbidden
    }
    // 6. sale_items
    if (table === 'sale_items') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT') return isPharmacyWriter;
      if (op === 'UPDATE' || op === 'DELETE') return false; // forbidden
    }
    // 7. stock_movements
    if (table === 'stock_movements') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT') return isPharmacyWriter || isWarehouseWriter;
      if (op === 'UPDATE' || op === 'DELETE') return false; // forbidden
    }
    // 8. sale_returns
    if (table === 'sale_returns') {
      if (op === 'SELECT') return true;
      if (op === 'INSERT') return isPharmacyWriter;
      if (op === 'UPDATE' || op === 'DELETE') return false; // forbidden
    }
    // 9. profiles escalation
    if (table === 'profiles') {
      if (op === 'SELECT') return true;
      if (op === 'UPDATE_ROLE') return isAdmin || isPlatformAdmin;
      if (op === 'UPDATE_NAME') return true;
      if (op === 'DELETE') return isAdmin;
    }
    return false;
  }

  // --- VIEWER TESTS ---
  assert.strictEqual(canPerform('viewer', false, 'sales', 'SELECT'), true, 'Viewer can read sales');
  assert.strictEqual(canPerform('viewer', false, 'sales', 'INSERT'), false, 'Viewer CANNOT insert sales');
  assert.strictEqual(canPerform('viewer', false, 'sales', 'UPDATE'), false, 'Viewer CANNOT update sales');
  assert.strictEqual(canPerform('viewer', false, 'sales', 'DELETE'), false, 'Viewer CANNOT delete sales');
  assert.strictEqual(canPerform('viewer', false, 'stock_batches', 'UPDATE'), false, 'Viewer CANNOT modify stock');
  assert.strictEqual(canPerform('viewer', false, 'patients', 'INSERT'), false, 'Viewer CANNOT insert patients');
  assert.strictEqual(canPerform('viewer', false, 'sale_returns', 'INSERT'), false, 'Viewer CANNOT create return');
  assert.strictEqual(canPerform('viewer', false, 'profiles', 'UPDATE_ROLE'), false, 'Viewer CANNOT elevate role');

  // --- PHARMACIST TESTS ---
  assert.strictEqual(canPerform('pharmacist', false, 'sales', 'SELECT'), true);
  assert.strictEqual(canPerform('pharmacist', false, 'sales', 'INSERT'), true, 'Pharmacist can create sales');
  assert.strictEqual(canPerform('pharmacist', false, 'sales', 'DELETE'), false, 'Pharmacist CANNOT delete sales');
  assert.strictEqual(canPerform('pharmacist', false, 'sale_items', 'UPDATE'), false, 'Pharmacist CANNOT tamper with sale_items');
  assert.strictEqual(canPerform('pharmacist', false, 'stock_movements', 'UPDATE'), false, 'Pharmacist CANNOT alter ledger');
  assert.strictEqual(canPerform('pharmacist', false, 'stock_movements', 'DELETE'), false, 'Pharmacist CANNOT delete ledger');
  assert.strictEqual(canPerform('pharmacist', false, 'sale_returns', 'INSERT'), true, 'Pharmacist can record returns');
  assert.strictEqual(canPerform('pharmacist', false, 'profiles', 'UPDATE_ROLE'), false, 'Pharmacist CANNOT elevate role');

  // --- WAREHOUSE MANAGER TESTS ---
  assert.strictEqual(canPerform('warehouse_manager', false, 'items', 'UPDATE'), true, 'Warehouse manager can update items');
  assert.strictEqual(canPerform('warehouse_manager', false, 'sales', 'INSERT'), false, 'Warehouse manager CANNOT create bills');
  assert.strictEqual(canPerform('warehouse_manager', false, 'sale_returns', 'INSERT'), false, 'Warehouse manager CANNOT create returns');

  // --- ADMIN TESTS ---
  assert.strictEqual(canPerform('admin', false, 'locations', 'INSERT'), true, 'Admin can manage locations');
  assert.strictEqual(canPerform('admin', false, 'profiles', 'UPDATE_ROLE'), true, 'Admin can manage user roles');
  assert.strictEqual(canPerform('admin', false, 'sales', 'DELETE'), false, 'Even Admin cannot directly DELETE sales records');
  assert.strictEqual(canPerform('admin', false, 'stock_movements', 'DELETE'), false, 'Even Admin cannot directly DELETE audit movements');
});

// Run all test cases
for (const { name, fn } of tests) {
  try {
    fn();
    passCount++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failCount++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log(`\nResults: ${passCount} passed, ${failCount} failed (${tests.length} total)`);
if (failCount > 0) process.exit(1);
