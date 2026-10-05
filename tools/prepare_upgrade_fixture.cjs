const Database = require('better-sqlite3');

const [mode, dbPath] = process.argv.slice(2);
if (!mode || !dbPath) throw new Error('usage: prepare_upgrade_fixture.cjs <downgrade|inspect> <db>');

const db = new Database(dbPath);
const scalar = (sql) => db.prepare(sql).get().value;

if (mode === 'downgrade') {
  db.transaction(() => {
    db.exec('drop table if exists financial_sync_operations');
    db.prepare('delete from schema_migrations where version = 4').run();
    db.prepare("update database_metadata set value = '3' where key = 'schema_version'").run();
  })();
}

const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((row) => row.name);
const result = {
  schemaVersion: db.prepare('select max(version) as value from schema_migrations').get().value,
  sales: scalar('select count(*) as value from sales'),
  saleItems: scalar('select count(*) as value from sale_items'),
  stockQty: scalar('select coalesce(sum(qty),0) as value from stock_batches'),
  repayments: scalar('select count(*) as value from credit_repayments'),
  queueTable: tables.includes('financial_sync_operations'),
  queueRows: tables.includes('financial_sync_operations') ? scalar('select count(*) as value from financial_sync_operations') : null,
};
console.log(JSON.stringify(result));
db.close();
