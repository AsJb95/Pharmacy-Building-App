import { app, BrowserWindow, shell, nativeImage, ipcMain, dialog, net, safeStorage, Tray, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, fork } from 'child_process';
import http from 'http';
import fs from 'fs';
import { initDatabase, getDatabaseStatus, getSchemaVersion, closeDatabase, createLocalSale, cancelLocalSale, getLocalSaleByBillId, getSyncStatus, recordCreditRepayment, getCreditRepaymentsByBillId, getCreditSettlementByBillId, getSalesHistory, getSalesSummary } from './database.js';
import { startSyncEngine, stopSyncEngine, triggerSyncNow } from './sync-engine.js';

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

// ─── NHC production data directory ───
// C:\NHC_Pharmacy_Data holds ALL of NHC's writable runtime state (backups, ledger, Telegram
// config/logs, etc.), completely separate from the VHC Pharmacy POS install's
// C:\VHC_Pharmacy_Data. Every NHC data path is derived from this ONE constant (via
// nhcDataPath below) so a path can never again be left pointing at the VHC folder — a missed
// hardcoded VHC path here previously let NHC's auto-backup overwrite VHC's real backup file.
// VHC_TEST_DATA_DIR lets a dev/test launch point at an isolated folder without touching the
// real one. Unset for all normal users/installs — the paths are then exactly the NHC defaults.
const NHC_DATA_DIR = process.env.VHC_TEST_DATA_DIR || 'C:\\NHC_Pharmacy_Data';
const nhcDataPath = (...parts) => path.join(NHC_DATA_DIR, ...parts);
// NHC must NEVER write into the VHC install's data folder, whatever an env var or a
// renderer-supplied file name says. Checked before any NHC backup write.
const VHC_PROTECTED_DATA_DIR = 'C:\\VHC_Pharmacy_Data';
function isInsideVhcDataDir(p) {
  const resolved = path.resolve(String(p)).toLowerCase();
  const protectedDir = VHC_PROTECTED_DATA_DIR.toLowerCase();
  return resolved === protectedDir || resolved.startsWith(protectedDir + '\\');
}
function ensureDataDir() {
  try {
    if (!fs.existsSync(NHC_DATA_DIR)) fs.mkdirSync(NHC_DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('Failed to create data directory ' + NHC_DATA_DIR + ':', e.message);
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
// Minimum scope needed: drive.file grants access ONLY to files/folders THIS app creates
// (so the app owns its "NHC Pharmacy Backup" tree and never sees the rest of the user's Drive),
// plus userinfo.email to show the connected account. drive.file is NOT a Google "restricted"
// scope, so it needs no security-assessment verification for production — unlike full `auth/drive`.
// NOTE: a user who previously consented to full `auth/drive` keeps a refresh token that still
// works (full drive is a superset); only NEW sign-ins get the narrower drive.file. If a Drive
// call ever returns 403 insufficientScopes, the renderer surfaces a clear "reconnect" message.
const GOOGLE_OAUTH_SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
let oauthSignInServer = null;

// Fix Windows Program Files / Portable permission issues (Access Denied 0x5 GPU cache errors)
try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // VHC_TEST_USERDATA lets a dev/test launch use an isolated data folder instead of the
  // real production one. Unset for all normal users/installs — behavior is unchanged.
  app.setPath('userData', process.env.VHC_TEST_USERDATA || path.join(app.getPath('appData'), 'nhc-pharmacy-pos'));
} catch (e) {}

// ─── Local SQLite foundation (Phase 2A) ───
// Nothing in the existing app reads or writes through this yet — Supabase remains the source
// of truth for every pharmacy feature exactly as before. This must never be able to block or
// break app startup: if it fails for any reason, the rest of the app must start and behave
// exactly as it did before this module existed.
try {
  initDatabase(path.join(app.getPath('userData'), 'nhc_pharmacy.db'));
} catch (e) {
  console.error('SQLite foundation failed to initialize (non-fatal — no feature depends on it yet):', e.message);
}

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
    title: 'NHC Pharmacy-POS',
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

// ─── Local database health check (Phase 2A) ───
// Deliberately narrow, named operations only — never a generic executeSQL/query passthrough.
// Returns only the safe status fields from database.js; the raw connection never leaves that
// module. See database.js's getDatabaseStatus() for exactly what each field means.
ipcMain.handle('database:get-status', () => getDatabaseStatus());
ipcMain.handle('database:get-schema-version', () => getSchemaVersion());

// ─── Local-first billing (Phase 2C) ───
// The renderer sends the same bill data it already assembled for the existing localStorage/
// Supabase paths (see index-doBKNLAj.js's checkout flow) — the main process is authoritative:
// createLocalSale() re-validates stock against this database's own numbers before writing
// anything, never trusting whatever quantities the renderer's payload claims (see that
// function's own comment in database.js for the one unavoidable exception — bootstrapping an
// item's very first local stock figure, since no import mechanism exists yet).
ipcMain.handle('database:create-local-sale', (event, payload) => {
  const result = createLocalSale(payload);
  // Best-effort, non-blocking "try to sync right now" instead of waiting for the next timer
  // tick — mirrors the existing cloud record-only mirror call's own "never awaited" pattern
  // (see index-doBKNLAj.js's checkout flow). The IPC response to the renderer is returned
  // immediately either way; a slow or unreachable Supabase can never delay a real sale.
  if (result && result.success) triggerSyncNow().catch(() => {});
  return result;
});
ipcMain.handle('database:cancel-local-sale', (event, billId) => {
  const result = cancelLocalSale(billId);
  if (result && result.success && !result.noop) triggerSyncNow().catch(() => {});
  return result;
});
ipcMain.handle('database:get-local-sale', (event, billId) => getLocalSaleByBillId(billId));

// ─── Credit repayments (Phase 2F Step 2) ───
// recordCreditRepayment() is authoritative and re-validates the amount itself against this
// database's own current outstanding balance — it never trusts whatever the renderer already
// computed. A sale SQLite doesn't know about (an older, pre-local-first-billing bill, or one
// only ever seen via the cloud) is reported back as { success:false, reason:'sale-not-found' },
// not thrown — the renderer falls back to its existing localStorage-only behavior for exactly
// that case, unchanged from before this phase.
ipcMain.handle('database:record-credit-repayment', (event, payload) => recordCreditRepayment(payload));
ipcMain.handle('database:get-credit-repayments', (event, billId) => getCreditRepaymentsByBillId(billId));
ipcMain.handle('database:get-credit-settlement', (event, billId) => getCreditSettlementByBillId(billId));

// ─── Sales history / summary reads (Phase 2F Step 3) ───
// Structured, mapped results only — getSalesHistory() already returns the exact bill-record
// shape the renderer's Reports/Dashboard/Payments/Credit code expects (see that function's own
// comment in database.js), so the renderer never needs to know these rows came from SQLite.
ipcMain.handle('database:get-sales-history', () => getSalesHistory());
ipcMain.handle('database:get-sales-summary', () => getSalesSummary());

// ─── Offline → online synchronization (Phase 2D) ───
// Read-only status for the renderer (pending/processing/synced counts, last error) — never the
// queue's raw rows or payloads. 'sync:trigger-now' exists for tests and for a future manual
// "Sync Now" action; production code never needs to call it directly since the engine already
// runs on its own timer plus the post-sale trigger above.
ipcMain.handle('database:get-sync-status', () => getSyncStatus());
ipcMain.handle('sync:trigger-now', () => triggerSyncNow());

// ─── IPC Handlers for safe dialog usage ───
ipcMain.handle('show-alert', async (event, message) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'NHC Pharmacy POS',
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
    // NHC's local backup mirror lives in NHC's OWN data folder (C:\NHC_Pharmacy_Data\gdrive_backups
    // by default) — never in the VHC install's C:\VHC_Pharmacy_Data. This handler previously
    // hardcoded the VHC folder and overwrote VHC's real backup file. VHC_TEST_BACKUP_DIR lets a
    // dev/test launch redirect backups to an isolated folder. There is deliberately NO fallback
    // to the VHC folder: anything resolving inside it is refused outright.
    const backupDir = process.env.VHC_TEST_BACKUP_DIR || nhcDataPath('gdrive_backups');
    // Reject path components and non-NHC names supplied by the renderer.
    const safeName = path.basename(String(fileName || ''));
    if (safeName !== String(fileName || '') || !/^NHC_POS_[A-Za-z0-9_-]+\.json$/.test(safeName) || safeName.length > 180) {
      return { success: false, error: 'Invalid backup file name' };
    }
    const filePath = path.join(backupDir, safeName);
    if (isInsideVhcDataDir(backupDir) || isInsideVhcDataDir(filePath)) {
      console.error('Refusing to write an NHC backup into the VHC data folder:', filePath);
      return { success: false, error: 'Refusing to write NHC backups into the VHC data folder' };
    }
    // Create directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    // Keep only the last 5 NHC-named backup files; other applications' files are untouched.
    // In practice the
    // auto-backup always writes the same fileName (NHC_POS_AutoBackup.json) and simply
    // overwrites in place, so this rotation is a safety net rather than a normal path.
    // (It only ever runs inside NHC's own backupDir, checked above.)
    const files = fs.readdirSync(backupDir)
      .filter(f => /^NHC_POS_[A-Za-z0-9_-]+\.json$/.test(f))
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
    // Keep cached folder IDs — Disconnect must NOT delete the Drive folder or local backups; the
    // next connection (same or different account) re-resolves/recreates folders as needed.
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── Google Drive backup (drive.file) — app-owned folder tree, main-process only ───
// All Drive REST happens here with an access token the main process refreshes ITSELF from the
// encrypted refresh token (never handed to the renderer). drive.file means list/search only ever
// returns files/folders THIS app created, so the app can safely find-or-create its own
// "NHC Pharmacy Backup/{Automatic,Manual}" tree without touching the rest of the user's Drive.
const NHC_BACKUP_ROOT_NAME = 'NHC Pharmacy Backup';
const NHC_BACKUP_FILENAME_RE = /^NHC_POS_[A-Za-z0-9_-]+\.json$/; // same identity rule as nhc-backup-policy.js
function getDriveFoldersMetaPath() { return path.join(app.getPath('userData'), 'nhc_drive_folders.json'); }
function readDriveFoldersMeta() {
  try { return JSON.parse(fs.readFileSync(getDriveFoldersMetaPath(), 'utf8')); } catch (e) { return {}; }
}
function writeDriveFoldersMeta(meta) {
  try { fs.writeFileSync(getDriveFoldersMetaPath(), JSON.stringify(meta || {}, null, 2), 'utf8'); } catch (e) {}
}

// Exchanges the stored encrypted refresh token for a fresh access token. Returns
// { ok, accessToken } or { ok:false, error, needReconnect }. needReconnect=true means the grant
// is gone/invalid (revoked, or scope downgrade requires re-consent) and the user must sign in again.
async function getFreshGoogleAccessToken() {
  if (!fs.existsSync(getOAuthTokenFilePath())) return { ok: false, error: 'Not connected to Google Drive', needReconnect: true };
  let refreshToken;
  try {
    const buf = fs.readFileSync(getOAuthTokenFilePath());
    refreshToken = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch (e) { return { ok: false, error: 'Stored Google credential could not be read', needReconnect: true }; }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: GOOGLE_OAUTH_CLIENT_ID, client_secret: GOOGLE_OAUTH_CLIENT_SECRET, grant_type: 'refresh_token' }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) {
      const needReconnect = j.error === 'invalid_grant' || res.status === 400 || res.status === 401;
      return { ok: false, error: j.error_description || j.error || 'Could not refresh Google session', needReconnect };
    }
    return { ok: true, accessToken: j.access_token };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function driveFetch(token, url, options) {
  const res = await fetch(url, { ...(options || {}), headers: { Authorization: `Bearer ${token}`, ...((options && options.headers) || {}) } });
  if (res.status === 403) {
    const t = await res.text().catch(() => '');
    if (/insufficient/i.test(t) || /insufficientScopes/i.test(t)) { const e = new Error('Google Drive permission is out of date — please Disconnect and reconnect Google Drive.'); e.needReconnect = true; throw e; }
    throw new Error(`Google Drive error (403): ${t.slice(0, 200)}`);
  }
  if (res.status === 401) { const e = new Error('Google session expired — please reconnect Google Drive.'); e.needReconnect = true; throw e; }
  return res;
}

// Find a non-trashed app-created folder by name (optionally under a parent), or create it.
async function ensureFolder(token, name, parentId) {
  let q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${name.replace(/'/g, "\\'")}'`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&pageSize=10`;
  const listRes = await driveFetch(token, listUrl);
  const listJson = await listRes.json().catch(() => ({}));
  if (listRes.ok && listJson.files && listJson.files.length) return listJson.files[0].id;
  // Create it
  const meta = { name: name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const createRes = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
  });
  const createJson = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createJson.id) throw new Error('Could not create Drive folder: ' + (createJson.error && createJson.error.message || createRes.status));
  return createJson.id;
}

// Confirm a cached folder id still exists and isn't trashed (fast path), else re-resolve.
async function folderStillValid(token, id) {
  if (!id) return false;
  try {
    const res = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`);
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({}));
    return !!(j && j.id && !j.trashed);
  } catch (e) { return false; }
}

// Find-or-create NHC Pharmacy Backup / Automatic / Manual, reusing cached ids where still valid.
async function ensureBackupFolders(token) {
  const meta = readDriveFoldersMeta();
  let rootId = (await folderStillValid(token, meta.rootId)) ? meta.rootId : await ensureFolder(token, NHC_BACKUP_ROOT_NAME, null);
  let automaticId = (meta.rootId === rootId && await folderStillValid(token, meta.automaticId)) ? meta.automaticId : await ensureFolder(token, 'Automatic', rootId);
  let manualId = (meta.rootId === rootId && await folderStillValid(token, meta.manualId)) ? meta.manualId : await ensureFolder(token, 'Manual', rootId);
  writeDriveFoldersMeta({ rootId, automaticId, manualId });
  return { rootId, automaticId, manualId };
}

ipcMain.handle('drive-status', async () => {
  try {
    if (!fs.existsSync(getOAuthMetaFilePath()) || !fs.existsSync(getOAuthTokenFilePath())) return { signedIn: false };
    const meta = JSON.parse(fs.readFileSync(getOAuthMetaFilePath(), 'utf8'));
    return { signedIn: !!meta.email, email: meta.email || null, rootFolderName: NHC_BACKUP_ROOT_NAME };
  } catch (e) { return { signedIn: false }; }
});

ipcMain.handle('drive-ensure-folders', async () => {
  const tok = await getFreshGoogleAccessToken();
  if (!tok.ok) return { success: false, error: tok.error, needReconnect: !!tok.needReconnect };
  try {
    const folders = await ensureBackupFolders(tok.accessToken);
    return { success: true, folders };
  } catch (e) { return { success: false, error: e.message, needReconnect: !!e.needReconnect }; }
});

// Uploads a backup JSON string into Automatic/ or Manual/. Content is validated for NHC identity
// (namespace/appName) and the filename pattern before any upload, so only genuine NHC backups land.
ipcMain.handle('drive-upload-backup', async (event, payload) => {
  const kind = payload && payload.kind;
  const fileName = payload && payload.fileName;
  const content = payload && payload.content;
  if (kind !== 'Automatic' && kind !== 'Manual') return { success: false, error: 'Invalid backup kind.' };
  if (typeof fileName !== 'string' || !NHC_BACKUP_FILENAME_RE.test(fileName)) return { success: false, error: 'Invalid NHC backup filename.' };
  if (typeof content !== 'string' || content.length === 0) return { success: false, error: 'Empty backup content.' };
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) { return { success: false, error: 'Backup content is not valid JSON.' }; }
  const identOk = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    (parsed.backupNamespace === 'NHC_PHARMACY_POS' || parsed.appName === 'NHC Pharmacy POS');
  if (!identOk) return { success: false, error: 'Refusing to upload: not a recognized NHC backup.' };
  const tok = await getFreshGoogleAccessToken();
  if (!tok.ok) return { success: false, error: tok.error, needReconnect: !!tok.needReconnect };
  try {
    const folders = await ensureBackupFolders(tok.accessToken);
    const parentId = kind === 'Automatic' ? folders.automaticId : folders.manualId;
    const boundary = 'nhcbk' + Date.now();
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + JSON.stringify({ name: fileName, parents: [parentId] })
      + `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + content + `\r\n--${boundary}--`;
    const res = await driveFetch(tok.accessToken, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.id) return { success: false, error: 'Upload failed: ' + (j.error && j.error.message || res.status) };
    return { success: true, file: { id: j.id, name: j.name, modifiedTime: j.modifiedTime, type: kind } };
  } catch (e) { return { success: false, error: e.message, needReconnect: !!e.needReconnect }; }
});

// Lists NHC backups from BOTH Automatic/ and Manual/, newest first, each tagged with its type.
ipcMain.handle('drive-list-backups', async () => {
  const tok = await getFreshGoogleAccessToken();
  if (!tok.ok) return { success: false, error: tok.error, needReconnect: !!tok.needReconnect, files: [] };
  try {
    const folders = await ensureBackupFolders(tok.accessToken);
    const out = [];
    for (const [kind, fid] of [['Automatic', folders.automaticId], ['Manual', folders.manualId]]) {
      const q = `'${fid}' in parents and trashed=false`;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,modifiedTime,size)')}&orderBy=modifiedTime desc&pageSize=100`;
      const res = await driveFetch(tok.accessToken, url);
      const j = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(j.files)) {
        for (const f of j.files) {
          if (NHC_BACKUP_FILENAME_RE.test(f.name || '')) out.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: f.size ? Number(f.size) : null, type: kind });
        }
      }
    }
    out.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
    return { success: true, files: out };
  } catch (e) { return { success: false, error: e.message, needReconnect: !!e.needReconnect, files: [] }; }
});

