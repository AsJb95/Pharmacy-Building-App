// ─── SQLite local-database module ───
// This module owns the ONLY better-sqlite3 Database instance in the process. Nothing outside
// this file ever touches the raw database object — main.js only calls the safe, named
// functions exported below, and those are the only things exposed to the renderer via IPC.
//
// Phase 2A/2B built the foundation and schema (nothing read/wrote through it). Phase 2C makes
// the actual billing checkout flow (dist/assets/index-doBKNLAj.js) call createLocalSale() below
// as its authoritative local record of a completed sale and its stock effect — this now happens
// whether or not the internet/Supabase is reachable. Supabase is still called afterward (a
// best-effort, non-blocking mirror, unchanged from before this phase) and remains the system of
// record for cross-terminal reporting; no sync between the two exists yet (a later phase's
// explicit job) — see the Phase 2C task report for the full architecture.
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';

let db = null;
let dbFilePath = null;

// Each migration's `up(database)` runs inside its own transaction (see runMigrations below).
// Add new entries here in later phases — never edit an already-shipped migration's `up`, add
// a new one instead, so a PC that already applied version 1 never re-runs it differently.
const MIGRATIONS = [
  {
    version: 1,
    name: 'create_database_metadata',
    up(database) {
      database.exec(`
        CREATE TABLE database_metadata (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      const insert = database.prepare(
        'INSERT INTO database_metadata (key, value, updated_at) VALUES (?, ?, ?)'
      );
      insert.run('schema_version', '1', now);
      insert.run('created_at', now, now);
      insert.run(
        'purpose',
        'NHC Pharmacy POS local SQLite foundation (Phase 2A) — not yet a source of truth for any business data',
        now
      );
    },
  },
  {
    // Phase 2B — local schema for the pharmacy's core operational data. Column names and
    // shapes are taken directly from the actual, currently-running application: the Supabase
    // tables it already reads/writes (items, stock_batches, stock_movements, patients, sales,
    // sale_items — verified in dist/assets/vhc-cloud-sync.js) and the actual local bill record
    // the renderer already saves to localStorage['vhc_pos_sales_history'] today (verified in
    // dist/assets/index-doBKNLAj.js's `ae()` — the payment/credit-tracking fields below
    // amount_received/outstanding_amount/payment_status/payment_breakdown/recorded_by exist
    // ONLY in that local record, not in the Supabase 'sales' row, since createSale() is always
    // called with recordOnly:true; they are preserved here because the existing Credit
    // Repayment feature already depends on them). Nothing reads or writes through these tables
    // yet — this migration only creates the schema.
    //
    // `server_id` on every table is reserved for a future phase's sync layer to record the
    // matching Supabase row's id once one exists; it is never written to in Phase 2B.
    version: 2,
    name: 'create_pharmacy_core_schema',
    up(database) {
      // Created in FK-dependency order: items/patients first (no dependencies), then
      // stock_batches (needs items), then stock_movements (needs items+patients), then
      // sales (needs patients), then sale_items (needs sales+items+stock_batches).
      database.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          name TEXT NOT NULL,
          category TEXT,
          hsn_code TEXT,
          units_per_pack REAL,
          product_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_items_name ON items(name);
        CREATE INDEX idx_items_product_code ON items(product_code);

        CREATE TABLE patients (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          name TEXT NOT NULL,
          contact TEXT,
          age INTEGER,
          sex TEXT,
          address TEXT,
          source TEXT,
          legacy_patient_id TEXT,
          is_manual INTEGER NOT NULL DEFAULT 0,
          merged_into_patient_id TEXT REFERENCES patients(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_patients_contact ON patients(contact);
        CREATE INDEX idx_patients_name ON patients(name);

        CREATE TABLE stock_batches (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          item_id TEXT NOT NULL REFERENCES items(id),
          location_id TEXT,
          batch_no TEXT,
          expiry_date TEXT,
          mrp REAL,
          net_rate REAL,
          gst REAL,
          stockist TEXT,
          qty REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_stock_batches_item_id ON stock_batches(item_id);
        CREATE INDEX idx_stock_batches_batch_no ON stock_batches(batch_no);

        CREATE TABLE stock_movements (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          item_id TEXT REFERENCES items(id),
          location_id TEXT,
          batch_no TEXT,
          type TEXT NOT NULL,
          qty REAL NOT NULL,
          opening REAL,
          closing REAL,
          bill_id TEXT,
          patient_id TEXT REFERENCES patients(id),
          reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_stock_movements_item_id ON stock_movements(item_id);
        CREATE INDEX idx_stock_movements_bill_id ON stock_movements(bill_id);
        CREATE INDEX idx_stock_movements_created_at ON stock_movements(created_at);

        CREATE TABLE sales (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          bill_id TEXT NOT NULL UNIQUE,
          patient_id TEXT REFERENCES patients(id),
          patient_name TEXT,
          doctor_name TEXT,
          payment_mode TEXT,
          subtotal REAL,
          total_tax REAL,
          total_amount REAL NOT NULL,
          gst_mode TEXT,
          discount REAL,
          discount_percent REAL,
          amount_received REAL,
          outstanding_amount REAL,
          payment_status TEXT,
          payment_breakdown TEXT,
          recorded_by TEXT,
          patient_snapshot TEXT,
          sale_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_sales_bill_id ON sales(bill_id);
        CREATE INDEX idx_sales_sale_date ON sales(sale_date);
        CREATE INDEX idx_sales_patient_id ON sales(patient_id);

        CREATE TABLE sale_items (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          item_id TEXT REFERENCES items(id),
          stock_batch_id TEXT REFERENCES stock_batches(id),
          category TEXT,
          drug_name TEXT NOT NULL,
          batch_no TEXT,
          expiry_date TEXT,
          quantity REAL NOT NULL,
          rate REAL,
          total REAL,
          affects_stock INTEGER,
          metadata TEXT
        );
        CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
        CREATE INDEX idx_sale_items_item_id ON sale_items(item_id);
      `);

      const now = new Date().toISOString();
      database
        .prepare("UPDATE database_metadata SET value = '2', updated_at = ? WHERE key = 'schema_version'")
        .run(now);
    },
  },
  {
    // Phase 2D — the offline→online sync queue. One row per Supabase-bound operation. Deliberately
    // NOT a generic "outbox for every table" — per the actual create_sale/delete_sale_and_restore
    // RPCs traced from the real Supabase migrations (supabase/migrations/20260819000200_...), a
    // whole sale (sale + all its sale_items + the resulting stock deduction) is ONE server call,
    // not five — so entity_type is always 'sale' in this phase, operation is 'create' or 'cancel'.
    // `depends_on` lets a cancellation wait for its own create to finish syncing first (see
    // enqueueCancelSync below) without needing a second queue table or a join to figure out order.
    // Status is deliberately NOT a dead-end "failed": 'pending' always means "eligible to retry,"
    // and only a genuine, non-network problem (e.g. a real remote stock conflict, or an
    // unresolvable local-only item — see buildCreateSalePayload) is set to 'needs_review', which
    // stops automatic retries but never touches the local sale itself.
    version: 3,
    name: 'create_sync_queue',
    up(database) {
      database.exec(`
        CREATE TABLE sync_queue (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload TEXT,
          depends_on TEXT REFERENCES sync_queue(id),
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          server_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT
        );
        CREATE INDEX idx_sync_queue_status ON sync_queue(status, created_at);
        CREATE INDEX idx_sync_queue_bill_id ON sync_queue(bill_id);
      `);
      const now = new Date().toISOString();
      database
        .prepare("UPDATE database_metadata SET value = '3', updated_at = ? WHERE key = 'schema_version'")
        .run(now);
    },
  },
  {
    // Phase 2F Step 2 — credit repayments. Traced from the real business logic before writing
    // this (see index-doBKNLAj.js's computeCreditSettlement, ~line 61370): the existing app
    // NEVER mutates a bill's own outstanding/status after a repayment — it treats
    // payment_breakdown.credit (frozen at checkout) as the original credit amount and always
    // RECOMPUTES the current outstanding/status fresh from that minus SUM(repayments), at read
    // time. This table exists to make that same computation possible from SQLite (see
    // getCreditSettlementByBillId below) — sales.outstanding_amount/payment_status are
    // deliberately left untouched by a repayment, exactly matching the existing behavior this
    // is required to preserve, not a new invented semantic.
    //
    // `id` is NOT locally generated here — the app already generates a stable id client-side
    // before ever writing anywhere ("PMT-" + Date.now() + "-" + random, see
    // handleRecordCreditPayment). Using that same id as this table's own PRIMARY KEY is what
    // gives a retried IPC call free, real idempotency (a second INSERT with the same id is
    // rejected by SQLite itself) — no separate idempotency bookkeeping needed.
    version: 4,
    name: 'create_credit_repayments',
    up(database) {
      database.exec(`
        CREATE TABLE credit_repayments (
          id TEXT PRIMARY KEY,
          sale_id TEXT NOT NULL REFERENCES sales(id),
          amount REAL NOT NULL,
          method TEXT,
          reference TEXT,
          payment_date TEXT NOT NULL,
          recorded_by TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_credit_repayments_sale_id ON credit_repayments(sale_id);
        CREATE INDEX idx_credit_repayments_created_at ON credit_repayments(created_at);
      `);
      const now = new Date().toISOString();
      database
        .prepare("UPDATE database_metadata SET value = '4', updated_at = ? WHERE key = 'schema_version'")
        .run(now);
    },
  },
];

function ensureMigrationsTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

// Transactional, idempotent, restart-safe: each migration's schema changes AND its
// schema_migrations row are written in one better-sqlite3 transaction. If `up()` throws
// partway through, the whole transaction (including the tracking row) rolls back atomically —
// so a crash or error mid-migration leaves no partial schema and no false "applied" record.
// The next startup simply sees the version still missing from schema_migrations and retries it
// from a clean slate. Already-applied versions are never re-run.
function runMigrations(database) {
  ensureMigrationsTable(database);
  const appliedVersions = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version
  );
  for (const migration of pending) {
    const applyOne = database.transaction(() => {
      migration.up(database);
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    });
    applyOne();
  }
}

/**
 * Opens (creating if necessary) the local SQLite database at the given path and runs any
 * pending migrations. Safe to call more than once per process — returns the existing
 * connection instead of opening a second one.
 */
export function initDatabase(filePath) {
  if (db) return db;
  if (!filePath) throw new Error('initDatabase requires an explicit file path');

  dbFilePath = filePath;
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbFilePath);

  // Pragma choices for a single-process desktop transactional app (not copied blindly):
  // - WAL: readers never block the writer and vice versa, and it's the mode that makes
  //   `synchronous = NORMAL` safe (see below) — appropriate since this is a single app process
  //   accessing its own private file, not a multi-process shared database.
  db.pragma('journal_mode = WAL');
  // - foreign_keys ON: SQLite defaults this OFF for backwards compatibility; this app wants
  //   referential integrity enforced for the business schema a later phase will add.
  db.pragma('foreign_keys = ON');
  // - busy_timeout: waits instead of immediately throwing SQLITE_BUSY on the rare moment two
  //   statements from this same process briefly overlap (e.g. the health-check's write probe
  //   running while something else holds a short write lock). 5s is generous for a purely
  //   local, single-process workload where contention should be brief if it happens at all.
  db.pragma('busy_timeout = 5000');
  // - synchronous NORMAL: with WAL (above), NORMAL is durable against an application crash
  //   (the case this whole SQLite effort exists for) while avoiding FULL's fsync-per-statement
  //   cost; only an OS-level crash/power-loss at the exact moment of a WAL checkpoint could
  //   lose the last few transactions, which is the standard, well-documented WAL+NORMAL
  //   tradeoff and is appropriate here — FULL's cost is not justified for this workload.
  db.pragma('synchronous = NORMAL');

  runMigrations(db);
  return db;
}

/**
 * Safe, read-only-by-design health check. Never exposes the raw database or arbitrary SQL —
 * this is the only thing 'database:get-status' hands back over IPC.
 */
export function getDatabaseStatus() {
  if (!db) {
    return { exists: dbFilePath ? fs.existsSync(dbFilePath) : false, opened: false };
  }
  try {
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
    // The authoritative applied version is MAX(version) in schema_migrations — not the
    // database_metadata snapshot row, which only migration 1 ever wrote. Deriving it here
    // means every future migration is automatically reflected with no extra bookkeeping step
    // required in each migration's `up()` (a gap found and fixed during Phase 2B: relying on
    // the metadata row alone would have kept reporting "1" forever after migration 2 landed).
    const versionRow = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get();
    const readTest = !!db.prepare('SELECT 1 AS ok').get();

    // Write test: proves write capability without persisting anything — the insert and its
    // deliberate rollback happen in one transaction, so no probe row is ever actually kept.
    let writeTest = false;
    try {
      const probe = db.transaction(() => {
        db.prepare(
          "INSERT INTO database_metadata (key, value, updated_at) VALUES ('__write_probe__', '1', ?)"
        ).run(new Date().toISOString());
        throw new Error('__rollback_probe__');
      });
      probe();
    } catch (e) {
      writeTest = e.message === '__rollback_probe__';
    }

    return {
      exists: fs.existsSync(dbFilePath),
      opened: true,
      path: dbFilePath,
      schemaVersion: versionRow && versionRow.v != null ? String(versionRow.v) : null,
      sqliteVersion,
      readTest,
      writeTest,
    };
  } catch (e) {
    return { exists: fs.existsSync(dbFilePath), opened: false, error: e.message };
  }
}

