'use strict';

const { createClient } = require('@supabase/supabase-js');
const { resolveSupabaseConfig, assertSafeDestructiveTestTarget } = require('./vhc_supabase_config.cjs');

async function main() {
  const config = resolveSupabaseConfig(process.env);
  assertSafeDestructiveTestTarget(config);
  const serviceKey = String(process.env.VHC_TEST_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceKey) throw new Error('VHC_TEST_SUPABASE_SERVICE_ROLE_KEY is required for TEST reset');

  const client = createClient(config.supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const prefix = 'TEST-VHC-';
  const { data: sales, error: readError } = await client.from('sales').select('id,bill_id').like('bill_id', `${prefix}%`);
  if (readError) throw readError;
  const saleIds = (sales || []).map((row) => row.id);
  if (saleIds.length) {
    const { error: itemError } = await client.from('sale_items').delete().in('sale_id', saleIds);
    if (itemError) throw itemError;
    const { error: movementError } = await client.from('stock_movements').delete().like('bill_id', `${prefix}%`);
    if (movementError) throw movementError;
    const { error: saleError } = await client.from('sales').delete().in('id', saleIds);
    if (saleError) throw saleError;
  }
  process.stdout.write(`Reset ${saleIds.length} synthetic VHC TEST sale(s).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
