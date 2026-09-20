import { app, BrowserWindow, shell, nativeImage, ipcMain, dialog, net, safeStorage, Tray, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, fork } from 'child_process';
import http from 'http';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let backendProcess = null;

// ─── Single-instance lock ───
// A second launch (double-clicking the shortcut/desktop icon again, opening from Start Menu
// twice, etc.) must not spawn a second window or a second Telegram bot child process — it
// should just bring the existing window forward. This must run before any other startup work.
// The lock is scoped to the userData path, so a test launch must apply VHC_TEST_USERDATA first
// or it would collide with (and signal) a real running instance. Unset for normal users.
if (process.env.VHC_TEST_USERDATA) {
  try { app.setPath('userData', process.env.VHC_TEST_USERDATA); } catch (e) {}
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  showMainWindow();
});

// ─── Shared production data directory ───
// C:\VHC_Pharmacy_Data holds all writable runtime state (backups, ledger, Telegram config/
// logs, etc.). On a fresh install it has never been created — nothing else in the app should
// be relied on to create it as a side effect (previously only a Google Drive backup did, via
// its own mkdirSync, which left Telegram's config/log files silently unable to be created on
// a machine where no backup had ever run yet). Ensuring it exists here, before any other
// startup work, is what makes Telegram config loading and logging actually work on a fresh PC.
// VHC_TEST_DATA_DIR mirrors VHC_TEST_USERDATA / VHC_TEST_BACKUP_DIR: lets a dev/test launch
// point at an isolated folder to verify fresh-install behavior without touching the real
// shared one. Unset for all normal users/installs — behavior is unchanged.
const VHC_DATA_DIR = process.env.VHC_TEST_DATA_DIR || 'C:\\VHC_Pharmacy_Data';
function ensureDataDir() {
  try {
    if (!fs.existsSync(VHC_DATA_DIR)) fs.mkdirSync(VHC_DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('Failed to create data directory ' + VHC_DATA_DIR + ':', e.message);
    return false;
  }
}
ensureDataDir();

// ─── Google OAuth (Backup & Restore → Google Drive real sign-in) ───
// Desktop-app OAuth client. Client secret is not a true secret for installed apps (per
// Google/RFC 8252 guidance) but is still kept server-side (main process) rather than in the
// renderer bundle.
const GOOGLE_OAUTH_CLIENT_ID = '193589136107-ijhf2q3mdrsbuaobvb7jg33vb8ooc3cv.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_SECRET = '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';
const GOOGLE_OAUTH_SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email';
let oauthSignInServer = null;

// Fix Windows Program Files / Portable permission issues (Access Denied 0x5 GPU cache errors)
try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // VHC_TEST_USERDATA lets a dev/test launch use an isolated data folder instead of the
  // real production one. Unset for all normal users/installs — behavior is unchanged.
  app.setPath('userData', process.env.VHC_TEST_USERDATA || path.join(app.getPath('appData'), 'vhc-pharmacy-pos'));
} catch (e) {}

function checkPort8001(callback) {
  const req = http.get('http://localhost:8001/api/inventory', (res) => {
    callback(true);
  });
  req.on('error', () => {
    callback(false);
  });
  req.end();
}

function launchBackend() {
  // Standalone mode: FastPOS Server Control popup GUI window disabled/removed for clean startup
  console.log('Running in clean native desktop mode without popup control window.');
}

// Force re-enable and re-focus the main window (safe to call multiple times)
// Pass restoreIfMinimized=true only when you explicitly want to un-minimize
function forceRestoreMainWindow(restoreIfMinimized = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setEnabled(true);
    // Only un-minimize if the caller explicitly asks for it (e.g. after a dialog)
    // Never auto-restore on blur — that would fight the user's minimize action
    if (restoreIfMinimized && mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isMinimized()) mainWindow.focus();
    // Also tell the renderer to unlock pointer events
    try {
      mainWindow.webContents.executeJavaScript(`
        document.body.style.pointerEvents = 'auto';
        document.body.style.userSelect = 'auto';
      `).catch(() => {});
    } catch(e) {}
  }
}