/** Returns just the applied schema version (or null if not yet initialized). */
export function getSchemaVersion() {
  return getDatabaseStatus().schemaVersion ?? null;
}

/** Clean shutdown — checkpoints the WAL file back into the main database file. */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Local-first billing transaction (Phase 2C) ───
//
// IMPORTANT — why items/stock_batches are upserted here instead of only ever being looked up:
// Phase 2B deliberately left these tables empty (no Supabase import exists yet, and this phase
// is explicitly forbidden from adding one). Since nothing has ever populated them, the ONLY way
// this database can ever contain real inventory is for a sale itself to lazily create the rows
// it needs, the first time it needs them — the exact same "resolve by name/code, else insert"
// pattern already used by the real Supabase code (see resolveItemId/addInventoryItem in
// cloud-src/vhc-cloud-sync.js), just applied locally instead. On a NEW item's very first local
// sale, there is no prior local stock figure to check against, so the renderer-supplied
// pre-sale `stock` figure (the same number the renderer's own cart already validated the
// quantity against) is trusted ONLY to seed that first row. Every sale after that — including
// every other line in the very same bill — is validated purely against this database's own
// qty, never the renderer's number, satisfying the "do not trust renderer-supplied stock
// quantities blindly" requirement for all but that unavoidable first-sight bootstrap moment.
// A later phase's real Supabase-to-SQLite import will remove the need for this bootstrap path.

function generateId() {
  return crypto.randomUUID();
}

