const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function filePath(cfg, name) {
  return path.join(cfg.ledgerDir, name);
}

function readAll(cfg, name) {
  const p = filePath(cfg, name);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function appendEntry(cfg, name, entry) {
  ensureDir(cfg.ledgerDir);
  const p = filePath(cfg, name);
  const all = readAll(cfg, name);
  const record = { id: Date.now(), timestamp: new Date().toISOString(), ...entry };
  all.push(record);
  fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
  return record;
}

function readRefunds(cfg) {
  return readAll(cfg, 'refunds.json');
}

function readDiscounts(cfg) {
  return readAll(cfg, 'discounts.json');
}

function addRefund(cfg, entry) {
  return appendEntry(cfg, 'refunds.json', entry);
}

function addDiscount(cfg, entry) {
  return appendEntry(cfg, 'discounts.json', entry);
}

function entriesOnDate(entries, dayKey, timezone) {
  return entries.filter((e) => {
    if (!e.timestamp) return false;
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(e.timestamp)) === dayKey;
  });
}

module.exports = { readRefunds, readDiscounts, addRefund, addDiscount, entriesOnDate };