// Brings the main window to the foreground, recreating it if it was ever fully destroyed
// (normally it's only ever hidden, never destroyed, while the app is running — see the
// close handler below — but this is a safe fallback for the tray/second-instance code paths).
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const logoIconPath = path.join(__dirname, 'icon.ico');
  const appIcon = nativeImage.createFromPath(logoIconPath);
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: 'VHC Pharmacy-POS',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: preloadPath
    }
  });

  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);

  const indexPath = path.join(__dirname, '../dist/index.html');
  mainWindow.loadFile(indexPath).catch(err => {
    console.error('Error loading dist/index.html:', err);
    mainWindow.loadURL('http://localhost:8001/');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('localhost:8001') || url.includes('127.0.0.1:8001')) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // When main window regains focus, unlock pointer events
  mainWindow.on('focus', () => {
    forceRestoreMainWindow();
  });

  // When main window loses focus (e.g. a dialog opens), re-enable pointer events
  // but do NOT restore the window — this would undo the user's minimize action
  mainWindow.on('blur', () => {
    setTimeout(() => forceRestoreMainWindow(false), 500);
  });

  // After any page finishes loading (e.g. after navigation), ensure enabled
  mainWindow.webContents.on('did-finish-load', () => {
    forceRestoreMainWindow();
    // The renderer just (re)loaded — push it the bot status we already know about so the
    // sidebar/Settings UI don't show a stale/default state until the next change event.
    try { mainWindow.webContents.send('telegram-bot-status-changed', telegramBotStatus); } catch (e) {}
  });

  // When the print dialog completes (user cancels or finishes printing)
  mainWindow.webContents.on('did-print', () => {
    setTimeout(() => forceRestoreMainWindow(), 200);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const logLine = `[CONSOLE ${level}] ${message} (at ${sourceId}:${line})\n`;
    try { fs.appendFileSync('C:\\New VHC\\app_runtime_error.log', logLine); } catch(e) {}
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    const logLine = `[FAIL LOAD ${errorCode}] ${errorDescription} - URL: ${validatedURL}\n`;
    try { fs.appendFileSync('C:\\New VHC\\app_runtime_error.log', logLine); } catch(e) {}
  });

  // Closing the window (the X button) hides it instead of quitting the app — the Telegram
  // service and the app itself keep running in the system tray. Only the tray's explicit
  // "Exit / Quit" (which sets isQuitting first) lets a close actually go through.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('get-app-version', () => app.getVersion());

// ─── IPC Handlers for safe dialog usage ───
ipcMain.handle('show-alert', async (event, message) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'VHC Pharmacy POS',
    message: String(message)
  });
  // After a dialog closes, restore the window if it got minimized during the dialog
  forceRestoreMainWindow(true);
});

ipcMain.handle('show-confirm', async (event, message) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', 'Confirm'],
    defaultId: 1,
    title: 'Confirm Action',
    message: String(message)
  });
  // After a dialog closes, restore the window if it got minimized during the dialog
  forceRestoreMainWindow(true);
  return result.response === 1;
});

ipcMain.on('refocus-main-window', () => {
  // Explicit refocus request from renderer — restore if minimized
  forceRestoreMainWindow(true);
});

// ─── Silent Google Drive Backup (no file picker dialog) ───
ipcMain.handle('save-gdrive-backup', async (event, jsonStr, fileName) => {
  try {
    // VHC_TEST_BACKUP_DIR mirrors VHC_TEST_USERDATA: lets a dev/test launch redirect backups
    // to an isolated folder instead of the real shared one. Unset for all normal users/installs.
    const backupDir = process.env.VHC_TEST_BACKUP_DIR || 'C:\\VHC_Pharmacy_Data\\gdrive_backups';
    // Create directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const filePath = path.join(backupDir, fileName);
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    // Keep only the last 5 backup files in this folder to avoid clutter. In practice the
    // auto-backup always writes the same fileName (VHC_POS_AutoBackup.json) and simply
    // overwrites in place, so this rotation is a safety net rather than a normal path.
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 5) {
      files.slice(5).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f.name)); } catch(e) {}
      });
    }
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── Google Drive IPC via net module (bypasses CORS) ───
ipcMain.handle('gdrive-upload', (event, { scriptUrl, payload }) => {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'POST', url: scriptUrl, redirect: 'follow' });
      req.setHeader('Content-Type', 'text/plain');
      let data = '';
      req.on('response', (res) => {
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { resolve({ success: false, error: 'Bad response: ' + data.substring(0, 120) }); }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.write(JSON.stringify(payload));
      req.end();
    } catch(e) { resolve({ success: false, error: e.message }); }
  });
});