function resolveOrCreateItem(database, now, { name, category, hsnCode, unitsPerPack, productCode, serverId }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('Item name is required');
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId || '');
  const resolvedServerId = looksLikeUuid ? serverId : null;

  let existingId = null;
  if (productCode) {
    const byCode = database
      .prepare('SELECT id FROM items WHERE product_code = ? COLLATE NOCASE LIMIT 1')
      .get(productCode);
    if (byCode) existingId = byCode.id;
  }
  if (!existingId) {
    const existing = database
      .prepare('SELECT id FROM items WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(trimmedName);
    if (existing) existingId = existing.id;
  }
  if (existingId) {
    // Backfill server_id if this item was created locally before its Supabase identity was
    // known (Phase 2C's bootstrap case) and the renderer now supplies one — needed for Phase
    // 2D's sync to ever be able to reference this item remotely. Never overwrites an existing
    // server_id with a different one; a mismatch would indicate a name collision worth leaving
    // alone rather than silently reassigning.
    if (resolvedServerId) {
      database
        .prepare("UPDATE items SET server_id = ?, updated_at = ? WHERE id = ? AND server_id IS NULL")
        .run(resolvedServerId, now, existingId);
    }
    return existingId;
  }

  const id = generateId();
  database
    .prepare(
      `INSERT INTO items (id, server_id, name, category, hsn_code, units_per_pack, product_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, resolvedServerId, trimmedName, category || null, hsnCode || null, unitsPerPack || null, productCode || null, now, now);

  // Phase 2E: an item created here with no known server_id is a genuinely new, offline-created
  // item — queue it for sync. (If resolvedServerId is already set, this item came from the
  // normal online catalog and needs no sync of its own.) `bill_id` is repurposed here as a
  // generic reference label (this row's own id) — the column is shared with 'sale' rows, whose
  // real bill_id it stores; for non-sale entity_types it is never interpreted as a bill.
  if (!resolvedServerId) {
    database
      .prepare(
        `INSERT INTO sync_queue (id, entity_type, entity_id, bill_id, operation, status, attempts, created_at, updated_at)
         VALUES (?, 'item', ?, ?, 'create', 'pending', 0, ?, ?)`
      )
      .run(generateId(), id, id, now, now);
  }
  return id;
}

function resolveOrCreateStockBatch(database, now, { itemId, batchNo, expiryDate, mrp, netRate, gst, stockist, seedQty }) {
  const existing = database
    .prepare('SELECT * FROM stock_batches WHERE item_id = ? AND IFNULL(batch_no, \'\') = IFNULL(?, \'\') LIMIT 1')
    .get(itemId, batchNo || null);
  if (existing) return existing;

  const id = generateId();
  const qty = Number.isFinite(seedQty) ? seedQty : 0;
  database
    .prepare(
      `INSERT INTO stock_batches (id, item_id, batch_no, expiry_date, mrp, net_rate, gst, stockist, qty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, itemId, batchNo || null, expiryDate || null, mrp ?? null, netRate ?? null, gst ?? null, stockist || null, qty, now, now);
  return database.prepare('SELECT * FROM stock_batches WHERE id = ?').get(id);
}

function resolveOrCreatePatient(database, now, snapshot) {
  if (!snapshot || (!snapshot.name && !snapshot.contact)) return null;
  if (snapshot.patientId) {
    // A UUID-shaped patientId means the renderer already resolved this against Supabase's
    // patients table (see resolvePatientId in cloud-src/vhc-cloud-sync.js) — reuse it as this
    // row's server_id so a future sync phase can match them without guessing.
    const byServerId = database.prepare('SELECT id FROM patients WHERE server_id = ?').get(snapshot.patientId);
    if (byServerId) return byServerId.id;
  }
  if (snapshot.contact) {
    const byContact = database.prepare('SELECT id FROM patients WHERE contact = ? LIMIT 1').get(snapshot.contact);
    if (byContact) return byContact.id;
  }
  if (snapshot.name) {
    const byName = database.prepare('SELECT id FROM patients WHERE name = ? COLLATE NOCASE LIMIT 1').get(snapshot.name);
    if (byName) return byName.id;
  }
  const id = generateId();
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshot.patientId || '');
  database
    .prepare(
      `INSERT INTO patients (id, server_id, name, contact, age, sex, address, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      looksLikeUuid ? snapshot.patientId : null,
      snapshot.name || 'Walk-in Patient',
      snapshot.contact || null,
      snapshot.age || null,
      snapshot.sex || null,
      snapshot.address || null,
      snapshot.source || null,
      now,
      now
    );

  // Phase 2E: same reasoning as resolveOrCreateItem above — a patient created here with no
  // known server_id is genuinely new and offline-created, so queue it for sync. Unlike items,
  // Supabase's patients table has a real, safe idempotency mechanism to use for this (see
  // buildCreatePatientPayload): a partial unique index on legacy_patient_id, so this local id
  // can be sent as legacy_patient_id and a retried insert is safely rejected, not duplicated.
  if (!looksLikeUuid) {
    database
      .prepare(
        `INSERT INTO sync_queue (id, entity_type, entity_id, bill_id, operation, status, attempts, created_at, updated_at)
         VALUES (?, 'patient', ?, ?, 'create', 'pending', 0, ?, ?)`
      )
      .run(generateId(), id, id, now, now);
  }
  return id;
}

/**
 * The atomic, authoritative local-first billing transaction. Never trusts the renderer's own
 * math for anything that affects stock — every quantity actually deducted is read back from
 * this database inside the same transaction, not from the payload. Returns a structured result;
 * never throws across this boundary (every failure path is caught and reported as
 * { success:false, error }), so the caller (electron/main.js's IPC handler) never needs its own
 * try/catch to stay safe.
 *
 * @param {object} payload
 *   billId: string — the app's existing "BILL-<timestamp>" identifier, preserved as-is
 *   patientSnapshot: {patientId,name,contact,age,sex,address,source} | null
 *   doctorName, paymentMode, subtotal, totalTax, totalAmount, gstMode, discount, discountPercent
 *   paymentDetails: {breakdown, amountReceived, outstandingAmount, status, recordedBy}
 *   items: [{id,name,category,batch,expiry,mrp,price,netRate,rate,gst,unitsPerPack,customUnitPrice,qty,stock}]
 *   extraParticulars: [{category,drugName,quantity,rate,total,...}] — injections/procedures/
 *     custom charges; never affect stock, carried through as non-stock sale_items for a
 *     complete bill record.
 */
export function createLocalSale(payload) {
  if (!db) return { success: false, error: 'Local database is not initialized' };
  if (!payload || !payload.billId) return { success: false, error: 'billId is required' };
  const cartItems = Array.isArray(payload.items) ? payload.items : [];
  const extraParticulars = Array.isArray(payload.extraParticulars) ? payload.extraParticulars : [];
  if (cartItems.length === 0 && extraParticulars.length === 0) {
    return { success: false, error: 'A sale must contain at least one line item' };
  }

  try {
    const result = db.transaction(() => {
      const now = new Date().toISOString();

      // Step 1-3: resolve/validate every medicine line BEFORE writing anything, so a failure
      // on line 3 of 5 never leaves lines 1-2 partially applied — the whole transaction is
      // still uncommitted at this point.
      const resolvedLines = cartItems.map((cartItem) => {
        const qty = parseFloat(cartItem.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Invalid quantity for ${cartItem.name || 'item'}`);
        }
        const itemId = resolveOrCreateItem(db, now, {
          name: cartItem.name,
          category: cartItem.category || 'Medicine',
          hsnCode: cartItem.hsnCode,
          unitsPerPack: parseFloat(cartItem.unitsPerPack || cartItem.units_per_pack) || null,
          productCode: cartItem.productCode || cartItem.product_code,
          // The renderer's cart item carries the real Supabase items.id as `.itemId` for any
          // medicine that came from the normal online catalog (see rowToInventoryItem in
          // cloud-src/vhc-cloud-sync.js) — capturing it here is what lets Phase 2D's sync
          // engine later reference this item remotely instead of only ever knowing it locally.
          serverId: cartItem.itemId || cartItem.serverId,
        });
        const batch = resolveOrCreateStockBatch(db, now, {
          itemId,
          batchNo: cartItem.batch,
          expiryDate: cartItem.expiry,
          mrp: parseFloat(cartItem.mrp ?? cartItem.price) || null,
          netRate: parseFloat(cartItem.netRate ?? cartItem.rate) || null,
          gst: parseFloat(cartItem.gst) || null,
          stockist: cartItem.stockist,
          seedQty: parseFloat(cartItem.stock),
        });
        if (batch.qty < qty) {
          throw new Error(
            `Insufficient stock for ${cartItem.name}: have ${batch.qty}, need ${qty} (Batch ${cartItem.batch || 'N/A'})`
          );
        }
        const unitsPerPackVal = parseFloat(cartItem.unitsPerPack || cartItem.units_per_pack) || 1;
        const perUnit = (parseFloat(cartItem.mrp ?? cartItem.price) || 0) / unitsPerPackVal;
        const rate =
          cartItem.customUnitPrice !== undefined && cartItem.customUnitPrice !== ''
            ? parseFloat(cartItem.customUnitPrice) || 0
            : perUnit;
        return { cartItem, itemId, batch, qty, rate };
      });

      const patientId = resolveOrCreatePatient(db, now, payload.patientSnapshot);

      // Step 4: create sale.
      const saleId = generateId();
      const paymentDetails = payload.paymentDetails || {};
      db.prepare(
        `INSERT INTO sales (
          id, bill_id, patient_id, patient_name, doctor_name, payment_mode,
          subtotal, total_tax, total_amount, gst_mode, discount, discount_percent,
          amount_received, outstanding_amount, payment_status, payment_breakdown, recorded_by,
          patient_snapshot, sale_date, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(
        saleId,
        payload.billId,
        patientId,
        (payload.patientSnapshot && payload.patientSnapshot.name) || null,
        payload.doctorName || null,
        payload.paymentMode || null,
        payload.subtotal ?? null,
        payload.totalTax ?? null,
        payload.totalAmount ?? 0,
        payload.gstMode || null,
        payload.discount ?? null,
        payload.discountPercent ?? null,
        paymentDetails.amountReceived ?? null,
        paymentDetails.outstandingAmount ?? null,
        paymentDetails.status || null,
        paymentDetails.breakdown ? JSON.stringify(paymentDetails.breakdown) : null,
        paymentDetails.recordedBy || null,
        payload.patientSnapshot ? JSON.stringify(payload.patientSnapshot) : null,
        now,
        now,
        now
      );

      // Step 5 + 6 + 7: sale_items, stock reduction, stock_movements — one medicine line at a time.
      const insertSaleItem = db.prepare(
        `INSERT INTO sale_items (id, sale_id, item_id, stock_batch_id, category, drug_name, batch_no, expiry_date, quantity, rate, total, affects_stock, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateStock = db.prepare('UPDATE stock_batches SET qty = ?, updated_at = ? WHERE id = ?');
      const insertMovement = db.prepare(
        `INSERT INTO stock_movements (id, item_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const { cartItem, itemId, batch, qty, rate } of resolvedLines) {
        const total = rate * qty;
        insertSaleItem.run(
          generateId(), saleId, itemId, batch.id, cartItem.category || 'Medicine',
          cartItem.name, cartItem.batch || 'N/A', cartItem.expiry || 'N/A', qty, rate, total, 1, null
        );
        const closing = batch.qty - qty;
        updateStock.run(closing, now, batch.id);
        insertMovement.run(
          generateId(), itemId, cartItem.batch || null, 'BILL', -qty, batch.qty, closing,
          payload.billId, patientId, `Bill:${payload.billId}`, now
        );
      }

      // Non-stock lines (injections/procedures/custom charges) — recorded as sale_items for a
      // complete bill, but never touch items/stock_batches/stock_movements.
      for (const extra of extraParticulars) {
        insertSaleItem.run(
          generateId(), saleId, null, null, extra.category || 'Custom',
          extra.drugName || extra.label || 'Other', extra.batchNo || 'N/A', extra.expiryDate || 'N/A',
          extra.quantity ?? 1, extra.rate ?? extra.total ?? 0, extra.total ?? 0, 0, JSON.stringify(extra)
        );
      }

      // Step 8 (Phase 2D): enqueue this sale for sync in the SAME transaction as everything
      // above — the whole point of putting it here rather than after commit is that a crash or
      // error between "sale created" and "queue row written" can never happen; both exist or
      // neither does.
      db.prepare(
        `INSERT INTO sync_queue (id, entity_type, entity_id, bill_id, operation, status, attempts, created_at, updated_at)
         VALUES (?, 'sale', ?, ?, 'create', 'pending', 0, ?, ?)`
      ).run(generateId(), saleId, payload.billId, now, now);

      return { success: true, saleId, billId: payload.billId, lineCount: resolvedLines.length + extraParticulars.length };
    })();
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Read-only lookup used by tests/verification — never exposed to the renderer as a generic query. */
export function getLocalSaleByBillId(billId) {
  if (!db) return null;
  const sale = db.prepare('SELECT * FROM sales WHERE bill_id = ?').get(billId);
  if (!sale) return null;
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  return { ...sale, sale_items: items };
}

/**
 * Atomic cancellation: marks the sale deleted and restores every stock-affecting line's
 * quantity via a reverse stock_movement — mirrors the existing app's own restore-on-delete
 * behavior (see reportsUpdateItemsBulk's use in dist/assets/index-doBKNLAj.js), just against
 * this database instead of Supabase. A bill with no local record (e.g. one billed before this
 * phase existed) is a no-op, not an error — the same "nothing to restore" behavior the existing
 * delete_sale_and_restore RPC already has for cloud-side deletes.
 */
export function cancelLocalSale(billId) {
  if (!db) return { success: false, error: 'Local database is not initialized' };
  try {
    const result = db.transaction(() => {
      const sale = db.prepare("SELECT * FROM sales WHERE bill_id = ? AND status = 'active'").get(billId);
      if (!sale) return { success: true, noop: true, reason: 'No active local sale found for this bill_id' };

      const now = new Date().toISOString();
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND affects_stock = 1').all(sale.id);
      const updateStock = db.prepare('UPDATE stock_batches SET qty = qty + ?, updated_at = ? WHERE id = ?');
      const insertMovement = db.prepare(
        `INSERT INTO stock_movements (id, item_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        if (!item.stock_batch_id) continue;
        const batch = db.prepare('SELECT * FROM stock_batches WHERE id = ?').get(item.stock_batch_id);
        if (!batch) continue;
        const closing = batch.qty + item.quantity;
        updateStock.run(item.quantity, now, item.stock_batch_id);
        insertMovement.run(
          generateId(), item.item_id, item.batch_no, 'RESTORE', item.quantity, batch.qty, closing,
          billId, sale.patient_id, 'Bill deleted — stock restored to inventory', now
        );
      }
      db.prepare("UPDATE sales SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, sale.id);

      // Phase 2D: enqueue the cancellation for sync, in the same transaction as the local
      // cancellation itself (same all-or-nothing guarantee as the create path above). If this
      // sale's own 'create' operation hasn't synced yet, this cancel must wait for it — there is
      // no server-side sale to cancel until the create has actually run — so depends_on links to
      // it; the sync engine will only pick this row up once that one reaches 'synced'. If the
      // create already synced (or was never queued, e.g. a bill from before this phase existed),
      // depends_on is left null and this can be processed as soon as the sync engine gets to it.
      const createQueueRow = db
        .prepare("SELECT id, status FROM sync_queue WHERE entity_id = ? AND operation = 'create' ORDER BY created_at DESC LIMIT 1")
        .get(sale.id);
      const dependsOn = createQueueRow && createQueueRow.status !== 'synced' ? createQueueRow.id : null;
      db.prepare(
        `INSERT INTO sync_queue (id, entity_type, entity_id, bill_id, operation, depends_on, status, attempts, created_at, updated_at)
         VALUES (?, 'sale', ?, ?, 'cancel', ?, 'pending', 0, ?, ?)`
      ).run(generateId(), sale.id, billId, dependsOn, now, now);

      return { success: true, saleId: sale.id, restoredLines: items.length };
    })();
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Sync-queue data layer (Phase 2D) ───
// electron/sync-engine.js owns the network side (HTTP, backoff, when-to-run); everything that
// touches SQLite lives here, so sync-engine.js — like every other caller — never sees raw SQL.

/** Any 'processing' row this old is assumed crash-interrupted, not actually in flight. */
const STUCK_PROCESSING_MS = 2 * 60 * 1000;

/**
 * Resets any row stuck in 'processing' (main process died mid-request) back to 'pending'. Safe
 * to do unconditionally because both RPCs this queue drives are safe to retry: create_sale is
 * genuinely idempotent on bill_id, and delete_sale_and_restore's only non-idempotent failure
 * mode (a second call raising "Sale % not found") is explicitly treated as success by the sync
 * engine, not as a reason to avoid retrying. Called once at startup, before the sync engine's
 * first run.
 */
export function recoverStuckSyncItems() {
  if (!db) return { recovered: 0 };
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_MS).toISOString();
  const res = db
    .prepare("UPDATE sync_queue SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at < ?")
    .run(new Date().toISOString(), cutoff);
  return { recovered: res.changes };
}

/**
 * Returns up to `limit` rows eligible to sync right now, oldest first, skipping any row whose
 * `depends_on` hasn't itself reached 'synced' yet (a cancel waiting on its own create).
 */
export function getNextSyncBatch(limit = 10) {
  if (!db) return [];
  return db
    .prepare(
      `SELECT q.* FROM sync_queue q
       WHERE q.status = 'pending'
         AND (q.depends_on IS NULL OR EXISTS (SELECT 1 FROM sync_queue d WHERE d.id = q.depends_on AND d.status = 'synced'))
       ORDER BY q.created_at ASC
       LIMIT ?`
    )
    .all(limit);
}

export function markSyncProcessing(queueId) {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare("UPDATE sync_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, queueId);
}

/**
 * A row succeeded. For a 'create', also stamps sales.server_id so a later 'cancel' (and any
 * future phase's reporting) knows the remote identity — this is the ONLY place server_id is
 * ever written to a local sales row.
 */
export function markSyncSynced(queueId, serverId) {
  if (!db) return;
  const now = new Date().toISOString();
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get(queueId);
    if (!row) return;
    db.prepare("UPDATE sync_queue SET status = 'synced', server_id = ?, synced_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
      .run(serverId || null, now, now, queueId);
    if (row.operation !== 'create' || !serverId) return;
    // Phase 2E: item/patient rows stamp their OWN table's server_id, same principle as sales
    // below — the only place any of these three tables' server_id is ever written.
    if (row.entity_type === 'sale') {
      db.prepare('UPDATE sales SET server_id = ?, updated_at = ? WHERE id = ?').run(serverId, now, row.entity_id);
    } else if (row.entity_type === 'item') {
      db.prepare('UPDATE items SET server_id = ?, updated_at = ? WHERE id = ?').run(serverId, now, row.entity_id);
    } else if (row.entity_type === 'patient') {
      db.prepare('UPDATE patients SET server_id = ?, updated_at = ? WHERE id = ?').run(serverId, now, row.entity_id);
    }
  })();
}

/** A transient (network/timeout) failure — left 'pending' so the next sync cycle retries it. */
export function markSyncRetry(queueId, errorMessage) {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare("UPDATE sync_queue SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ?").run(errorMessage || null, now, queueId);
}

/**
 * A genuine, non-network problem that blind retry cannot fix (remote stock conflict, an item
 * that has never been synced to Supabase and thus cannot be referenced remotely yet, a rejected
 * auth). Stops automatic retries WITHOUT touching the local sale in any way — it stays exactly
 * as-is, permanently, until a human resolves the underlying conflict. This is the queue's only
 * non-retrying state, used deliberately and narrowly, per the explicit requirement to avoid a
 * dead-end "failed" status for ordinary transient problems.
 */
export function markSyncNeedsReview(queueId, errorMessage) {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare("UPDATE sync_queue SET status = 'needs_review', last_error = ?, updated_at = ? WHERE id = ?").run(errorMessage || null, now, queueId);
}

/** Safe, aggregate-only status — never exposes queue payloads or raw rows to the renderer. */
export function getSyncStatus() {
  if (!db) return { pending: 0, processing: 0, needsReview: 0, synced: 0, lastSyncedAt: null, lastError: null };
  const counts = db
    .prepare("SELECT status, COUNT(*) AS c FROM sync_queue GROUP BY status")
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  const lastSynced = db.prepare("SELECT MAX(synced_at) AS t FROM sync_queue WHERE status = 'synced'").get();
  const lastErrorRow = db
    .prepare("SELECT last_error FROM sync_queue WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
    .get();
  return {
    pending: counts.pending || 0,
    processing: counts.processing || 0,
    needsReview: counts.needs_review || 0,
    synced: counts.synced || 0,
    lastSyncedAt: lastSynced ? lastSynced.t : null,
    lastError: lastErrorRow ? lastErrorRow.last_error : null,
  };
}

/**
 * Builds the exact payload the real `create_sale` RPC expects (see
 * supabase/migrations/20260819000200_pharmacy_billing_compatibility_patch1.sql), read fresh
 * from the local database rather than frozen at sale-creation time — so a line item whose
 * server_id gets backfilled later (e.g. by a future catalog-sync phase) is picked up
 * automatically the next time this sale is (re)synced, without needing to touch the queue row.
 *
 * Returns { ok:true, payload } or { ok:false, reason } — a `reason` means this sale cannot be
 * synced YET for a concrete, reportable cause (see Phase 2D's report, section on limitations),
 * not a network problem — the caller should route this to markSyncNeedsReview, not a retry.
 */
export function buildCreateSalePayload(saleId) {
  if (!db) return { ok: false, reason: 'Local database is not initialized' };
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { ok: false, reason: `Local sale ${saleId} no longer exists` };

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const mappedItems = [];
  for (const item of items) {
    if (!item.affects_stock) {
      // Injections/procedures/custom charges — carried through for a complete remote bill, but
      // never reference items/stock_batches at all, so no server_id resolution is needed.
      mappedItems.push({
        category: item.category, drug_name: item.drug_name, batch_no: item.batch_no,
        expiry_date: item.expiry_date, quantity: item.quantity, rate: item.rate, total: item.total,
        affects_stock: false, metadata: item.metadata ? JSON.parse(item.metadata) : {},
      });
      continue;
    }
    const localItem = item.item_id ? db.prepare('SELECT server_id FROM items WHERE id = ?').get(item.item_id) : null;
    if (!localItem || !localItem.server_id) {
      // Phase 2E: this item is itself an offline-created record awaiting its OWN sync (see
      // resolveOrCreateItem's enqueueing). Rather than immediately giving up, check whether
      // that item's own queue row is still genuinely in flight — if so, this sale should just
      // wait and retry (not fail), satisfying "a sale sync must not fail merely because its
      // dependency hasn't synced yet." Only a dependency that is itself permanently stuck
      // (needs_review) or was never queued at all makes this sale unresolvable too.
      const depRow = item.item_id
        ? db.prepare("SELECT status FROM sync_queue WHERE entity_type = 'item' AND entity_id = ? ORDER BY created_at DESC LIMIT 1").get(item.item_id)
        : null;
      const stillWaiting = depRow && (depRow.status === 'pending' || depRow.status === 'processing');
      return {
        ok: false,
        waiting: !!stillWaiting,
        reason: stillWaiting
          ? `Waiting for item "${item.drug_name}" to finish syncing first`
          : `Item "${item.drug_name}" was created entirely offline and could not be synced (${depRow ? 'its own sync is stuck: ' + depRow.status : 'no sync record was ever created for it'})`,
      };
    }
    // Deliberately NOT sending stock_batch_id: the local batch's id is a local-only identifier
    // with no guaranteed Supabase counterpart (Phase 2D does not sync stock_batches either —
    // see the report). Omitting it lets create_sale's own existing FIFO-by-item_id fallback
    // perform the deduction against whatever the batches actually are server-side right now —
    // exactly the "let the server decide, don't upload a local closing-stock number" behavior
    // the task requires for safe multi-computer stock handling.
    mappedItems.push({
      item_id: localItem.server_id, category: item.category, drug_name: item.drug_name,
      batch_no: item.batch_no, expiry_date: item.expiry_date, quantity: item.quantity,
      rate: item.rate, total: item.total, affects_stock: true, metadata: {},
    });
  }

  let patientServerId = null;
  if (sale.patient_id) {
    const localPatient = db.prepare('SELECT server_id FROM patients WHERE id = ?').get(sale.patient_id);
    patientServerId = localPatient ? localPatient.server_id : null;
    // A patient with no server_id is NOT a sync-blocking condition (unlike an item) — sales.
    // patient_id is nullable and patient_name is a plain text field, so the sale still syncs
    // meaningfully (just without a strict patient link) rather than being stuck in needs_review
    // for something that doesn't actually prevent the RPC from succeeding.
  }

  return {
    ok: true,
    payload: {
      bill_id: sale.bill_id,
      patient_id: patientServerId,
      patient_name: sale.patient_name,
      doctor_name: sale.doctor_name,
      payment_mode: sale.payment_mode,
      subtotal: sale.subtotal,
      total_tax: sale.total_tax,
      total_amount: sale.total_amount,
      gst_mode: sale.gst_mode,
      discount: sale.discount,
      discount_percent: sale.discount_percent,
      sale_date: sale.sale_date,
      items: mappedItems,
    },
  };
}

/** Looks up the resolved Supabase sale id for a cancel operation's target sale, if known yet. */
export function getSaleServerId(saleId) {
  if (!db) return null;
  const row = db.prepare('SELECT server_id FROM sales WHERE id = ?').get(saleId);
  return row ? row.server_id : null;
}

// ─── Item / patient sync payload builders (Phase 2E) ───
// IMPORTANT, traced directly from the real Supabase schema (supabase/migrations/
// 20260814000100_init_schema.sql): `items` has NO unique constraint on name or any code
// column at all — `product_code` referenced elsewhere in this codebase is not even a real
// column server-side (confirmed: `productCodeSupported` is hardcoded false in
// cloud-src/vhc-cloud-sync.js, and no migration ever adds this column). This means item-create
// sync CANNOT be made genuinely idempotent at the database level — only a best-effort
// select-by-name check before inserting (see sync-engine.js), which cannot fully rule out a
// race between two different offline computers creating the same-named item and syncing around
// the same time. This is a disclosed, real limitation, not a workaround — see the Phase 2E
// report. `patients`, by contrast, DOES have a real, safe mechanism already in the schema: a
// partial unique index on `legacy_patient_id` (added in
// 20260819000100_pharmacy_billing_compatibility.sql for legacy PID-/WALKIN- ids) — reused here
// by sending this local patient's own id as legacy_patient_id, so a retried insert is safely
// rejected by Postgres itself, not duplicated.

export function buildCreateItemPayload(itemId) {
  if (!db) return { ok: false, reason: 'Local database is not initialized' };
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return { ok: false, waiting: false, reason: `Local item ${itemId} no longer exists` };
  return {
    ok: true,
    payload: {
      // product_code deliberately omitted — not a real column in Supabase's items table.
      name: item.name,
      category: item.category,
      hsn_code: item.hsn_code,
      units_per_pack: item.units_per_pack,
    },
  };
}

export function buildCreatePatientPayload(patientId) {
  if (!db) return { ok: false, reason: 'Local database is not initialized' };
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) return { ok: false, waiting: false, reason: `Local patient ${patientId} no longer exists` };
  return {
    ok: true,
    payload: {
      name: patient.name,
      contact: patient.contact,
      age: patient.age,
      sex: patient.sex,
      address: patient.address,
      source: patient.source,
      // The safe idempotency key — see the module comment above.
      legacy_patient_id: patient.id,
    },
  };
}

// ─── Credit repayments (Phase 2F Step 2) ───

/**
 * Reproduces computeCreditSettlement()'s exact math (index-doBKNLAj.js, ~line 61370) against
 * this database's own data, so SQLite can answer "what is this bill's CURRENT outstanding
 * balance/status" the same way the renderer already does — without ever mutating the sale's
 * own stored amount_received/outstanding_amount/payment_status columns, which the real app
 * never does either (see this migration's own comment above for why that's deliberate, not an
 * oversight to "fix").
 */
function computeCreditSettlementForSale(database, saleId) {
  const sale = database.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return null;

  let breakdown;
  try {
    breakdown = sale.payment_breakdown ? JSON.parse(sale.payment_breakdown) : null;
  } catch (e) {
    breakdown = null;
  }
  if (!breakdown || typeof breakdown !== 'object') {
    breakdown =
      sale.payment_mode === 'Credit'
        ? { credit: sale.total_amount || 0 }
        : sale.payment_mode === 'Split'
          ? { unspecified: sale.total_amount || 0 }
          : { [sale.payment_mode || 'Cash']: sale.total_amount || 0 };
  }

  const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
  const originalCredit = round2(breakdown.credit);
  const collectedAtCheckout = round2(
    Object.keys(breakdown).reduce(
      (sum, k) => (String(k).toLowerCase() === 'credit' ? sum : sum + (parseFloat(breakdown[k]) || 0)),
      0
    )
  );
  const repayments = database
    .prepare('SELECT * FROM credit_repayments WHERE sale_id = ? ORDER BY created_at ASC')
    .all(saleId);
  const totalRepaid = round2(repayments.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0));
  const outstanding = round2(Math.max(0, originalCredit - totalRepaid));

  let status;
  if (originalCredit <= 0) {
    status = sale.payment_status === 'Credit' ? 'Pending/Unpaid' : sale.payment_status || 'Paid';
  } else if (outstanding <= 0) {
    status = 'Paid';
  } else if (collectedAtCheckout > 0 || totalRepaid > 0) {
    status = 'Partially Paid';
  } else {
    status = 'Pending/Unpaid';
  }

  return { saleId, breakdown, originalCredit, collectedAtCheckout, repayments, totalRepaid, outstanding, status };
}

