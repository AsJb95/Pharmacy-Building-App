const fs = require('fs');

function loadSnapshot(cfg) {
  if (!fs.existsSync(cfg.dataFile)) {
    throw new Error(
      `Data file not found at ${cfg.dataFile}\n` +
      `Open the VHC Pharmacy POS app at least once so it writes an auto-backup, then try again.`
    );
  }
  const raw = fs.readFileSync(cfg.dataFile, 'utf8');
  const snapshot = JSON.parse(raw);
  snapshot.salesHistory = snapshot.salesHistory || [];
  snapshot.inventory = snapshot.inventory || [];
  snapshot.settings = snapshot.settings || {};
  return snapshot;
}

// "YYYY-MM-DD" for a Date, in the configured timezone.
function dateKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

function todayKey(timezone) {
  return dateKey(new Date(), timezone);
}

function yesterdayKey(timezone) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKey(d, timezone);
}

function salesOnDate(salesHistory, dayKey, timezone) {
  return salesHistory.filter((bill) => {
    if (!bill.date) return false;
    return dateKey(new Date(bill.date), timezone) === dayKey;
  });
}

// Inclusive [fromKey, toKey] range filter — "YYYY-MM-DD" keys compare correctly as plain
// strings, so no date-object math is needed here. Powers every period option on the Report
// menu (Today/Yesterday reuse salesOnDate above; this covers the multi-day ones).
function salesInRange(salesHistory, fromKey, toKey, timezone) {
  return salesHistory.filter((bill) => {
    if (!bill.date) return false;
    const key = dateKey(new Date(bill.date), timezone);
    return key >= fromKey && key <= toKey;
  });
}

function addDaysKey(dayKey, delta, timezone) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  // Re-derive via the configured timezone for consistency with the rest of this module,
  // even though a UTC-based day arithmetic step is what shifted it — this only matters at
  // DST-transition edges, which India (the app's only configured timezone) doesn't observe.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(dt);
}

function last7DaysRange(timezone) {
  const to = todayKey(timezone);
  const from = addDaysKey(to, -6, timezone); // inclusive of today = 7 days total
  return { fromKey: from, toKey: to, label: 'Last 7 Days' };
}

// monthsAgo: 0 = this month (from day 1 through today), 1 = last month (the full calendar month).
function monthRange(monthsAgo, timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .formatToParts(now)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  let year = parseInt(parts.year, 10);
  let month = parseInt(parts.month, 10); // 1-12
  month -= monthsAgo;
  while (month < 1) { month += 12; year -= 1; }
  const fromKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isCurrentMonth = monthsAgo === 0;
  const toDay = isCurrentMonth ? parseInt(todayKey(timezone).split('-')[2], 10) : lastDay;
  const toKey = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(toDay, lastDay)).padStart(2, '0')}`;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { fromKey, toKey, label: `${monthName} ${year}` };
}

// Accepts "DD/MM/YYYY-DD/MM/YYYY" or "DD-MM-YYYY DD-MM-YYYY" style free text (the format the
// bot documents to the user) and returns { fromKey, toKey } or null if it doesn't parse.
// Deliberately permissive about the separator between the two dates, strict about each date
// itself, so a genuinely malformed request gets a clear "couldn't understand that" reply
// rather than silently misinterpreting it.
function parseCustomRange(text) {
  const cleaned = (text || '').trim();
  const dateRe = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/g;
  const matches = [...cleaned.matchAll(dateRe)];
  if (matches.length !== 2) return null;
  const toKeyFromMatch = (m) => {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  let [a, b] = [toKeyFromMatch(matches[0]), toKeyFromMatch(matches[1])];
  if (!a || !b) return null;
  if (a > b) [a, b] = [b, a]; // tolerate the two dates being given in either order
  return { fromKey: a, toKey: b };
}

// Expiry strings in this data come as "MM/YY" or "MM/YYYY". Returns the last day
// of that month as a Date, or null if unparseable/blank.
function parseExpiry(expiryStr) {
  if (!expiryStr) return null;
  const match = String(expiryStr).trim().match(/^(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  let year = parseInt(match[2], 10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return null;
  // Day 0 of next month = last day of `month`.
  return new Date(year, month, 0);
}

function daysUntil(date) {
  const ms = date.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

// Best-effort match of a sold line item back to its inventory record, by name + batch,
// falling back to name-only if the batch isn't found (batches get consumed/rotated).
function findInventoryMatch(inventory, drugName, batchNo) {
  const name = (drugName || '').trim().toUpperCase();
  if (!name) return null;
  if (batchNo) {
    const exact = inventory.find(
      (i) => (i.name || '').trim().toUpperCase() === name && (i.batch || '').trim() === String(batchNo).trim()
    );
    if (exact) return exact;
  }
  return inventory.find((i) => (i.name || '').trim().toUpperCase() === name) || null;
}

// Case-insensitive substring match on medicine name — the only field a pharmacy staff member
// would realistically type from memory. Sorted so exact/prefix matches surface first.
function searchInventory(inventory, query, max = 20) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const matches = inventory.filter((i) => (i.name || '').toLowerCase().includes(q));
  matches.sort((a, b) => {
    const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase();
    const aStarts = an.startsWith(q) ? 0 : 1, bStarts = bn.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return an.localeCompare(bn);
  });
  return matches.slice(0, max);
}

module.exports = {
  loadSnapshot,
  dateKey,
  todayKey,
  yesterdayKey,
  salesOnDate,
  salesInRange,
  last7DaysRange,
  monthRange,
  parseCustomRange,
  parseExpiry,
  daysUntil,
  findInventoryMatch,
  searchInventory,
};
