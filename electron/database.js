// ─── SQLite local-database module ───
// This module owns the ONLY better-sqlite3 Database instance in the process. Nothing outside
// this file ever touches the raw database object — main.js only calls the safe, named
// functions exported below, and those are the only things exposed to the renderer via IPC.
//
// The billing checkout flow (dist/assets/index-doBKNLAj.js) calls createLocalSale() as the
// authoritative local record of a completed sale, whether or not the internet is reachable.
// Supabase remains the owner of CLOUD stock: the renderer's existing applyInventoryDeductions ->
// bulkUpdateInventory path is the only thing that changes cloud stock, exactly once per sale.
// This module keeps a local shadow ledger only; it never talks to the network, and there is
// deliberately NO sync queue here — nothing in this module can cause a second cloud deduction.
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
        'VHC Pharmacy POS local SQLite store — local-first sales, credit repayments and history',
        now
      );
    },
  },
  {
    // Local schema for the pharmacy's core operational data. Column names/shapes follow the
    // Supabase tables the app already uses (items, stock_batches, stock_movements, patients,
    // sales, sale_items — see dist/assets/vhc-cloud-sync.js) plus the local bill record the
    // renderer saves to localStorage['vhc_pos_sales_history'] (see `ae()` in
    // dist/assets/index-doBKNLAj.js): amount_received/outstanding_amount/payment_status/
    // payment_breakdown/recorded_by exist only in that local record (the cloud mirror is
    // recordOnly), and the existing Credit Repayment feature depends on them.
    //
    // `server_id` columns are reserved and never written by this module.
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
    // Credit repayments. The app never mutates a bill's own outstanding/status after a
    // repayment: payment_breakdown.credit (frozen at checkout) is the original credit amount and
    // the current outstanding/status is always RECOMPUTED from that minus SUM(repayments) at
    // read time (see getCreditSettlementByBillId). sales.outstanding_amount/payment_status are
    // deliberately left untouched by a repayment, matching the existing renderer behavior.
    //
    // `id` is the stable client-generated repayment id ("PMT-<ts>-<rand>") used as this table's
    // PRIMARY KEY, so a retried call with the same id is rejected by SQLite itself (idempotent).
    version: 3,
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
        .prepare("UPDATE database_metadata SET value = '3', updated_at = ? WHERE key = 'schema_version'")
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

  const opened = new Database(dbFilePath);
  try {
    // Pragma choices for a single-process desktop transactional app:
    // - WAL: readers never block the writer; makes `synchronous = NORMAL` safe (below).
    opened.pragma('journal_mode = WAL');
    // - foreign_keys ON: SQLite defaults this OFF; the business schema relies on it.
    opened.pragma('foreign_keys = ON');
    // - busy_timeout: wait instead of throwing SQLITE_BUSY if two statements briefly overlap.
    opened.pragma('busy_timeout = 5000');
    // - synchronous NORMAL: with WAL this is durable against an application crash (the case
    //   this database exists for) without FULL's fsync-per-statement cost.
    opened.pragma('synchronous = NORMAL');

    runMigrations(opened);
  } catch (e) {
    // Never keep a half-initialized connection (corrupt file, failed migration, ...).
    try { opened.close(); } catch (closeErr) {}
    throw e;
  }
  db = opened;
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
    // in each migration's `up()`.
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

// ─── Local-first billing transaction ───
//
// items/stock_batches are created lazily: nothing imports the Supabase catalog, so a sale
// creates the rows it needs the first time it needs them ("resolve by name/code, else insert",
// the same pattern as resolveItemId/addInventoryItem in cloud-src/vhc-cloud-sync.js).
//
// STOCK MODEL (VHC-specific): Supabase owns stock. Purchases, warehouse transfers, manual edits
// and other terminals change it without passing through this database, so a local quantity that
// only tracks local sales would drift and wrongly reject valid sales. Each sale therefore
// reconciles the local batch to the pre-sale `stock` figure carried by the cart (the same number
// the renderer validated against, already reflecting earlier local paints) and records any
// difference as an auditable 'RECONCILE' stock_movement. The main process still independently
// rejects non-positive quantities and any quantity exceeding the reconciled stock, and applies
// the deduction atomically with the sale. This module never changes cloud stock.

function generateId() {
  return crypto.randomUUID();
}

// A business-rule rejection (insufficient stock, invalid quantity, duplicate bill, ...) is
// flagged `rejected: true` so the caller can tell it apart from an infrastructure failure
// (disk full, locked/corrupt file): the former must stop the sale, the latter must not.
function businessError(message) {
  const e = new Error(message);
  e.rejected = true;
  return e;
}

function resolveOrCreateItem(database, now, { name, category, hsnCode, unitsPerPack, productCode, serverId }) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw businessError('Item name is required');
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
    // Backfill server_id if the item was first seen locally without a Supabase identity. Never
    // overwrites an existing server_id with a different one (a mismatch would indicate a name
    // collision worth leaving alone).
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
    // patients table (see resolvePatientId in cloud-src/vhc-cloud-sync.js) — match on it.
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
  return id;
}