ipcMain.handle('gdrive-fetch', (event, { url }) => {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'GET', url, redirect: 'follow' });
      let data = '';
      req.on('response', (res) => {
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { resolve({ success: false, error: 'Bad response: ' + data.substring(0, 120) }); }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.end();
    } catch(e) { resolve({ success: false, error: e.message }); }
  });
});

// ─── Google OAuth sign-in (loopback flow — RFC 8252) ───
function getOAuthTokenFilePath() {
  return path.join(app.getPath('userData'), 'gdrive_oauth_token.enc');
}
function getOAuthMetaFilePath() {
  return path.join(app.getPath('userData'), 'gdrive_oauth_meta.json');
}

ipcMain.handle('google-oauth-status', async () => {
  try {
    if (!fs.existsSync(getOAuthMetaFilePath()) || !fs.existsSync(getOAuthTokenFilePath())) {
      return { signedIn: false };
    }
    const meta = JSON.parse(fs.readFileSync(getOAuthMetaFilePath(), 'utf8'));
    return { signedIn: !!meta.email, email: meta.email || null };
  } catch (e) {
    return { signedIn: false };
  }
});

ipcMain.handle('google-oauth-signin', async () => {
  if (oauthSignInServer) {
    try { oauthSignInServer.close(); } catch (e) {}
    oauthSignInServer = null;
  }
  return new Promise((resolve) => {
    let redirectUri = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };
    const timeoutHandle = setTimeout(() => {
      if (oauthSignInServer) { try { oauthSignInServer.close(); } catch (e) {} oauthSignInServer = null; }
      finish({ success: false, error: 'Sign-in timed out. Please try again.' });
    }, 120000);

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const errorParam = reqUrl.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px;">' +
          '<h2>' + (code ? '✅ Signed in! You can close this tab.' : '❌ Sign-in failed or was cancelled.') + '</h2>' +
          '</body></html>'
        );
        try { server.close(); } catch (e) {}
        oauthSignInServer = null;

        if (errorParam || !code) {
          finish({ success: false, error: errorParam || 'No authorization code received' });
          return;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_OAUTH_CLIENT_ID,
            client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          }).toString()
        });
        const tokenJson = await tokenRes.json();
        if (!tokenJson.access_token) {
          finish({ success: false, error: tokenJson.error_description || tokenJson.error || 'Token exchange failed' });
          return;
        }

        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + tokenJson.access_token }
        });
        const userJson = await userRes.json();
        const email = userJson.email || 'Unknown';

        if (tokenJson.refresh_token) {
          try {
            const canEncrypt = safeStorage.isEncryptionAvailable();
            const tokenBuffer = canEncrypt
              ? safeStorage.encryptString(tokenJson.refresh_token)
              : Buffer.from(tokenJson.refresh_token, 'utf8');
            fs.writeFileSync(getOAuthTokenFilePath(), tokenBuffer);
          } catch (e) {}
        }
        fs.writeFileSync(getOAuthMetaFilePath(), JSON.stringify({ email }));

        finish({ success: true, email, accessToken: tokenJson.access_token, expiresIn: tokenJson.expires_in });
      } catch (e) {
        finish({ success: false, error: e.message });
      }
    });

    oauthSignInServer = server;
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_OAUTH_SCOPES,
        access_type: 'offline',
        prompt: 'consent'
      }).toString();
      shell.openExternal(authUrl);
    });
    server.on('error', (e) => finish({ success: false, error: e.message }));
  });
});

