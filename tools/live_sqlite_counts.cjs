const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const paths = JSON.parse(fs.readFileSync(path.join('evidence_live_offline_v3182', 'latest_paths.json'), 'utf8'));
const dbPath = path.join(paths.profile, 'vhc_pharmacy.db');
const db = new Database(dbPath, { readonly: true });
const count = (sql) => db.prepare(sql).get().c;
const out = {
  profile: paths.profile,
  data: paths.data,
  db: dbPath,
  sales: count("select count(*) c from sales where bill_id like 'LIVE-%'"),
  saleItems: count("select count(*) c from sale_items where sale_id in (select id from sales where bill_id like 'LIVE-%')"),
  stockMovements: count("select count(*) c from stock_movements where bill_id like 'LIVE-%'"),
  duplicateBillIds: db.prepare("select bill_id, count(*) c from sales where bill_id like 'LIVE-%' group by bill_id having count(*) > 1").all(),
  billIds: db.prepare("select bill_id, payment_mode, total_amount, amount_received, outstanding_amount, payment_status from sales where bill_id like 'LIVE-%' order by created_at").all(),
};
db.close();
fs.writeFileSync(path.join('evidence_live_offline_v3182', 'live_sqlite_counts.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
