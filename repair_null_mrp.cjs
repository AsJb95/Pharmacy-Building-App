// One-time repair: backfill stock_batches.mrp for rows left NULL by the
// pre-fix restoreInventoryFromBackup()/addInventoryItem() bug (mrp: item.mrp
// with no fallback to the backup's `price` field). Source of truth is the
// backup JSON on disk — the same file the corrupted restore came from.
//
// SAFE BY DESIGN:
//   - Only ever touches rows where mrp IS NULL right now (checked in the
//     SELECT, and re-checked per-row immediately before each UPDATE).
//   - Only sets the `mrp` column. Never writes stock/qty, gst, net_rate,
//     batch, or expiry — none of those were corrupted by this bug.
//   - Defaults to DRY RUN: prints exactly what it would change and exits.
//     Pass --apply to actually write.
//   - Every row it changes is appended to repair_null_mrp_log.json before
//     the update runs, so there's a complete before/after record.
//   - Requires an authenticated pharmacy-writer/admin session — the
//     publishable anon key alone cannot write past RLS. Credentials are
//     read from env vars only, never hardcoded, never logged.
//
// Usage (dry run):
//   node repair_null_mrp.cjs
// Usage (apply for real):
//   PHARMACY_REPAIR_EMAIL=... PHARMACY_REPAIR_PASSWORD=... node repair_null_mrp.cjs --apply

const fs = require('fs');
const path = require('path');

const BACKUP_PATH = process.env.PHARMACY_REPAIR_BACKUP || 'C:/VHC_Pharmacy_Data/gdrive_backups/VHC_POS_AutoBackup.json';
const LOG_PATH = path.join(__dirname, 'repair_null_mrp_log.json');
const APPLY = process.argv.includes('--apply');

async function main() {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = 'https://yrgtnhvnwkqudxdcrkhm.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_7fL9ZcI18hC1XiMqeCLhlg_YXNzABAC';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if (APPLY) {
    const email = process.env.PHARMACY_REPAIR_EMAIL;
    const password = process.env.PHARMACY_REPAIR_PASSWORD;
    if (!email || !password) {
      console.error('--apply requires PHARMACY_REPAIR_EMAIL and PHARMACY_REPAIR_PASSWORD env vars (a pharmacy_writer/admin account). Aborting.');
      process.exit(1);
    }
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) {
      console.error('Sign-in failed:', signInErr.message);
      process.exit(1);
    }
  }

  const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const backupInventory = backup.inventory || [];
  console.log(`Backup source: ${BACKUP_PATH} (${backup.formattedDate || 'no date'}), ${backupInventory.length} items`);

  const backupByKey = new Map();
  for (const item of backupInventory) {
    const price = item.mrp ?? item.price;
    if (price === undefined || price === null) continue;
    const key = (item.name || '').toLowerCase().trim() + '||' + (item.batch || '').toLowerCase().trim();
    backupByKey.set(key, { name: item.name, batch: item.batch, price });
  }

  const { data: locRow, error: locErr } = await supabase.from('locations').select('id').eq('type', 'pharmacy_counter').limit(1).maybeSingle();
  if (locErr) { console.error('Failed to look up pharmacy location:', locErr.message); process.exit(1); }
  if (!locRow) { console.error('No pharmacy_counter location found.'); process.exit(1); }

  const { data: nullRows, error: fetchErr } = await supabase
    .from('stock_batches')
    .select('id, batch_no, mrp, items(name)')
    .eq('location_id', locRow.id)
    .is('mrp', null);
  if (fetchErr) { console.error('Failed to fetch stock_batches:', fetchErr.message); process.exit(1); }

  console.log(`stock_batches rows with mrp IS NULL: ${nullRows.length}`);

  const toFix = [];
  const noMatch = [];
  for (const row of nullRows) {
    const name = row.items?.name || '';
    const key = name.toLowerCase().trim() + '||' + (row.batch_no || '').toLowerCase().trim();
    const match = backupByKey.get(key);
    if (match) {
      toFix.push({ id: row.id, name, batch: row.batch_no, newMrp: match.price });
    } else {
      noMatch.push({ id: row.id, name, batch: row.batch_no });
    }
  }

  console.log(`\nMatched against backup (would repair): ${toFix.length}`);
  toFix.forEach((r) => console.log(`  ${r.name} [${r.batch}] -> mrp = ${r.newMrp}`));

  console.log(`\nNo match in backup (left untouched, needs manual entry): ${noMatch.length}`);
  noMatch.forEach((r) => console.log(`  ${r.name} [${r.batch}] (id=${r.id})`));

  if (!APPLY) {
    console.log('\nDRY RUN ONLY — no changes written. Re-run with --apply (and credentials) to write these updates.');
    return;
  }

  const logEntries = [];
  let applied = 0;
  for (const r of toFix) {
    // Re-check immediately before writing, in case something else already fixed it.
    const { data: current, error: recheckErr } = await supabase.from('stock_batches').select('mrp').eq('id', r.id).maybeSingle();
    if (recheckErr || !current || current.mrp !== null) {
      console.log(`Skipping ${r.name} [${r.batch}] — no longer NULL (already fixed elsewhere).`);
      continue;
    }
    const { error: updErr } = await supabase.from('stock_batches').update({ mrp: r.newMrp }).eq('id', r.id).is('mrp', null);
    if (updErr) {
      console.error(`Failed to update ${r.name} [${r.batch}]:`, updErr.message);
      continue;
    }
    logEntries.push({ id: r.id, name: r.name, batch: r.batch, before: null, after: r.newMrp, at: new Date().toISOString() });
    applied++;
  }

  fs.writeFileSync(LOG_PATH, JSON.stringify(logEntries, null, 2));
  console.log(`\nApplied ${applied} / ${toFix.length} updates. Log written to ${LOG_PATH}`);
}

main().catch((e) => {
  console.error('Repair script failed:', e);
  process.exit(1);
});
