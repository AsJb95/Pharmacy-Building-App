const { contextBridge, ipcRenderer } = require('electron');

const PROD_SUPABASE_URL = 'https://yrgtnhvnwkqudxdcrkhm.supabase.co';
const PROD_SUPABASE_ANON_KEY = 'sb_publishable_7fL9ZcI18hC1XiMqeCLhlg_YXNzABAC';

function getSupabaseRuntimeConfig() {
  const requested = String(process.env.VHC_SUPABASE_ENVIRONMENT || process.env.VHC_SUPABASE_ENV || 'PRODUCTION').trim().toUpperCase();
  const environmentName = requested === 'TEST' || requested === 'PRODUCTION' ? requested : 'INVALID';
  const url = environmentName === 'TEST'
    ? String(process.env.VHC_TEST_SUPABASE_URL || '').trim()
    : (environmentName === 'PRODUCTION' ? String(process.env.VHC_SUPABASE_URL || PROD_SUPABASE_URL).trim() : '');
  const anonKey = environmentName === 'TEST'
    ? String(process.env.VHC_TEST_SUPABASE_ANON_KEY || '').trim()
    : (environmentName === 'PRODUCTION' ? String(process.env.VHC_SUPABASE_ANON_KEY || PROD_SUPABASE_ANON_KEY).trim() : '');
  const productionUrl = PROD_SUPABASE_URL;
  const isProductionUrl = url.replace(/\/+$/, '') === productionUrl.replace(/\/+$/, '');
  const missing = !url || !anonKey;
  return {
    environmentName,
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    productionUrl,
    isProductionUrl,
    cloudWritesAllowed: environmentName === 'PRODUCTION' ? !missing : (!missing && !isProductionUrl),
    disabledReason: environmentName === 'INVALID'
      ? `Unsupported VHC Supabase environment: ${requested}`
      : (missing ? 'SAFE CLOUD TEST TARGET REQUIRED'
        : (environmentName === 'TEST' && isProductionUrl ? 'PRODUCTION SUPABASE BLOCKED FOR DESTRUCTIVE TESTING' : '')),
  };
}

