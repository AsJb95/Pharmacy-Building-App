const fs = require('fs');
const path = require('path');

// Embedded (forked-by-Electron) copy: config now lives in the shared production data
// folder rather than next to this script, so it resolves correctly regardless of where
// the app is installed (Program Files, portable, dev checkout, another machine, etc.) —
// the same convention already used for dataFile/ledgerDir/notificationLogFile below.
// VHC_TELEGRAM_CONFIG_PATH lets a dev/test launch point at an isolated config file,
// mirroring the VHC_TEST_USERDATA / VHC_TEST_BACKUP_DIR pattern used by the main app.
const CONFIG_PATH = process.env.VHC_TELEGRAM_CONFIG_PATH || 'C:\\VHC_Pharmacy_Data\\telegram_config.json';

// Built-in defaults. No bot token lives here (or anywhere else on a pharmacy PC) — the real
// token is held exclusively server-side by the telegram-relay Supabase Edge Function; see
// lib/telegram.js, which authenticates to that relay with the Pharmacy app's own Supabase
// session instead. These are the same values electron/main.js writes out when it
// auto-provisions this file on first launch (so a fresh PC needs zero manual setup); kept
// here too so the bot still works from sane defaults even if the file is ever missing or
// corrupted (e.g. running bot.js standalone, or a hand-edited file with a typo) instead of
// refusing to start.
const DEFAULT_CONFIG = {
  channelChatId: '',
  dataFile: 'C:\\VHC_Pharmacy_Data\\gdrive_backups\\VHC_POS_AutoBackup.json',
  ledgerDir: 'C:\\VHC_Pharmacy_Data\\ledger',
  timezone: 'Asia/Kolkata',
  lowStockUnits: 20,
  lowStockStrips: 2,
  nearExpiryDays: 90,
  ledgerPort: 4321,
  allowedUserIds: [733453718, 6995447067],
  autoReportEnabled: true,
  reportTimes: ['21:30'],
  notificationLogFile: 'C:\\VHC_Pharmacy_Data\\telegram_notifications.json',
  schedulerStateFile: 'C:\\VHC_Pharmacy_Data\\telegram_scheduler_state.json',
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[${new Date().toISOString()}] telegram_config.json is invalid (${e.message}) — using built-in defaults until it's fixed.`);
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...onDisk };
}

module.exports = { loadConfig, CONFIG_PATH, DEFAULT_CONFIG };