ipcMain.handle('google-oauth-refresh', async () => {
  try {
    if (!fs.existsSync(getOAuthTokenFilePath())) return { success: false, error: 'Not signed in' };
    const tokenBuffer = fs.readFileSync(getOAuthTokenFilePath());
    const refreshToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(tokenBuffer)
      : tokenBuffer.toString('utf8');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        grant_type: 'refresh_token'
      }).toString()
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      return { success: false, error: tokenJson.error_description || tokenJson.error || 'Refresh failed' };
    }
    return { success: true, accessToken: tokenJson.access_token, expiresIn: tokenJson.expires_in };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('google-oauth-signout', async () => {
  try {
    if (fs.existsSync(getOAuthTokenFilePath())) fs.unlinkSync(getOAuthTokenFilePath());
    if (fs.existsSync(getOAuthMetaFilePath())) fs.unlinkSync(getOAuthMetaFilePath());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── Telegram bot integration ───
// The bot (unpacked_app/telegram-bot/bot.js) ships INSIDE the app package and is started
// automatically as a managed child process — see startTelegramBot() in the app.whenReady()
// block below. This section still exposes the same Settings/Notification-Center IPC surface
// as before (reads/writes only the non-secret scheduling fields of the bot's config; the bot
// token and allowedUserIds are never sent to the renderer), plus a new live-status channel.
//
// Config now lives at C:\VHC_Pharmacy_Data\telegram_config.json (shared, writable, resolves
// correctly regardless of install location) rather than next to the old standalone script —
// see unpacked_app/telegram-bot/lib/config.js for the matching default on the bot's side.
const TELEGRAM_BOT_CONFIG_PATH = process.env.VHC_TELEGRAM_CONFIG_PATH || (VHC_DATA_DIR + '\\telegram_config.json');

function readTelegramBotConfig() {
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_BOT_CONFIG_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Same built-in defaults telegram-bot/lib/config.js falls back to — kept in sync manually
// (small, stable list; see that file's comment for why no bot token is among them). Used
// here only to (a) auto-provision the on-disk file so the Settings screen has something
// concrete to display/edit, and (b) fill in any fields an existing file doesn't specify yet.
// No secret involved: the real bot token is never local at all — see lib/telegram.js.
const TELEGRAM_CONFIG_DEFAULTS = {
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

// Reads the config for display/editing in Settings, auto-provisioning it from the defaults
// above on a fresh PC where it doesn't exist yet. This never gates whether the bot starts —
// see startTelegramBot() below, which no longer depends on any local file at all.
function readOrProvisionTelegramConfig() {
  const onDisk = readTelegramBotConfig();
  if (onDisk) return { ...TELEGRAM_CONFIG_DEFAULTS, ...onDisk };
  const cfg = { ...TELEGRAM_CONFIG_DEFAULTS };
  try {
    ensureDataDir();
    fs.writeFileSync(TELEGRAM_BOT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to auto-provision telegram_config.json:', e.message);
  }
  return cfg;
}

ipcMain.handle('telegram-bot-get-settings', async () => {
  const cfg = readOrProvisionTelegramConfig();
  return {
    available: true,
    autoReportEnabled: cfg.autoReportEnabled !== false,
    reportTimes: Array.isArray(cfg.reportTimes) ? cfg.reportTimes : [],
    channelConfigured: !!cfg.channelChatId,
    authorizedUserCount: Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds.length : 0
  };
});

ipcMain.handle('telegram-bot-save-settings', async (event, settings) => {
  try {
    const cfg = readOrProvisionTelegramConfig();
    if (settings && typeof settings.autoReportEnabled === 'boolean') {
      cfg.autoReportEnabled = settings.autoReportEnabled;
    }
    if (settings && Array.isArray(settings.reportTimes)) {
      // Only accept well-formed 24-hour "HH:MM" strings — defensive, since the bot (a
      // separate process) parses and trusts this file without further validation.
      cfg.reportTimes = settings.reportTimes.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    }
    fs.writeFileSync(TELEGRAM_BOT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    // No restart needed: the running bot child process re-reads this file every poll cycle
    // (a few seconds), so the change takes effect on its own shortly.
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('telegram-bot-get-notifications', async (event, limit) => {
  try {
    const cfg = readTelegramBotConfig();
    if (!cfg) return { available: false, notifications: [] };
    const logFile = cfg.notificationLogFile || 'C:\\VHC_Pharmacy_Data\\telegram_notifications.json';
    if (!fs.existsSync(logFile)) return { available: true, notifications: [] };
    const all = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const list = Array.isArray(all) ? all : [];
    const sliced = (typeof limit === 'number' && limit > 0) ? list.slice(-limit) : list;
    return { available: true, notifications: sliced.slice().reverse() };
  } catch (e) {
    return { available: false, notifications: [], error: e.message };
  }
});

// ─── Telegram bot child-process lifecycle (embedded service) ───
let botProcess = null;
let botRestartTimer = null;
let botRestartDelayMs = 3000; // exponential backoff on repeated crashes, capped at 60s below
let isQuitting = false;
let tray = null;

// The Pharmacy app's current Supabase session token, relayed to the bot child process (see
// startTelegramBot() and the 'supabase-session-token-changed' IPC below) so it can
// authenticate to the telegram-relay Edge Function as "a genuine signed-in instance of this
// app" — this is what replaces a locally-stored bot token entirely. Set by the renderer via
// vhc-cloud-sync.js's syncRealtimeAuth, which already fires on every sign-in/session refresh.
// VHC_TEST_SUPABASE_TOKEN lets a dev/test launch simulate an already-signed-in session
// (e.g. to exercise the bot's relay auth path without a real interactive sign-in), mirroring
// the other VHC_TEST_* overrides. Unset for all normal users/installs — behavior unchanged.
let currentSupabaseToken = process.env.VHC_TEST_SUPABASE_TOKEN || null;
// True only once the current bot child has confirmed (via 'vhc-bot-ready') that its IPC
// message listener is actually attached — sending before that is a real, observed race (the
// child takes real time to require() its modules before reaching that line; Node does not
// replay 'message' events for listeners attached after they arrived, so an eager send is
// silently lost, not just delayed).
let botReady = false;
ipcMain.on('supabase-session-token-changed', (event, token) => {
  currentSupabaseToken = token || null;
  if (botProcess && botReady) {
    try { botProcess.send({ channel: 'vhc-supabase-token', token: currentSupabaseToken }); } catch (e) {}
  }
});

// Real, continuously-updated status — replaces the old hardcoded "Active" sidebar badge.
// state: 'starting' | 'running' | 'error' | 'disconnected' | 'stopped'
let telegramBotStatus = {
  state: 'stopped',
  lastPollAt: null,
  lastError: null,
  lastErrorAt: null,
  authorizedUserCount: 0,
  autoReportEnabled: false,
  reportTimes: [],
  channelConfigured: false,
  updatedAt: Date.now(),
};

function getBotScriptPath() {
  // Packaged builds mark telegram-bot/**/* as asarUnpack (see package.json → build.asarUnpack)
  // so at runtime it exists as real files on disk under app.asar.unpacked, not inside the
  // compressed archive — required because this is fork()'d as its own OS process, not just
  // read via Node's fs (which electron patches to be asar-transparent, but a genuinely
  // separate process launch is not, so it must be a real file).
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'telegram-bot', 'bot.js');
  }
  return path.join(__dirname, '..', 'telegram-bot', 'bot.js');
}

function updateTelegramBotStatus(patch) {
  telegramBotStatus = { ...telegramBotStatus, ...patch, updatedAt: Date.now() };
  if (telegramBotStatus.state === 'running') {
    // A confirmed-good poll cycle resets the crash-restart backoff.
    botRestartDelayMs = 3000;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('telegram-bot-status-changed', telegramBotStatus); } catch (e) {}
  }
  rebuildTrayMenu();
}

function startTelegramBot() {
  if (botProcess) return; // already running — guards against duplicate spawns

  // Auto-provision the local (non-secret) config file if this is a fresh PC — purely for
  // Settings-screen display/editing (allowedUserIds, report time, etc.); the bot itself
  // (telegram-bot/lib/config.js) already falls back to the same defaults on its own, so this
  // is not a precondition for starting it. There is nothing left that can make the bot
  // itself unable to start: the real credential lives server-side (see lib/telegram.js), not
  // in any local file, so there is no more "invalid local config" failure mode to gate on.
  readOrProvisionTelegramConfig();

  const scriptPath = getBotScriptPath();
  if (!fs.existsSync(scriptPath)) {
    updateTelegramBotStatus({ state: 'error', lastError: `Bot script not found at ${scriptPath}`, lastErrorAt: Date.now() });
    scheduleTelegramBotRestart();
    return;
  }

  updateTelegramBotStatus({ state: 'starting', lastError: null });

  botReady = false;
  try {
    botProcess = fork(scriptPath, [], {
      cwd: path.dirname(scriptPath),
      silent: true, // pipe child stdout/stderr back to us instead of inheriting the console
    });
  } catch (e) {
    botProcess = null;
    updateTelegramBotStatus({ state: 'error', lastError: e.message, lastErrorAt: Date.now() });
    scheduleTelegramBotRestart();
    return;
  }

  const logToFile = (chunk) => {
    try {
      // Defensive re-check: handles the (rare) case where C:\VHC_Pharmacy_Data was removed
      // after startup. ensureDataDir() already runs once at launch, before this is ever
      // reachable, so this is a safety net, not the primary fix.
      if (!fs.existsSync(VHC_DATA_DIR)) fs.mkdirSync(VHC_DATA_DIR, { recursive: true });
      fs.appendFileSync(VHC_DATA_DIR + '\\telegram_bot_service.log', chunk.toString());
    } catch (e) {
      // Logging must never be able to crash the app — if it fails, the bot and the rest of
      // the app keep running regardless, just without that particular line recorded.
    }
  };
  if (botProcess.stdout) botProcess.stdout.on('data', logToFile);
  if (botProcess.stderr) botProcess.stderr.on('data', logToFile);

  botProcess.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.channel === 'vhc-bot-ready') {
      botReady = true;
      if (currentSupabaseToken) {
        try { botProcess.send({ channel: 'vhc-supabase-token', token: currentSupabaseToken }); } catch (e) {}
      }
      return;
    }
    if (msg.channel !== 'vhc-telegram-status') return;
    const { channel, ...rest } = msg;
    updateTelegramBotStatus(rest);
  });

  botProcess.on('error', (err) => {
    // Failed to even launch (e.g. missing Node/Electron internals) — the 'exit' handler
    // below will also fire and drive the restart, this just records the reason.
    updateTelegramBotStatus({ state: 'error', lastError: err.message, lastErrorAt: Date.now() });
  });

  botProcess.on('exit', (code, signal) => {
    botProcess = null;
    if (isQuitting) {
      updateTelegramBotStatus({ state: 'stopped' });
      return;
    }
    // Any exit while we're not deliberately quitting is treated as a genuine crash —
    // including a "clean" exit 0, since this process is supposed to run forever (an infinite
    // polling loop that reports its own "waiting for sign-in" / "relay error" states rather
    // than ever exiting over a configuration problem — see telegram-bot/bot.js).
    updateTelegramBotStatus({
      state: 'error',
      lastError: `Bot process exited unexpectedly (code ${code}, signal ${signal || 'none'})`,
      lastErrorAt: Date.now(),
    });
    scheduleTelegramBotRestart();
  });
}

function scheduleTelegramBotRestart() {
  if (isQuitting || botRestartTimer) return;
  const delay = botRestartDelayMs;
  botRestartTimer = setTimeout(() => {
    botRestartTimer = null;
    botRestartDelayMs = Math.min(botRestartDelayMs * 2, 60000); // back off further if it keeps crashing
    startTelegramBot();
  }, delay);
}

function stopTelegramBot() {
  if (botRestartTimer) { clearTimeout(botRestartTimer); botRestartTimer = null; }
  botRestartDelayMs = 3000;
  botReady = false;
  if (botProcess) {
    try { botProcess.kill(); } catch (e) {}
    botProcess = null;
  }
  updateTelegramBotStatus({ state: 'stopped' });
}

ipcMain.handle('telegram-bot-get-status', () => telegramBotStatus);

// ─── System tray ───
// Keeps the app reachable (and the bot's status visible) after the window is hidden. Only
// "Exit / Quit" here (or the equivalent OS-level quit) actually ends the process.
function trayStatusLabel(status) {
  const map = {
    starting: '🟡 Starting…',
    running: '🟢 Running',
    error: '🟠 Error — retrying',
    disconnected: '🔴 Disconnected',
    stopped: '⚪ Stopped',
  };
  return map[status.state] || '⚪ Unknown';
}

function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'icon.ico');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('VHC Pharmacy POS');
    tray.on('click', () => showMainWindow());
    rebuildTrayMenu();
  } catch (e) {
    // A missing/unreadable tray icon must never take the whole app down — the window and
    // Telegram service keep working, just without a tray icon to reach them when hidden.
    console.error('Failed to create system tray icon:', e.message);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open VHC Pharmacy', click: () => showMainWindow() },
    { label: `Telegram: ${trayStatusLabel(telegramBotStatus)}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings', click: () => { showMainWindow(); if (mainWindow) mainWindow.webContents.send('open-settings-page'); } },
    { type: 'separator' },
    { label: 'Exit / Quit', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

function quitApp() {
  isQuitting = true; // stops the close handler from fighting this while app.quit() is pending
  app.quit();
}

// ─── Silent print: sends receipt HTML straight to the OS default printer, no dialog ───
ipcMain.handle('silent-print', async (event, htmlContent) => {
  return new Promise((resolve) => {
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true }
    });
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: 80mm auto; margin: 4mm; }
      body { font-family: 'Courier New', Courier, monospace; font-size: 12px; line-height: 1.4; color: #000000; margin: 0; padding: 0; background: #ffffff; }
      .receipt-paper { width: 300px; padding: 6px; box-sizing: border-box; }
      img { max-height: 55px; width: auto; display: block; margin: 0 auto 5px auto; }
      div { box-sizing: border-box; }
    </style></head><body><div class="receipt-paper">${htmlContent}</div></body></html>`;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (!printWin.isDestroyed()) printWin.destroy();
      resolve(result);
    };

    printWin.webContents.on('did-finish-load', () => {
      printWin.webContents.print({ silent: true, printBackground: true }, (success, reason) => {
        finish(success ? { success: true } : { success: false, error: reason });
      });
    });
    printWin.webContents.on('did-fail-load', (e, code, desc) => {
      finish({ success: false, error: desc || `Failed to load receipt (code ${code})` });
    });

    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml));

    // Safety timeout in case the printer driver hangs
    setTimeout(() => finish({ success: false, error: 'Print timed out' }), 20000);
  });
});

