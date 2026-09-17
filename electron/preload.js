const { contextBridge, ipcRenderer } = require('electron');

// Override native alert and confirm to use IPC to the main process
// This prevents the renderer from losing focus when these dialogs close
contextBridge.exposeInMainWorld('electronAPI', {
  // Single source of truth for the version shown in the UI — reads directly
  // from the packaged app's package.json via Electron's own app.getVersion(),
  // instead of a hand-maintained string that can (and did) drift out of sync.
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
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
  },
  // Local SQLite foundation (Phase 2A) — a development-safe health check only. No raw SQL
  // execution is ever exposed here; both calls just return the fixed, named status fields
  // computed in electron/database.js. Nothing in the app reads/writes through this yet.
  getDatabaseStatus: () => ipcRenderer.invoke('database:get-status'),
  getDatabaseSchemaVersion: () => ipcRenderer.invoke('database:get-schema-version'),
  // Local-first billing (Phase 2C) — the main process validates and executes the atomic
  // SQLite sale transaction; the renderer only ever sees the structured result, never the
  // database itself. createLocalSale/cancelLocalSale are the sole write paths; no generic
  // SQL execution is exposed here or ever will be.
  createLocalSale: (payload) => ipcRenderer.invoke('database:create-local-sale', payload),
  cancelLocalSale: (billId) => ipcRenderer.invoke('database:cancel-local-sale', billId),
  getLocalSale: (billId) => ipcRenderer.invoke('database:get-local-sale', billId),
  // Credit repayments (Phase 2F Step 2) — structured results only, no raw SQL.
  recordCreditRepayment: (payload) => ipcRenderer.invoke('database:record-credit-repayment', payload),
  getCreditRepayments: (billId) => ipcRenderer.invoke('database:get-credit-repayments', billId),
  getCreditSettlement: (billId) => ipcRenderer.invoke('database:get-credit-settlement', billId),
  // Sales history / summary reads (Phase 2F Step 3) — structured bill-record objects only.
  getSalesHistory: () => ipcRenderer.invoke('database:get-sales-history'),
  getSalesSummary: () => ipcRenderer.invoke('database:get-sales-summary'),
  // Offline→online sync (Phase 2D) — read-only aggregate status only, never the queue's raw
  // rows. triggerSyncNow is exposed for a possible future manual "Sync Now" action; nothing in
  // the current UI calls it yet.
  getSyncStatus: () => ipcRenderer.invoke('database:get-sync-status'),
  triggerSyncNow: () => ipcRenderer.invoke('sync:trigger-now'),
});