// Override native alert and confirm to use IPC to the main process
// This prevents the renderer from losing focus when these dialogs close
contextBridge.exposeInMainWorld('electronAPI', {
  getSupabaseRuntimeConfig,
  // Single source of truth for the version shown in the UI — reads directly
  // from the packaged app's package.json via Electron's own app.getVersion(),
  // instead of a hand-maintained string that can (and did) drift out of sync.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Local SQLite database (vhc_pharmacy.db) — narrow, named calls only; no SQL passthrough.
  getDatabaseStatus: () => ipcRenderer.invoke('database:get-status'),
  getDatabaseSchemaVersion: () => ipcRenderer.invoke('database:get-schema-version'),
  getOfflineAuthIdentity: () => ipcRenderer.invoke('database:get-offline-auth-identity'),
  recordOfflineAuthIdentity: (identity) => ipcRenderer.invoke('database:record-offline-auth-identity', identity),
  clearOfflineAuthIdentity: () => ipcRenderer.invoke('database:clear-offline-auth-identity'),
  createLocalSale: (payload) => ipcRenderer.invoke('database:create-local-sale', payload),
  cancelLocalSale: (billId) => ipcRenderer.invoke('database:cancel-local-sale', billId),
  createLocalSaleReturn: (payload) => ipcRenderer.invoke('database:create-local-sale-return', payload),
  getLocalSale: (billId) => ipcRenderer.invoke('database:get-local-sale', billId),
  getPendingStockOverlays: () => ipcRenderer.invoke('database:get-pending-stock-overlays'),
  recordCreditRepayment: (payload) => ipcRenderer.invoke('database:record-credit-repayment', payload),
  getCreditRepayments: (billId) => ipcRenderer.invoke('database:get-credit-repayments', billId),
  getCreditSettlement: (billId) => ipcRenderer.invoke('database:get-credit-settlement', billId),
  getSaleReturnsForReports: () => ipcRenderer.invoke('database:get-sale-returns-for-reports'),
  getSalesHistory: () => ipcRenderer.invoke('database:get-sales-history'),
  getFinancialSyncOperations: () => ipcRenderer.invoke('database:get-financial-sync-operations'),
  getFinancialIntegritySnapshot: () => ipcRenderer.invoke('database:get-financial-integrity-snapshot'),
  getUnsyncedFinancialSyncOperations: () => ipcRenderer.invoke('database:get-unsynced-financial-sync-operations'),
  markFinancialSyncAttempt: (billId, error) => ipcRenderer.invoke('database:mark-financial-sync-attempt', { billId, error }),
  markFinancialSyncConfirmed: (billId, cloudSaleId) => ipcRenderer.invoke('database:mark-financial-sync-confirmed', { billId, cloudSaleId }),
  // Administrative clears used by Clear Sales History / Reset / Factory Reset / Restore.
  adminClearLocalSalesHistory: () => ipcRenderer.invoke('database:admin-clear-sales-history'),
  adminClearLocalSalesAndLedger: () => ipcRenderer.invoke('database:admin-clear-sales-and-ledger'),
  adminClearLocalInventoryLedger: () => ipcRenderer.invoke('database:admin-clear-inventory-ledger'),
  // Flush pending localStorage writes to disk (used only after destructive admin operations).
  flushLocalStorageToDisk: () => ipcRenderer.invoke('storage:flush-local-storage'),
  showAlert: (message) => ipcRenderer.invoke('show-alert', message),
  showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),
  refocusWindow: () => ipcRenderer.send('refocus-main-window'),
  // Silent GDrive backup: saves JSON file to disk without any file picker dialog
  saveGDriveBackup: (jsonStr, fileName) => ipcRenderer.invoke('save-gdrive-backup', jsonStr, fileName),
  // Google Drive via net module (bypasses CORS — runs in main process)
  gdriveUpload: (scriptUrl, payload) => ipcRenderer.invoke('gdrive-upload', { scriptUrl, payload }),
  gdriveFetch: (url) => ipcRenderer.invoke('gdrive-fetch', { url }),
  // Silent print: sends receipt HTML straight to the default (system) printer, no dialog
  silentPrint: (html) => ipcRenderer.invoke('silent-print', html),
  // Google OAuth sign-in for Backup & Restore → Google Drive (real account sign-in)
  googleOAuthSignIn: () => ipcRenderer.invoke('google-oauth-signin'),
  googleOAuthRefresh: () => ipcRenderer.invoke('google-oauth-refresh'),
  googleOAuthSignOut: () => ipcRenderer.invoke('google-oauth-signout'),
  googleOAuthStatus: () => ipcRenderer.invoke('google-oauth-status'),
  // Telegram bot integration — the bot now ships inside the app and is run by the main
  // process as a managed child process (see electron/main.js). These calls read/write only
  // the non-secret scheduling fields, and read its notification log for display in the
  // in-app Notification Center. The bot token itself is never exposed to the renderer.
  getTelegramBotSettings: () => ipcRenderer.invoke('telegram-bot-get-settings'),
  saveTelegramBotSettings: (settings) => ipcRenderer.invoke('telegram-bot-save-settings', settings),
  getTelegramBotNotifications: (limit) => ipcRenderer.invoke('telegram-bot-get-notifications', limit),
  // Relays the Pharmacy app's current Supabase session token to the embedded bot process, so
  // it can authenticate to the secure telegram-relay Edge Function (which holds the real bot
  // token server-side) as a genuine signed-in instance of this app — no bot token is ever
  // stored locally. Called from vhc-cloud-sync.js's syncRealtimeAuth, the same single choke
  // point already used to keep the realtime connection's auth in sync.
  setSupabaseSessionToken: (token) => ipcRenderer.send('supabase-session-token-changed', token),
  // Real, live bot service status (replaces the old hardcoded "Active" indicator).
  getTelegramBotStatus: () => ipcRenderer.invoke('telegram-bot-get-status'),
  onTelegramBotStatusChanged: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('telegram-bot-status-changed', handler);
    return () => ipcRenderer.removeListener('telegram-bot-status-changed', handler);
  },
  // Fired when the tray's "Settings" menu item is clicked, so the renderer can navigate
  // there if it chooses to listen — the window is already brought to the front either way.
  onOpenSettingsPage: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings-page', handler);
    return () => ipcRenderer.removeListener('open-settings-page', handler);
  }
});