// ─── Local SQLite database (vhc_pharmacy.db, in VHC's own userData) ───
// Loaded through a dynamic import inside try/catch so that ANY failure (native module missing
// or ABI mismatch, corrupt file, locked file, read-only disk) leaves the app fully usable on
// its existing localStorage/cloud paths — the renderer treats `unavailable` as "no local DB".
let localDb = null;
let localDbInitError = null;
let localDbReady = null;
function initLocalDatabase() {
  if (localDbReady) return localDbReady;
  localDbReady = (async () => {
    try {
      const mod = await import('./database.js');
      mod.initDatabase(path.join(app.getPath('userData'), 'vhc_pharmacy.db'));
      localDb = mod;
    } catch (e) {
      localDb = null;
      localDbInitError = e && e.message ? e.message : String(e);
      console.error('[LocalDB] initialization failed — continuing without the local database:', localDbInitError);
    }
    return localDb;
  })();
  return localDbReady;
}
const DB_UNAVAILABLE = () => ({ success: false, unavailable: true, error: localDbInitError || 'Local database is unavailable' });

ipcMain.handle('database:get-status', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return { exists: false, opened: false, error: localDbInitError };
  try { return mod.getDatabaseStatus(); } catch (e) { return { exists: false, opened: false, error: e.message }; }
});
ipcMain.handle('database:get-schema-version', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return null;
  try { return mod.getSchemaVersion(); } catch (e) { return null; }
});

