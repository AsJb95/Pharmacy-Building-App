// Append-only log of every report/alert the bot has sent — the "notification center" data
// store. Kept as a single JSON array capped at a reasonable length so it never grows without
// bound. This is intentionally the bot's OWN persistent record, independent of Telegram
// itself (so history survives even if messages are deleted on the Telegram side), and is
// designed to be readable by the POS app later (e.g. an IPC handler that reads this same
// file) without requiring any change to how the bot writes it.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;

function logPath(cfg) {
  return cfg.notificationLogFile || 'C:\\VHC_Pharmacy_Data\\telegram_notifications.json';
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readNotifications(cfg, limit) {
  const p = logPath(cfg);
  if (!fs.existsSync(p)) return [];
  let all;
  try {
    all = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(all)) return [];
  return limit ? all.slice(-limit) : all;
}

// type: 'report' | 'alert' | 'command' | 'security'
function logNotification(cfg, { type, title, summary, chatId, userId, meta }) {
  const p = logPath(cfg);
  ensureDir(p);
  const all = readNotifications(cfg);
  all.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: type || 'report',
    title: title || '',
    summary: summary || '',
    chatId: chatId ?? null,
    userId: userId ?? null,
    meta: meta || null,
  });
  const trimmed = all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
  fs.writeFileSync(p, JSON.stringify(trimmed, null, 2), 'utf8');
}

module.exports = { logNotification, readNotifications, logPath };