/**
 * The atomic local-first billing transaction: sale, sale_items, stock reduction and
 * stock_movements commit together or not at all. Quantities are validated here in the main
 * process (see STOCK MODEL above); a repeated billId is rejected with { duplicate: true }.
 * Returns a structured result;
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
  if (!payload || !payload.billId) return { success: false, rejected: true, error: 'billId is required' };
  const cartItems = Array.isArray(payload.items) ? payload.items : [];
  const extraParticulars = Array.isArray(payload.extraParticulars) ? payload.extraParticulars : [];
  if (cartItems.length === 0 && extraParticulars.length === 0) {
    return { success: false, rejected: true, error: 'A sale must contain at least one line item' };
  }

  try {
    const result = db.transaction(() => {
      const now = new Date().toISOString();

      if (db.prepare('SELECT 1 FROM sales WHERE bill_id = ?').get(payload.billId)) {
        return { success: false, rejected: true, duplicate: true, error: `Bill ${payload.billId} already exists` };
      }

      // Resolve/validate every medicine line BEFORE deducting anything; any throw rolls back
      // the whole transaction (including reconcile writes), so a failure on line 3 of 5 never
      // leaves earlier lines partially applied.
      const reservedByBatch = new Map();
      const insertReconcile = db.prepare(
        `INSERT INTO stock_movements (id, item_id, batch_no, type, qty, opening, closing, bill_id, patient_id, reason, created_at)
         VALUES (?, ?, ?, 'RECONCILE', ?, ?, ?, ?, NULL, ?, ?)`
      );
      const resolvedLines = cartItems.map((cartItem) => {
        const qty = parseFloat(cartItem.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw businessError(`Invalid quantity for ${cartItem.name || 'item'}`);
        }
        const itemId = resolveOrCreateItem(db, now, {
          name: cartItem.name,
          category: cartItem.category || 'Medicine',
          hsnCode: cartItem.hsnCode,
          unitsPerPack: parseFloat(cartItem.unitsPerPack || cartItem.units_per_pack) || null,
          productCode: cartItem.productCode || cartItem.product_code,
          // Real Supabase items.id for catalog medicines (see rowToInventoryItem in
          // cloud-src/vhc-cloud-sync.js); stored for reference only.
          serverId: cartItem.itemId || cartItem.serverId,
        });
        let batch = resolveOrCreateStockBatch(db, now, {
          itemId,
          batchNo: cartItem.batch,
          expiryDate: cartItem.expiry,
          mrp: parseFloat(cartItem.mrp ?? cartItem.price) || null,
          netRate: parseFloat(cartItem.netRate ?? cartItem.rate) || null,
          gst: parseFloat(cartItem.gst) || null,
          stockist: cartItem.stockist,
          seedQty: parseFloat(cartItem.stock),
        });
        const reportedStock = parseFloat(cartItem.stock);
        if (Number.isFinite(reportedStock) && reportedStock >= 0 && Math.abs(reportedStock - batch.qty) > 1e-9) {
          insertReconcile.run(
            generateId(), itemId, cartItem.batch || null, reportedStock - batch.qty, batch.qty, reportedStock,
            payload.billId, 'Local ledger reconciled to cart stock before sale', now
          );
          db.prepare('UPDATE stock_batches SET qty = ?, updated_at = ? WHERE id = ?').run(reportedStock, now, batch.id);
          batch = db.prepare('SELECT * FROM stock_batches WHERE id = ?').get(batch.id);
        }
        const alreadyReserved = reservedByBatch.get(batch.id) || 0;
        if (batch.qty < alreadyReserved + qty) {
          throw businessError(
            `Insufficient stock for ${cartItem.name}: have ${batch.qty}, need ${alreadyReserved + qty} (Batch ${cartItem.batch || 'N/A'})`
          );
        }
        reservedByBatch.set(batch.id, alreadyReserved + qty);
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
        const opening = db.prepare('SELECT qty FROM stock_batches WHERE id = ?').get(batch.id).qty;
        const closing = opening - qty;
        updateStock.run(closing, now, batch.id);
        insertMovement.run(
          generateId(), itemId, cartItem.batch || null, 'BILL', -qty, opening, closing,
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

      return { success: true, saleId, billId: payload.billId, lineCount: resolvedLines.length + extraParticulars.length };
    })();
    return result;
  } catch (e) {
    return { success: false, rejected: e.rejected === true, error: e.message };
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

      return { success: true, saleId: sale.id, restoredLines: items.length };
    })();
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Credit repayments ───

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
        return { success: false, rejected: true, error: 'Invalid repayment amount' };
      }

      const settlementBefore = computeCreditSettlementForSale(db, sale.id);
      if (amt > settlementBefore.outstanding + 0.004) {
        return { success: false, rejected: true, error: 'Payment amount cannot exceed the outstanding balance' };
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

// ─── Sales history reads ───
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
 * The local read source for Reports/Dashboard/Payments/Credit (merged with legacy history by the renderer).
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
 * directly: the existing Dashboard
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