/**
 * Records one credit repayment atomically against a local sale (looked up by bill_id, matching
 * every other bill-identified IPC in this file). Validates the amount against THIS database's
 * own authoritative current outstanding balance — never trusts a renderer-precomputed figure,
 * same principle as createLocalSale's stock validation.
 *
 * Idempotent on `id`: if this exact repayment id was already recorded (a retried IPC call,
 * e.g. after a lost response), returns the existing row as a successful no-op rather than
 * erroring or creating a second row — enforced by the table's own PRIMARY KEY, not
 * re-implemented here.
 *
 * A sale that doesn't exist locally (a bill from before local-first billing existed, or one
 * billed on another terminal and only ever seen here via the cloud) is NOT an error — it is
 * reported distinctly (`reason: 'sale-not-found'`) so the caller can fall back to the existing
 * localStorage-only behavior exactly as it worked before this table existed, rather than
 * breaking repayments for bills SQLite simply doesn't know about yet.
 */
export function recordCreditRepayment({ id, billId, amount, method, reference, date, recordedBy }) {
  if (!db) return { success: false, error: 'Local database is not initialized' };
  if (!billId) return { success: false, error: 'billId is required' };
  if (!id) return { success: false, error: 'id is required' };

  try {
    const result = db.transaction(() => {
      const sale = db.prepare("SELECT * FROM sales WHERE bill_id = ? AND status = 'active'").get(billId);
      if (!sale) {
        return { success: false, reason: 'sale-not-found', error: `No local sale found for bill ${billId}` };
      }

      const existing = db.prepare('SELECT * FROM credit_repayments WHERE id = ?').get(id);
      if (existing) {
        return {
          success: true,
          duplicate: true,
          repayment: existing,
          settlement: computeCreditSettlementForSale(db, sale.id),
        };
      }

      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return { success: false, error: 'Invalid repayment amount' };
      }

      const settlementBefore = computeCreditSettlementForSale(db, sale.id);
      if (amt > settlementBefore.outstanding + 0.004) {
        return { success: false, error: 'Payment amount cannot exceed the outstanding balance' };
      }

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO credit_repayments (id, sale_id, amount, method, reference, payment_date, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, sale.id, amt, method || null, reference || null, date || now, recordedBy || null, now);

      const repayment = db.prepare('SELECT * FROM credit_repayments WHERE id = ?').get(id);
      return {
        success: true,
        duplicate: false,
        repayment,
        settlement: computeCreditSettlementForSale(db, sale.id),
      };
    })();
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Read-only — every repayment for one bill, oldest first (deterministic order, matches the
 *  renderer's existing display order for creditRepayments[]). */
export function getCreditRepaymentsByBillId(billId) {
  if (!db) return [];
  const sale = db.prepare('SELECT id FROM sales WHERE bill_id = ?').get(billId);
  if (!sale) return [];
  return db.prepare('SELECT * FROM credit_repayments WHERE sale_id = ? ORDER BY created_at ASC').all(sale.id);
}

/**
 * Bulk variant for a future Reports/Payments screen rendering many bills at once — avoids an
 * N+1 query pattern. Returns a map of billId -> repayments[].
 */
export function getCreditRepaymentsForBillIds(billIds) {
  if (!db || !Array.isArray(billIds) || billIds.length === 0) return {};
  const placeholders = billIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT cr.*, s.bill_id AS bill_id FROM credit_repayments cr
       JOIN sales s ON s.id = cr.sale_id
       WHERE s.bill_id IN (${placeholders})
       ORDER BY cr.created_at ASC`
    )
    .all(...billIds);
  const byBillId = {};
  for (const row of rows) {
    if (!byBillId[row.bill_id]) byBillId[row.bill_id] = [];
    byBillId[row.bill_id].push(row);
  }
  return byBillId;
}

/** Read-only — the CURRENT derived settlement state for one bill (see
 *  computeCreditSettlementForSale's comment for why this is never a stored value). */
export function getCreditSettlementByBillId(billId) {
  if (!db) return null;
  const sale = db.prepare('SELECT id FROM sales WHERE bill_id = ?').get(billId);
  if (!sale) return null;
  return computeCreditSettlementForSale(db, sale.id);
}

// ─── Sales history read migration (Phase 2F Step 3) ───
// Maps SQLite rows back into the EXACT bill-record shape the renderer already expects (see
// index-doBKNLAj.js's ae() — the function that has always written this shape to
// localStorage['vhc_pos_sales_history']) — the goal traced from the actual UI code is
// SQLite -> existing particulars[]/bill contract -> existing UI, never a new UI contract.

/** sale_items row -> the existing particulars[] entry shape. Metadata (medicineName,
 *  syringeCharge, procedureName, materials, label, amount, etc. — see the extraParticulars
 *  construction in index-doBKNLAj.js's checkout flow) is spread back on top so no
 *  non-stock-line field is lost, exactly mirroring what the renderer itself already stores
 *  inline on a particular rather than nested. */
function mapSaleItemToParticular(item) {
  let metadata = {};
  if (item.metadata) {
    try { metadata = JSON.parse(item.metadata) || {}; } catch (e) { metadata = {}; }
  }
  return {
    category: item.category || 'Medicine',
    drugName: item.drug_name || '',
    batchNo: item.batch_no || 'N/A',
    expiryDate: item.expiry_date || 'N/A',
    quantity: item.quantity,
    rate: item.rate,
    total: item.total,
    ...metadata,
  };
}

/** credit_repayments row -> the exact {id, amount, method, reference, date, recordedBy} shape
 *  computeCreditSettlement()/expandBillToPaymentTransactions() already expect (see Step 2). */
function mapRepaymentRowToEntry(row) {
  return {
    id: row.id,
    amount: row.amount,
    method: row.method,
    reference: row.reference,
    date: row.payment_date,
    recordedBy: row.recorded_by,
  };
}

function mapSaleRowToBillObject(database, sale, repaymentsForThisBill) {
  const items = database.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  let patientSnapshot = null;
  if (sale.patient_snapshot) {
    try { patientSnapshot = JSON.parse(sale.patient_snapshot); } catch (e) { patientSnapshot = null; }
  }
  let paymentBreakdown = null;
  if (sale.payment_breakdown) {
    try { paymentBreakdown = JSON.parse(sale.payment_breakdown); } catch (e) { paymentBreakdown = null; }
  }
  return {
    billId: sale.bill_id,
    date: sale.sale_date,
    patientName: sale.patient_name || '',
    patientId: sale.patient_id || '',
    patientSnapshot,
    doctorName: sale.doctor_name || '',
    paymentMode: sale.payment_mode || 'Cash',
    subtotal: sale.subtotal || 0,
    totalTax: sale.total_tax || 0,
    totalAmount: sale.total_amount || 0,
    gstMode: sale.gst_mode || 'regular',
    discount: sale.discount || 0,
    discountPercent: sale.discount_percent || 0,
    amountReceived: sale.amount_received,
    outstandingAmount: sale.outstanding_amount,
    paymentStatus: sale.payment_status,
    paymentBreakdown,
    recordedBy: sale.recorded_by,
    particulars: items.map(mapSaleItemToParticular),
    creditRepayments: (repaymentsForThisBill || []).map(mapRepaymentRowToEntry),
  };
}

/**
 * The authoritative local read source for Reports/Dashboard/Payments/Credit (Phase 2F Step 3).
 * Excludes cancelled sales (status != 'active') — matching the existing app's own behavior,
 * where a deleted bill is removed from localStorage entirely and never shown, not displayed
 * with a "deleted" badge. Uses the existing bulk repayment helper (getCreditRepaymentsForBillIds)
 * rather than one query per bill.
 */
export function getSalesHistory() {
  if (!db) return [];
  const sales = db.prepare("SELECT * FROM sales WHERE status = 'active' ORDER BY sale_date DESC").all();
  if (sales.length === 0) return [];
  const repaymentsByBillId = getCreditRepaymentsForBillIds(sales.map((s) => s.bill_id));
  return sales.map((sale) => mapSaleRowToBillObject(db, sale, repaymentsByBillId[sale.bill_id]));
}

/**
 * A SQLite-only aggregate — deliberately NOT what feeds the Dashboard's on-screen tiles
 * directly (see the Phase 2F Step 3 report's Dashboard section): the existing Dashboard
 * already merges cross-terminal cloud sales on top of local data via mergeCloudSalesIntoLocal,
 * and this function has no visibility into that cloud data at all. Using it as a wholesale
 * replacement for the Dashboard's existing merged-array computation would silently DROP
 * cross-terminal bills from the displayed totals — a real regression this function is
 * deliberately not wired into. It exists as an available, tested building block (and for a
 * possible future SQLite-only-metrics use case), not as the current Dashboard's data source.
 */
export function getSalesSummary() {
  if (!db) return { billCount: 0, totalRevenue: 0, uniquePatientCount: 0 };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS billCount,
              COALESCE(SUM(total_amount), 0) AS totalRevenue,
              COUNT(DISTINCT NULLIF(TRIM(patient_name), '')) AS uniquePatientCount
       FROM sales WHERE status = 'active'`
    )
    .get();
  return { billCount: row.billCount, totalRevenue: row.totalRevenue, uniquePatientCount: row.uniquePatientCount };
}