// Downloads one backup's content, but ONLY if it lives inside our Automatic/ or Manual/ folder and
// has an NHC filename — so a caller can never pull an arbitrary Drive file through this channel.
ipcMain.handle('drive-download-backup', async (event, fileId) => {
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) return { success: false, error: 'Invalid file id.' };
  const tok = await getFreshGoogleAccessToken();
  if (!tok.ok) return { success: false, error: tok.error, needReconnect: !!tok.needReconnect };
  try {
    const folders = await ensureBackupFolders(tok.accessToken);
    const metaRes = await driveFetch(tok.accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,parents,trashed`);
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.id) return { success: false, error: 'Backup not found.' };
    const okParent = Array.isArray(meta.parents) && meta.parents.some((p) => p === folders.automaticId || p === folders.manualId);
    if (meta.trashed || !okParent || !NHC_BACKUP_FILENAME_RE.test(meta.name || '')) return { success: false, error: 'Backup is outside the NHC backup folder or is not a valid NHC backup.' };
    const dlRes = await driveFetch(tok.accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    if (!dlRes.ok) return { success: false, error: 'Could not read the backup content.' };
    const content = await dlRes.text();
    return { success: true, name: meta.name, content };
  } catch (e) { return { success: false, error: e.message, needReconnect: !!e.needReconnect }; }
});


// ─── Telegram bot integration ───
// The bot (unpacked_app/telegram-bot/bot.js) ships INSIDE the app package and is started
// automatically as a managed child process — see startTelegramBot() in the app.whenReady()
// block below. This section still exposes the same Settings/Notification-Center IPC surface
// as before (reads/writes only the non-secret scheduling fields of the bot's config; the bot
// token and allowedUserIds are never sent to the renderer), plus a new live-status channel.
//
// Config lives at C:\NHC_Pharmacy_Data\telegram_config.json — NHC's own data folder
// (NHC_DATA_DIR above; never the VHC install's C:\VHC_Pharmacy_Data) so NHC Telegram
// config/reports never mix with VHC data — resolves correctly regardless of install
// location — see unpacked_app/telegram-bot/lib/config.js for the matching default on the
// bot's side.
const TELEGRAM_BOT_CONFIG_PATH = process.env.VHC_TELEGRAM_CONFIG_PATH || nhcDataPath('telegram_config.json');

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
  dataFile: nhcDataPath('gdrive_backups', 'NHC_POS_AutoBackup.json'),
  ledgerDir: nhcDataPath('ledger'),
  timezone: 'Asia/Kolkata',
  lowStockUnits: 20,
  lowStockStrips: 2,
  nearExpiryDays: 90,
  ledgerPort: 4321,
  allowedUserIds: [733453718, 6995447067],
  autoReportEnabled: true,
  reportTimes: ['21:30'],
  notificationLogFile: nhcDataPath('telegram_notifications.json'),
  schedulerStateFile: nhcDataPath('telegram_scheduler_state.json'),
};

// Reads the config for display/editing in Settings, auto-provisioning it from the defaults
// above on a fresh PC where it doesn't exist yet. This never gates whether the bot starts —
// see startTelegramBot() below, which no longer depends on any local file at all.
function readOrProvisionTelegramConfig() {
  const onDisk = readTelegramBotConfig();
  if (onDisk) return { ...TELEGRAM_CONFIG_DEFAULTS, ...onDisk };
  const cfg = { ...TELEGRAM_CONFIG_DEFAULTS };
  try {
    // TELEGRAM_BOT_CONFIG_PATH normally lives in NHC_DATA_DIR (created at startup by
    // ensureDataDir()), but VHC_TELEGRAM_CONFIG_PATH may point elsewhere, so its folder gets its
    // own defensive creation the first time this ever runs.
    const telegramDataDir = path.dirname(TELEGRAM_BOT_CONFIG_PATH);
    if (!fs.existsSync(telegramDataDir)) fs.mkdirSync(telegramDataDir, { recursive: true });
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
    const logFile = cfg.notificationLogFile || nhcDataPath('telegram_notifications.json');
    if (!fs.existsSync(logFile)) return { available: true, notifications: [] };
    const all = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const list = Array.isArray(all) ? all : [];
    const sliced = (typeof limit === 'number' && limit > 0) ? list.slice(-limit) : list;
    return { available: true, notifications: sliced.slice().reverse() };
  } catch (e) {
    return { available: false, notifications: [], error: e.message };
  }
});

// ─── Server-verified Platform Admin check (defense-in-depth for privileged writes) ───
// Reuses the SAME session the app is already signed in with (currentSupabaseToken, relayed from
// the renderer — see the 'supabase-session-token-changed' IPC below) to read the caller's own
// profiles.is_platform_admin under RLS, exactly like the renderer's window.VHC_CLOUD.isPlatformAdmin().
// This uses ONLY the public anon/publishable key + the user's own JWT — NO service-role key is
// ever introduced. Fails closed: no session, a bad/expired token, an RLS/network error, or a
// non-admin row all return false, so a privileged write is refused rather than allowed by mistake.
const NHC_SUPABASE_URL = 'https://fjtgszdzbiepmdmnjsxn.supabase.co';
const NHC_SUPABASE_ANON_KEY = 'sb_publishable_QG4Nk02c6MAXygDjhhApgg_5RA9V-vt'; // publishable key — not a secret; already embedded in the renderer's Supabase client
function decodeJwtSub(token) {
  try {
    const seg = String(token).split('.')[1];
    if (!seg) return null;
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).sub || null;
  } catch (e) { return null; }
}
async function verifyCurrentUserIsPlatformAdmin() {
  const token = currentSupabaseToken;
  if (!token) return { ok: false, reason: 'no-session' };
  const sub = decodeJwtSub(token);
  if (!sub) return { ok: false, reason: 'bad-token' };
  try {
    const res = await fetch(
      `${NHC_SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(sub)}&select=is_platform_admin`,
      { headers: { apikey: NHC_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const rows = await res.json().catch(() => []);
    const isAdmin = Array.isArray(rows) && rows[0] && rows[0].is_platform_admin === true;
    return { ok: !!isAdmin, reason: isAdmin ? 'admin' : 'not-admin' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Telegram allowed-user management (admin-managed from Settings; no manual JSON editing) ───
// The bot enforces access purely on the numeric `allowedUserIds`. Optional display names are
// stored in a parallel `allowedUserNames` map (id → name), which the bot simply ignores (its
// loadConfig() spreads unknown fields through untouched). Every other telegram_config.json
// field is preserved exactly. The running bot child re-reads the file each poll (~3s), so a
// saved change takes effect within seconds without restarting the app or the bot.
ipcMain.handle('telegram-get-allowed-users', async () => {
  try {
    const cfg = readOrProvisionTelegramConfig();
    const ids = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
    const names = (cfg.allowedUserNames && typeof cfg.allowedUserNames === 'object') ? cfg.allowedUserNames : {};
    return { success: true, users: ids.map((id) => ({ id: String(id), name: names[String(id)] || '' })) };
  } catch (e) {
    return { success: false, error: e.message, users: [] };
  }
});

ipcMain.handle('telegram-save-allowed-users', async (event, users) => {
  try {
    // Defense-in-depth: never trust the renderer alone for a privileged write. Re-verify the
    // caller is a Platform Admin server-side (their own JWT + RLS) before touching the config,
    // so a non-admin renderer (or a tampered call) cannot change who may use the bot.
    const adminCheck = await verifyCurrentUserIsPlatformAdmin();
    if (!adminCheck.ok) {
      logBotService(`Refused telegram-save-allowed-users: caller is not a verified Platform Admin (${adminCheck.reason}).`);
      return { success: false, error: 'Not authorized — Platform Admin sign-in required.' };
    }
    if (!Array.isArray(users)) return { success: false, error: 'Invalid users payload.' };
    // Validate every entry BEFORE writing anything, so a bad entry can never leave the config
    // half-updated. Telegram user IDs are numeric (currently 6–10 digits; allow 5–15 for
    // future-proofing). Duplicates are rejected rather than silently merged.
    const seen = new Set();
    const ids = [];
    const names = {};
    for (const u of users) {
      const raw = String(u && u.id != null ? u.id : '').trim();
      if (!/^\d{5,15}$/.test(raw)) {
        return { success: false, error: `"${raw || '(empty)'}" is not a valid Telegram user ID. IDs are numbers only.` };
      }
      if (seen.has(raw)) return { success: false, error: `Duplicate Telegram user ID: ${raw}.` };
      seen.add(raw);
      ids.push(Number(raw));
      const nm = u && typeof u.name === 'string' ? u.name.trim().slice(0, 60) : '';
      if (nm) names[raw] = nm;
    }
    const cfg = readOrProvisionTelegramConfig();
    cfg.allowedUserIds = ids;      // the ONLY field the bot enforces access on
    cfg.allowedUserNames = names;  // display-only metadata; bot ignores it
    fs.writeFileSync(TELEGRAM_BOT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    logBotService(`Telegram allowed-users updated from Settings: ${ids.length} user(s). The running bot will apply this on its next poll (no restart needed).`);
    return { success: true, count: ids.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Controlled restart of just the bot child process — NOT the whole app. Not required for
// allowed-user changes (those are picked up live), but exposed so Settings can offer an
// explicit "restart bot service" action if a user ever wants to force an immediate reconnect.
ipcMain.handle('telegram-bot-restart', async () => {
  try {
    logBotService('Controlled bot restart requested from Settings.');
    stopTelegramBot();
    startTelegramBot();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
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
  const had = !!currentSupabaseToken;
  currentSupabaseToken = token || null;
  if (botProcess && botReady) {
    try { botProcess.send({ channel: 'vhc-supabase-token', token: currentSupabaseToken }); } catch (e) {}
    logBotService(`Relayed ${currentSupabaseToken ? 'a Supabase session token' : 'a SIGN-OUT (null token)'} to the running bot (renderer sign-in state changed).`);
  } else if (currentSupabaseToken && !had) {
    // Token arrived before the bot child confirmed ready — it will be sent on the 'vhc-bot-ready'
    // handshake instead (see startTelegramBot). Logged so this ordering is visible, not a mystery.
    logBotService('Received a Supabase session token from the renderer, but the bot child is not ready yet — it will be sent as soon as the child signals ready.');
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

// Appends a timestamped main-process diagnostic line to the SAME file the bot child's own
// stdout/stderr is piped into (telegram_bot_service.log), so the whole lifecycle — main process
// deciding to start/stop/restart the bot and relay the session token, plus the bot child's own
// polling/command logs — reads as one ordered timeline. This is what makes "the bot process
// never started" or "the app never relayed a session token" diagnosable from a single file.
function logBotService(line) {
  try {
    if (!fs.existsSync(NHC_DATA_DIR)) fs.mkdirSync(NHC_DATA_DIR, { recursive: true });
    fs.appendFileSync(nhcDataPath('telegram_bot_service.log'), `[${new Date().toISOString()}] [main] ${line}\n`);
  } catch (e) {
    // Logging must never be able to crash the app.
  }
}

function startTelegramBot() {
  if (botProcess) {
    logBotService('startTelegramBot() called but a bot process is already running — ignoring (no duplicate spawn).');
    return; // already running — guards against duplicate spawns
  }

  // Auto-provision the local (non-secret) config file if this is a fresh PC — purely for
  // Settings-screen display/editing (allowedUserIds, report time, etc.); the bot itself
  // (telegram-bot/lib/config.js) already falls back to the same defaults on its own, so this
  // is not a precondition for starting it. There is nothing left that can make the bot
  // itself unable to start: the real credential lives server-side (see lib/telegram.js), not
  // in any local file, so there is no more "invalid local config" failure mode to gate on.
  readOrProvisionTelegramConfig();

  const scriptPath = getBotScriptPath();
  if (!fs.existsSync(scriptPath)) {
    logBotService(`ERROR: bot script not found at ${scriptPath} — the bot cannot start (check asarUnpack packaging). Will retry.`);
    updateTelegramBotStatus({ state: 'error', lastError: `Bot script not found at ${scriptPath}`, lastErrorAt: Date.now() });
    scheduleTelegramBotRestart();
    return;
  }

  logBotService(`Forking Telegram bot child process: ${scriptPath} (Supabase session token currently ${currentSupabaseToken ? 'PRESENT' : 'NOT yet received'}).`);
  updateTelegramBotStatus({ state: 'starting', lastError: null });

  botReady = false;
  try {
    botProcess = fork(scriptPath, [], {
      cwd: path.dirname(scriptPath),
      silent: true, // pipe child stdout/stderr back to us instead of inheriting the console
    });
  } catch (e) {
    botProcess = null;
    logBotService(`ERROR: fork() of the bot process failed: ${e.message}. Will retry.`);
    updateTelegramBotStatus({ state: 'error', lastError: e.message, lastErrorAt: Date.now() });
    scheduleTelegramBotRestart();
    return;
  }

  const logToFile = (chunk) => {
    try {
      // NHC Telegram bot service log lives in NHC's own data folder (NHC_DATA_DIR), never the
      // VHC install's — defensively created here in case it was removed after startup.
      const nhcTelegramDataDir = NHC_DATA_DIR;
      if (!fs.existsSync(nhcTelegramDataDir)) fs.mkdirSync(nhcTelegramDataDir, { recursive: true });
      fs.appendFileSync(nhcDataPath('telegram_bot_service.log'), chunk.toString());
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
        logBotService('Bot child reported ready — relayed the current Supabase session token to it.');
      } else {
        logBotService('Bot child reported ready, but NO Supabase session token is available yet — the bot will report "waiting for sign-in" until the app finishes signing in.');
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
      logBotService('Bot child exited as part of app shutdown (clean stop).');
      updateTelegramBotStatus({ state: 'stopped' });
      return;
    }
    logBotService(`Bot child exited unexpectedly (code ${code}, signal ${signal || 'none'}) — scheduling automatic restart.`);
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
    logBotService('Stopping the Telegram bot child process (app is quitting).');
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
    tray.setToolTip('NHC Pharmacy POS');
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
    { label: 'Open NHC Pharmacy', click: () => showMainWindow() },
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

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.narpavi.nhcpharmacy');
  }

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
  // Reuses the SAME relayed Supabase session token already tracked for the Telegram bot above
  // (currentSupabaseToken, updated by the 'supabase-session-token-changed' IPC) — no second
  // authentication system, exactly as required.
  startSyncEngine(() => currentSupabaseToken);

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
  stopSyncEngine();
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
  try { closeDatabase(); } catch (e) {}
});