// Local-first billing. These only ever touch vhc_pharmacy.db — nothing here talks to Supabase or
// changes cloud stock (the renderer's existing bulkUpdateInventory path remains its sole owner).
ipcMain.handle('database:create-local-sale', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.createLocalSale(payload); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:cancel-local-sale', async (event, billId) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.cancelLocalSale(billId); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:get-local-sale', async (event, billId) => {
  const mod = await initLocalDatabase();
  if (!mod) return null;
  try { return mod.getLocalSaleByBillId(billId); } catch (e) { return null; }
});

// Credit repayments and history reads (local SQLite only).
ipcMain.handle('database:record-credit-repayment', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.recordCreditRepayment(payload || {}); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:get-credit-repayments', async (event, billId) => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getCreditRepaymentsByBillId(billId); } catch (e) { return []; }
});
ipcMain.handle('database:get-credit-settlement', async (event, billId) => {
  const mod = await initLocalDatabase();
  if (!mod) return null;
  try { return mod.getCreditSettlementByBillId(billId); } catch (e) { return null; }
});
ipcMain.handle('database:get-sales-history', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getSalesHistory(); } catch (e) { console.error('[LocalDB] getSalesHistory failed:', e.message); return []; }
});

// Administrative clears. Each is one explicit, transactional database operation (no SQL from the
// renderer). When the database could not be opened, the reply says whether a database FILE exists
// on disk: no file means there is no SQLite layer to conflict with; an existing file that cannot be
// opened means the caller must not report a clean clear.
const ADMIN_DB_UNAVAILABLE = () => {
  let dbFileExists = false;
  try { dbFileExists = fs.existsSync(path.join(app.getPath('userData'), 'vhc_pharmacy.db')); } catch (e) {}
  return { success: false, unavailable: true, dbFileExists, error: localDbInitError || 'Local database is unavailable' };
};
ipcMain.handle('database:admin-clear-sales-history', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return ADMIN_DB_UNAVAILABLE();
  try { return mod.clearSalesHistoryData(); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:admin-clear-inventory-ledger', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return ADMIN_DB_UNAVAILABLE();
  try { return mod.clearInventoryLedgerData(); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:admin-clear-sales-and-ledger', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return ADMIN_DB_UNAVAILABLE();
  try { return mod.clearSalesAndInventoryLedgerData(); } catch (e) { return { success: false, error: e.message }; }
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.vhc.pharmacypos');
  }

  initLocalDatabase();

  // Any child window (print dialogs, about:blank popups, etc.) — restore focus when it closes
  app.on('browser-window-created', (event, createdWindow) => {
    if (mainWindow && createdWindow !== mainWindow) {
      createdWindow.on('closed', () => {
        setTimeout(() => forceRestoreMainWindow(), 200);
      });
    }
  });

  checkPort8001((isRunning) => {
    if (!isRunning) {
      launchBackend();
    }
    createWindow();
  });

  createTray();
  startTelegramBot();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

// The window is only ever hidden (see the 'close' handler in createWindow), never destroyed
// while the app is running, so this normally won't fire during ordinary use — kept as a
// no-op so a future code path that DOES destroy every window can't accidentally quit the app
// out from under the tray/Telegram service. Only quitApp() (Exit/Quit) or an OS-level quit
// signal (handled by 'before-quit' below) end the process.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  stopTelegramBot();
  try { if (localDb) localDb.closeDatabase(); } catch (e) {}
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
});
