import { app, BrowserWindow, shell, nativeImage, ipcMain, dialog, net, safeStorage, Tray, Menu, systemPreferences, nativeTheme } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, fork } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';

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
// Google OAuth client: loaded at runtime from local config, never hard-coded (see loadGoogleOAuthClient).
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

// ─── Windows 11 Personalization IPC ───
ipcMain.handle('windows:get-personalization', () => {
  let accentColor = '#0078D4';
  try {
    if (systemPreferences && typeof systemPreferences.getAccentColor === 'function') {
      const raw = systemPreferences.getAccentColor();
      if (raw && typeof raw === 'string') {
        accentColor = '#' + raw.slice(0, 6);
      }
    }
  } catch (e) {}
  return {
    accentColor,
    shouldUseDarkColors: nativeTheme ? Boolean(nativeTheme.shouldUseDarkColors) : true
  };
});

try {
  if (systemPreferences && typeof systemPreferences.on === 'function') {
    systemPreferences.on('accent-color-changed', (event, newColor) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const hex = typeof newColor === 'string' ? '#' + newColor.slice(0, 6) : '#0078D4';
        mainWindow.webContents.send('windows:accent-color-changed', hex);
      }
    });
  }
} catch (e) {}

try {
  if (nativeTheme && typeof nativeTheme.on === 'function') {
    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('windows:theme-changed', Boolean(nativeTheme.shouldUseDarkColors));
      }
    });
  }
} catch (e) {}

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

// ─── Google OAuth sign-in (loopback + PKCE, RFC 8252 / RFC 7636) — v3.19.5 ───
// VHC Pharmacy POS uses its OWN Google Cloud OAuth client (Desktop app). The client JSON is NOT in source or
// Git; it is read at runtime from the first readable location:
//   1. %VHC_GOOGLE_OAUTH_CLIENT_FILE%                  (dev / QA override)
//   2. <userData>\google-oauth-client.json             (per-PC provisioning)
//   3. C:\VHC_Pharmacy_Data\google-oauth-client.json   (shared data folder)
//   4. <resources>\client_secret_vhc.json              (installer extraResources, from git-ignored config\)
//   5. <app>\config\client_secret_vhc.json             (unpackaged dev run)
// Another customer's OAuth client (NHC Pharmacy POS) is refused outright. Scope is least-privilege
// drive.file (only files this app creates) + openid email. Refresh tokens are stored ONLY via Windows
// DPAPI (safeStorage); if that is unavailable sign-in is refused instead of writing a plain-text token.
const GOOGLE_OAUTH_SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const FOREIGN_OAUTH_CLIENT_PREFIXES = ['193589136107-']; // NHC Pharmacy POS — never valid for VHC
function googleOAuthClientCandidates() {
  const list = [];
  if (process.env.VHC_GOOGLE_OAUTH_CLIENT_FILE) list.push(['env', process.env.VHC_GOOGLE_OAUTH_CLIENT_FILE]);
  list.push(['userData', path.join(app.getPath('userData'), 'google-oauth-client.json')]);
  list.push(['dataDir', path.join(VHC_DATA_DIR, 'google-oauth-client.json')]);
  if (app.isPackaged) list.push(['resources', path.join(process.resourcesPath, 'client_secret_vhc.json')]);
  else list.push(['dev', path.join(__dirname, '..', 'config', 'client_secret_vhc.json')]);
  return list;
}
function parseGoogleOAuthClient(text) {
  const j = JSON.parse(text);
  const c = (j && (j.installed || j.web)) || j || {};
  const clientId = String(c.client_id || '').trim();
  const clientSecret = String(c.client_secret || '').trim();
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) return { error: 'GOOGLE_OAUTH_CLIENT_INVALID' };
  if (FOREIGN_OAUTH_CLIENT_PREFIXES.some((p) => clientId.startsWith(p))) return { error: 'FOREIGN_OAUTH_CLIENT' };
  return { clientId, clientSecret };
}
let googleOAuthClientCache = null;
function loadGoogleOAuthClient() {
  if (googleOAuthClientCache) return googleOAuthClientCache;
  let lastError = 'GOOGLE_OAUTH_NOT_CONFIGURED';
  for (const [source, file] of googleOAuthClientCandidates()) {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) continue;
      const parsed = parseGoogleOAuthClient(fs.readFileSync(file, 'utf8'));
      if (parsed.error) { lastError = parsed.error; continue; }
      googleOAuthClientCache = { ...parsed, source, fingerprint: crypto.createHash('sha256').update(parsed.clientId).digest('hex').slice(0, 16) };
      return googleOAuthClientCache;
    } catch (e) {
      lastError = 'GOOGLE_OAUTH_CLIENT_INVALID';
    }
  }
  return { error: lastError };
}
function getOAuthTokenFilePath() {
  return path.join(app.getPath('userData'), 'gdrive_oauth_token.enc');
}
function getOAuthMetaFilePath() {
  return path.join(app.getPath('userData'), 'gdrive_oauth_meta.json');
}
function clearGoogleOAuthTokens() {
  try { if (fs.existsSync(getOAuthTokenFilePath())) fs.unlinkSync(getOAuthTokenFilePath()); } catch (e) {}
  try { if (fs.existsSync(getOAuthMetaFilePath())) fs.unlinkSync(getOAuthMetaFilePath()); } catch (e) {}
}
const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

ipcMain.handle('google-oauth-status', async () => {
  const client = loadGoogleOAuthClient();
  if (client.error) return { signedIn: false, configured: false, error: client.error };
  try {
    if (!fs.existsSync(getOAuthMetaFilePath()) || !fs.existsSync(getOAuthTokenFilePath())) return { signedIn: false, configured: true };
    const meta = JSON.parse(fs.readFileSync(getOAuthMetaFilePath(), 'utf8'));
    // A token issued to a different OAuth client (e.g. the old NHC-branded one) can never refresh here.
    if (meta.client !== client.fingerprint) {
      clearGoogleOAuthTokens();
      return { signedIn: false, configured: true, reconnect: true, error: 'RECONNECT_REQUIRED' };
    }
    return { signedIn: !!meta.email, configured: true, email: meta.email || null };
  } catch (e) {
    return { signedIn: false, configured: true };
  }
});

ipcMain.handle('google-oauth-signin', async () => {
  const client = loadGoogleOAuthClient();
  if (client.error) return { success: false, error: client.error };
  if (!safeStorage.isEncryptionAvailable()) return { success: false, error: 'TOKEN_STORAGE_UNAVAILABLE' };
  if (oauthSignInServer) {
    try { oauthSignInServer.close(); } catch (e) {}
    oauthSignInServer = null;
  }
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const oauthState = base64url(crypto.randomBytes(16));
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
    }, 180000);

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
        const stateOk = reqUrl.searchParams.get('state') === oauthState;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px;">' +
          '<h2>' + (code && stateOk ? '✅ VHC Pharmacy POS is connected to Google Drive. You can close this tab.' : '❌ Sign-in failed or was cancelled.') + '</h2>' +
          '</body></html>'
        );
        try { server.close(); } catch (e) {}
        oauthSignInServer = null;

        if (errorParam || !code) {
          finish({ success: false, error: errorParam || 'No authorization code received' });
          return;
        }
        if (!stateOk) {
          finish({ success: false, error: 'Sign-in response did not match this request (state mismatch).' });
          return;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
          }).toString()
        });
        const tokenJson = await tokenRes.json();
        if (!tokenJson.access_token) {
          finish({ success: false, error: tokenJson.error_description || tokenJson.error || 'Token exchange failed' });
          return;
        }
        if (!String(tokenJson.scope || '').split(' ').includes('https://www.googleapis.com/auth/drive.file')) {
          finish({ success: false, error: 'Google Drive permission was not granted. Please allow access to continue.' });
          return;
        }
        if (!tokenJson.refresh_token) {
          finish({ success: false, error: 'Google did not return an offline token. Please remove the app at myaccount.google.com/permissions and sign in again.' });
          return;
        }

        const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + tokenJson.access_token }
        });
        const userJson = await userRes.json();
        const email = userJson.email || 'Unknown';

        fs.writeFileSync(getOAuthTokenFilePath(), safeStorage.encryptString(tokenJson.refresh_token));
        fs.writeFileSync(getOAuthMetaFilePath(), JSON.stringify({ email, client: client.fingerprint, scope: GOOGLE_OAUTH_SCOPES, createdAt: new Date().toISOString() }));

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
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_OAUTH_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: oauthState
      }).toString();
      shell.openExternal(authUrl);
    });
    server.on('error', (e) => finish({ success: false, error: e.message }));
  });
});

// Expired / revoked / foreign-client / unreadable refresh tokens are cleared and reported as RECONNECT_REQUIRED
// so the UI asks for a fresh sign-in instead of failing repeatedly.
ipcMain.handle('google-oauth-refresh', async () => {
  const client = loadGoogleOAuthClient();
  if (client.error) return { success: false, error: client.error };
  try {
    if (!fs.existsSync(getOAuthTokenFilePath())) return { success: false, error: 'Not signed in' };
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(getOAuthMetaFilePath(), 'utf8')); } catch (e) {}
    if (meta.client !== client.fingerprint) { clearGoogleOAuthTokens(); return { success: false, error: 'RECONNECT_REQUIRED' }; }
    let refreshToken;
    try {
      refreshToken = safeStorage.decryptString(fs.readFileSync(getOAuthTokenFilePath()));
    } catch (e) {
      clearGoogleOAuthTokens();
      return { success: false, error: 'RECONNECT_REQUIRED' };
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token'
      }).toString()
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(tokenJson.error)) {
        clearGoogleOAuthTokens();
        return { success: false, error: 'RECONNECT_REQUIRED' };
      }
      return { success: false, error: tokenJson.error_description || tokenJson.error || 'Refresh failed' };
    }
    return { success: true, accessToken: tokenJson.access_token, expiresIn: tokenJson.expires_in };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('google-oauth-signout', async () => {
  try {
    clearGoogleOAuthTokens();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── v3.19.5 Google Drive Backup v2 — encryption key + envelope ───
// The recovery key (256-bit, shown as 64 hex digits) encrypts every v2 backup (AES-256-GCM, see
// vhc-backup-crypto.cjs). It is stored on this PC ONLY with Windows DPAPI (safeStorage); if DPAPI is
// unavailable we refuse to store it rather than writing it in plain text. It is never sent to Google or
// Supabase. The renderer receives it only to show it to an admin (create / reveal), never for encryption.
const backupCrypto = createRequire(import.meta.url)('./vhc-backup-crypto.cjs');
function getBackupKeyFilePath() { return path.join(app.getPath('userData'), 'gdrive_backup_key.enc'); }
function getBackupKeyMetaFilePath() { return path.join(app.getPath('userData'), 'gdrive_backup_key_meta.json'); }
function readStoredBackupKey() {
  try {
    if (!fs.existsSync(getBackupKeyFilePath()) || !safeStorage.isEncryptionAvailable()) return null;
    return backupCrypto.normalizeRecoveryKey(safeStorage.decryptString(fs.readFileSync(getBackupKeyFilePath())));
  } catch (e) {
    return null;
  }
}
function readBackupKeyMeta() {
  try { return JSON.parse(fs.readFileSync(getBackupKeyMetaFilePath(), 'utf8')); } catch (e) { return null; }
}
function storeBackupKey(recoveryKey, source) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('KEY_STORAGE_UNAVAILABLE');
  const key = backupCrypto.normalizeRecoveryKey(recoveryKey);
  if (!key) throw new Error('INVALID_KEY');
  const meta = { keyId: backupCrypto.keyIdFor(key), createdAt: new Date().toISOString(), source };
  fs.writeFileSync(getBackupKeyFilePath(), safeStorage.encryptString(key));
  fs.writeFileSync(getBackupKeyMetaFilePath(), JSON.stringify(meta));
  return meta;
}
ipcMain.handle('vhc-backup:key-status', async () => {
  const key = readStoredBackupKey();
  const meta = readBackupKeyMeta();
  return {
    configured: !!key,
    keyId: key ? backupCrypto.keyIdFor(key) : null,
    createdAt: key && meta ? meta.createdAt : null,
    source: key && meta ? meta.source : null,
    storageAvailable: safeStorage.isEncryptionAvailable(),
  };
});
ipcMain.handle('vhc-backup:create-key', async () => {
  try {
    if (readStoredBackupKey()) return { success: false, error: 'KEY_EXISTS' };
    const key = backupCrypto.generateRecoveryKey();
    const meta = storeBackupKey(key, 'generated');
    return { success: true, keyId: meta.keyId, recoveryKey: backupCrypto.formatRecoveryKey(key) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('vhc-backup:reveal-key', async () => {
  const key = readStoredBackupKey();
  return key ? { success: true, recoveryKey: backupCrypto.formatRecoveryKey(key), keyId: backupCrypto.keyIdFor(key) } : { success: false, error: 'NO_KEY' };
});
// Import on a new PC. When a backup is supplied, the key must actually open it before it is saved.
ipcMain.handle('vhc-backup:import-key', async (event, { recoveryKey, envelopeText, replace } = {}) => {
  try {
    const key = backupCrypto.normalizeRecoveryKey(recoveryKey);
    if (!key) return { success: false, error: 'INVALID_KEY' };
    const existing = readStoredBackupKey();
    if (existing && existing !== key && !replace) return { success: false, error: 'KEY_EXISTS' };
    if (envelopeText) {
      const check = backupCrypto.decryptBackup({ envelopeText, recoveryKey: key });
      if (!check.ok) return { success: false, error: check.code };
    }
    const meta = storeBackupKey(key, 'imported');
    return { success: true, keyId: meta.keyId };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('vhc-backup:encrypt', async (event, { plaintext, kind, counts } = {}) => {
  try {
    const key = readStoredBackupKey();
    if (!key) return { success: false, error: 'NO_KEY' };
    const out = backupCrypto.encryptBackup({
      plaintext,
      recoveryKey: key,
      meta: { kind, counts, appVersion: app.getVersion(), deviceLabel: os.hostname() },
    });
    // Self-check before anything is uploaded: the file we are about to send must decrypt to the same bytes.
    const verify = backupCrypto.decryptBackup({ envelopeText: out.envelopeText, recoveryKey: key });
    if (!verify.ok || verify.plaintext !== plaintext) return { success: false, error: 'SELF_CHECK_FAILED' };
    return { success: true, envelopeText: out.envelopeText, header: out.header, envelopeMd5: out.envelopeMd5 };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('vhc-backup:decrypt', async (event, { envelopeText, recoveryKey } = {}) => {
  try {
    const key = recoveryKey ? backupCrypto.normalizeRecoveryKey(recoveryKey) : readStoredBackupKey();
    if (!key) return { success: false, error: recoveryKey ? 'INVALID_KEY' : 'NO_KEY', header: backupCrypto.readHeader(envelopeText).header || null };
    const out = backupCrypto.decryptBackup({ envelopeText, recoveryKey: key });
    return out.ok ? { success: true, plaintext: out.plaintext, header: out.header } : { success: false, error: out.code, header: out.header || null };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('vhc-backup:read-header', async (event, { envelopeText } = {}) => {
  const out = backupCrypto.readHeader(envelopeText);
  return out.ok ? { success: true, header: out.header } : { success: false, error: out.code };
});

// ─── Gemini AI & Scanner Configuration (Windows DPAPI via safeStorage) ───
// Stores API credentials encrypted with Windows DPAPI (safeStorage). Raw keys are never
// returned to the renderer or stored in plaintext. If DPAPI is unavailable, saving is
// rejected rather than falling back to plaintext storage.
function getAiConfigFilePath() {
  return path.join(app.getPath('userData'), 'ai_config.enc');
}
function getAiMetaFilePath() {
  return path.join(app.getPath('userData'), 'ai_config_meta.json');
}

function redactSecret(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED_API_KEY]')
    .replace(/(key=)[0-9A-Za-z_-]{20,}/gi, '$1[REDACTED_API_KEY]');
}

function isMaskedKey(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  return (
    trimmed.includes('...') ||
    trimmed.includes('***') ||
    /[\u2026\u2022\u25CF]|\*{2,}/.test(trimmed) ||
    /^AIza[0-9A-Za-z_-]{2,8}[.…]/.test(trimmed)
  );
}

function sanitizeApiKey(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // 1. Remove invisible Unicode characters (BOM, zero-width spaces/joiners, non-breaking spaces, line separators)
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u00A0\u200E\u200F\u2028\u2029\u202F\u205F\u3000\u00AD]/g, '').trim();
  // 2. Normalize Unicode hyphens and dashes (en-dash, em-dash, non-breaking hyphen) to ASCII '-'
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  // 3. Strip env/header prefixes (e.g. export GEMINI_API_KEY=, GOOGLE_API_KEY=, Bearer, Gemini API Key:, etc.)
  s = s.replace(/^(?:export\s+)?(?:(?:GOOGLE_|GEMINI_)?API[-_]?KEY|TOKEN|BEARER|KEY)\s*(?:[:=]\s*|\s+)/i, '').trim();
  s = s.replace(/^(?:Gemini|Google)\s+(?:API\s+)?Key\s*(?:[:=]\s*|\s+)/i, '').trim();
  // 4. Extract key from URL query if user pasted full URL (e.g. ?key=... or &key=...)
  const m = s.match(/[?&]key=([^&#\s]+)/i);
  if (m) s = m[1].trim();
  // 5. Strip straight quotes, backticks, smart quotes, and angle/square brackets or parentheses
  s = s.replace(/^["'`“”‘’«»<(\[]+|["'`“”‘’«»>)\]]+$/g, '').trim();
  // 6. Strip trailing code punctuation (semicolons, commas)
  s = s.replace(/[;,]+$/, '').trim();
  // 7. Secondary strip of quotes/brackets in case quotes enclosed prefix + key
  s = s.replace(/^["'`“”‘’«»<(\[]+|["'`“”‘’«»>)\]]+$/g, '').trim();
  return s;
}

const REVOKED_KEY_SHA256 = '7916db979ece22bff45a09e028e226057aaad904ee345d81a63d8cf502ae62d2';
function isRevokedKey(key) {
  if (!key || typeof key !== 'string') return false;
  try {
    return crypto.createHash('sha256').update(key.trim()).digest('hex') === REVOKED_KEY_SHA256;
  } catch (e) {
    return false;
  }
}

function isValidGoogleApiKey(key) {
  if (!key || typeof key !== 'string') return false;
  const k = sanitizeApiKey(key);
  if (!k) return false;
  if (isMaskedKey(k)) return false;
  // Reject keys from other AI providers (OpenAI, Anthropic)
  if (/^sk[-_]/i.test(k)) return false;
  // Support standard Google AI Studio keys (AIza...) and other valid Google/Gemini key formats (20-128 chars)
  if (k.length < 20 || k.length > 128) return false;
  if (!/^[0-9A-Za-z_\-+./=]+$/.test(k)) return false;
  const upper = k.toUpperCase();
  if (upper.includes('YOUR_') || upper.includes('TODO') || upper.includes('REPLACE_ME') || upper.includes('API_KEY')) return false;
  return true;
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (isMaskedKey(trimmed)) return trimmed;
  if (trimmed.length <= 10) return '********';
  return trimmed.slice(0, 6) + '...' + trimmed.slice(-4);
}

function readStoredAiKey() {
  try {
    const encFile = getAiConfigFilePath();
    if (!fs.existsSync(encFile) || !safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(fs.readFileSync(encFile));
    return decrypted.trim() || null;
  } catch (e) {
    return null;
  }
}

function readAiMeta() {
  try {
    const metaFile = getAiMetaFilePath();
    if (!fs.existsSync(metaFile)) return null;
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

function validateAiIpcSender(event) {
  if (!event || !event.sender) return false;
  if (mainWindow && event.sender !== mainWindow.webContents) return false;
  return true;
}

const SUPPORTED_GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Recommended: Fast & Multimodal)', recommended: true },
  { id: 'gemini-flash-latest', name: 'Gemini Flash Latest (Auto-Updating)', recommended: false },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Legacy)', recommended: false },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Legacy)', recommended: false },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Legacy)', recommended: false },
];

function getActiveGeminiModel(overrideModel) {
  if (overrideModel && typeof overrideModel === 'string' && overrideModel.trim()) {
    return overrideModel.trim();
  }
  const meta = readAiMeta();
  if (meta?.model && typeof meta.model === 'string' && meta.model.trim()) {
    return meta.model.trim();
  }
  return 'gemini-2.5-flash';
}

ipcMain.handle('ai:get-config', async (event) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  const key = readStoredAiKey();
  const meta = readAiMeta();
  const storageAvailable = safeStorage.isEncryptionAvailable();
  return {
    success: true,
    configured: !!key,
    provider: meta?.provider || 'gemini',
    model: meta?.model || 'gemini-2.5-flash',
    keyMask: key ? maskApiKey(key) : '',
    updatedAt: meta?.updatedAt || null,
    storageAvailable,
    supportedModels: SUPPORTED_GEMINI_MODELS,
  };
});

ipcMain.handle('ai:save-config', async (event, { provider = 'gemini', apiKey, model = 'gemini-2.5-flash' } = {}) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      success: false,
      error: 'SECURE_STORAGE_UNAVAILABLE',
      details: 'Windows DPAPI (Electron safeStorage) is not available on this system. Plaintext fallback is prohibited.',
    };
  }
  const cleanModel = (model && typeof model === 'string' && model.trim()) ? model.trim() : 'gemini-2.5-flash';
  const rawKey = sanitizeApiKey(apiKey);

  let keyToSave = rawKey;
  // If user passed empty key or masked key string, check if we are updating model only
  if (!keyToSave || isMaskedKey(keyToSave)) {
    const existingKey = readStoredAiKey();
    if (!existingKey) {
      return {
        success: false,
        error: 'API_KEY_REQUIRED',
        details: 'Please enter a valid Gemini API key.',
      };
    }
    // Update model only while preserving existing key
    const meta = {
      provider: 'gemini',
      model: cleanModel,
      keyMask: maskApiKey(existingKey),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getAiMetaFilePath(), JSON.stringify(meta, null, 2), 'utf8');
    return { success: true, meta, modelUpdatedOnly: true };
  }

  // Reject the revoked leaked key
  if (isRevokedKey(keyToSave)) {
    return {
      success: false,
      error: 'REVOKED_KEY',
      details: 'This API key was reported as leaked and revoked by Google. Please enter a fresh, valid API key from Google AI Studio.',
    };
  }

  // Validate format
  if (!isValidGoogleApiKey(keyToSave)) {
    return {
      success: false,
      error: 'INVALID_KEY_FORMAT',
      details: 'Invalid Gemini API key format (must be 20-128 characters).',
    };
  }

  try {
    // Encrypt new key with DPAPI
    const encrypted = safeStorage.encryptString(keyToSave);
    fs.writeFileSync(getAiConfigFilePath(), encrypted);
    const meta = {
      provider: 'gemini',
      model: cleanModel,
      keyMask: maskApiKey(keyToSave),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getAiMetaFilePath(), JSON.stringify(meta, null, 2), 'utf8');
    return { success: true, meta };
  } catch (err) {
    return { success: false, error: 'STORAGE_WRITE_FAILED', details: redactSecret(err.message) };
  }
});

ipcMain.handle('ai:remove-config', async (event) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  try {
    if (fs.existsSync(getAiConfigFilePath())) fs.unlinkSync(getAiConfigFilePath());
    if (fs.existsSync(getAiMetaFilePath())) fs.unlinkSync(getAiMetaFilePath());
    return { success: true };
  } catch (err) {
    return { success: false, error: 'STORAGE_DELETE_FAILED', details: redactSecret(err.message) };
  }
});

ipcMain.handle('ai:test-connection', async (event, { apiKey, model } = {}) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  let testKey = sanitizeApiKey(apiKey);
  if (!testKey || isMaskedKey(testKey)) {
    testKey = readStoredAiKey();
  }
  if (!testKey) {
    return { success: false, error: 'NO_KEY_CONFIGURED', details: 'No API key provided or saved in secure storage.' };
  }
  if (isRevokedKey(testKey)) {
    return {
      success: false,
      error: 'REVOKED_KEY',
      details: 'This API key was reported as leaked and revoked by Google. Please enter a new key in Settings -> AI & Scanner Configuration.',
    };
  }
  if (!isValidGoogleApiKey(testKey)) {
    return {
      success: false,
      error: 'INVALID_KEY_FORMAT',
      details: 'Invalid Gemini API key format (must be 20-128 characters).',
    };
  }
  const targetModel = getActiveGeminiModel(model);

  const startTime = Date.now();
  try {
    // Verify generateContent directly so that deprecated or unsupported models are accurately caught
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(testKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: 'Respond with OK' }],
          },
        ],
      }),
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;

    if (resp.ok) {
      return {
        success: true,
        model: targetModel,
        displayName: targetModel,
        latencyMs,
      };
    }

    const errBody = await resp.json().catch(() => ({}));
    const rawMsg = errBody.error?.message || resp.statusText;
    const cleanMsg = redactSecret(rawMsg);

    if (resp.status === 404) {
      return {
        success: false,
        error: 'MODEL_NOT_FOUND',
        code: 404,
        details: `Model "${targetModel}" is not available or not supported for generateContent on this API endpoint (${cleanMsg}). Please select a supported model (such as gemini-2.5-flash) in Settings -> AI & Scanner Configuration.`,
        latencyMs,
      };
    }
    if (resp.status === 429) {
      return { success: false, error: 'QUOTA_EXCEEDED', code: 429, details: cleanMsg, latencyMs };
    }
    if (resp.status === 400) {
      return { success: false, error: 'INVALID_REQUEST', code: 400, details: cleanMsg, latencyMs };
    }
    if (resp.status === 403) {
      return { success: false, error: 'PERMISSION_DENIED', code: 403, details: cleanMsg, latencyMs };
    }
    return { success: false, error: `HTTP_${resp.status}`, code: resp.status, details: cleanMsg, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    if (err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', details: 'Connection timed out after 15 seconds. Check your internet connection.', latencyMs };
    }
    return { success: false, error: 'NETWORK_ERROR', details: redactSecret(err.message), latencyMs };
  }
});

ipcMain.handle('ai:analyze-invoice', async (event, payload = {}) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  const { imageBase64, base64Image, mimeType, model } = payload;
  const key = readStoredAiKey();
  if (!key) {
    return {
      success: false,
      error: 'NO_KEY_CONFIGURED',
      details: 'Gemini API key is not configured. Please open Settings -> AI & Scanner Configuration to enter your key.',
    };
  }
  if (isRevokedKey(key)) {
    return {
      success: false,
      error: 'REVOKED_KEY',
      details: 'The saved Gemini API key was reported as leaked and revoked by Google. Please enter a new key in Settings -> AI & Scanner Configuration.',
    };
  }
  const cleanBase64 = String(imageBase64 || base64Image || '').replace(/^data:image\/[a-zA-Z]+;base64,/, '').trim();
  if (!cleanBase64) {
    return { success: false, error: 'INVALID_IMAGE', details: 'No image data was provided for analysis.' };
  }

  // Central model resolution: strictly use configured or requested model; never silently fall back to legacy models
  const targetModel = getActiveGeminiModel(model);

  const promptText = `
You are an expert Indian pharmacy invoice & purchase bill AI. Read this supplier invoice or purchase bill image.
Extract all listed medicines carefully.
Pay close attention to packing codes and descriptions:
- "15S", "15'S", "15 CAP", "15 TAB", "1X15" indicate a pack size of 15 ("unitsPerPack": 15).
- "10S", "10'S", "10 TAB", "1X10" indicate a pack size of 10 ("unitsPerPack": 10).
- Injections or liquids like "2ML", "1ML", "INJ", "AMP", "VIAL" indicate 1 unit per pack ("unitsPerPack": 1).
- Strip MRP is the price per strip listed under MRP column (e.g., 219.00).
- For QTY and FREE columns: extract "qtyStrips" (billed strips) and "freeStrips" (free bonus strips).
- Calculate total strips = (qtyStrips + freeStrips).
- Calculate "stock" = total_strips * unitsPerPack (e.g., 10 Qty + 10 Free = 20 Strips * 10 = 200 tablet units).

Return the result STRICTLY as a JSON array of objects, where each object has:
- "name": medicine name (e.g. "MNERWIN NT PLUS")
- "batch": batch number (if found, else "")
- "expiry": expiry date MM/YY (if found, else "")
- "netRate": purchase rate per strip (number only, default 0)
- "price": strip MRP listed on bill (number only, default 0)
- "unitsPerPack": pack size / number of units in 1 strip (number only, default 10 or 15 or 1 based on packing)
- "gst": GST percentage (number only, e.g. 5, 12, 18, default 12)
- "stockist": supplier or stockist name (if found, else "")
- "qtyStrips": billed quantity in strips (number only, e.g. 10)
- "freeStrips": free bonus quantity in strips (number only, e.g. 10 or 200)
- "stock": total tablet count = (qtyStrips + freeStrips) * unitsPerPack (number only)
Do not include markdown blocks, output strictly raw JSON array.
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: mimeType || 'image/jpeg',
                  data: cleanBase64,
                },
              },
            ],
          },
        ],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      const rawErr = errJson.error?.message || `HTTP ${resp.status}`;
      const cleanErr = redactSecret(rawErr);
      if (resp.status === 404) {
        return {
          success: false,
          error: 'MODEL_NOT_SUPPORTED',
          code: 404,
          details: `Selected Gemini model "${targetModel}" is not available or not supported on this endpoint (${cleanErr}). Please choose a supported model (such as gemini-2.5-flash) in Settings -> AI & Scanner Configuration.`,
        };
      }
      if (resp.status === 429) {
        return {
          success: false,
          error: 'QUOTA_EXCEEDED',
          code: 429,
          details: `Gemini API quota exceeded: ${cleanErr}. Please retry later or check your Google AI Studio quota.`,
        };
      }
      return {
        success: false,
        error: 'AI_CALL_FAILED',
        code: resp.status,
        details: cleanErr,
      };
    }

    const result = await resp.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\[.*\]/s);
    if (!match) {
      return { success: false, error: 'PARSE_ERROR', details: 'AI did not return a valid list of medicines. Please verify image clarity.' };
    }

    const items = JSON.parse(match[0]);
    if (!Array.isArray(items)) {
      return { success: false, error: 'PARSE_ERROR', details: 'AI response was not a valid array.' };
    }

    return { success: true, items, modelUsed: targetModel };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', details: 'Request timed out after 35 seconds. Please check your internet connection.', code: 0 };
    }
    return { success: false, error: 'AI_CALL_FAILED', details: redactSecret(err.message), code: 0 };
  }
});

ipcMain.handle('ai:analyze-prescription', async (event, payload = {}) => {
  if (!validateAiIpcSender(event)) return { success: false, error: 'UNAUTHORIZED_SENDER' };
  const { imageBase64, base64Image, mimeType, model, currentStockNames, stockNames } = payload;
  const key = readStoredAiKey();
  if (!key) {
    return {
      success: false,
      error: 'NO_KEY_CONFIGURED',
      details: 'Gemini API key is not configured. Please open Settings -> AI & Scanner Configuration to enter your key.',
    };
  }
  if (isRevokedKey(key)) {
    return {
      success: false,
      error: 'REVOKED_KEY',
      details: 'The saved Gemini API key was reported as leaked and revoked by Google. Please enter a new key in Settings -> AI & Scanner Configuration.',
    };
  }
  const cleanBase64 = String(imageBase64 || base64Image || '').replace(/^data:image\/[a-zA-Z]+;base64,/, '').trim();
  if (!cleanBase64) {
    return { success: false, error: 'INVALID_IMAGE', details: 'No image data was provided.' };
  }

  // Central model resolution: strictly use configured or requested model; never silently fall back to legacy models
  const targetModel = getActiveGeminiModel(model);

  const stockList = Array.isArray(currentStockNames || stockNames) ? (currentStockNames || stockNames).slice(0, 300).join(', ') : '';
  const promptText = `
You are an expert pharmacist AI. Read this doctor's handwritten prescription.
We have the following medicines in stock: ${stockList}.
Extract ONLY the list of medicines. Try to match the handwritten names to our stock if they are similar. If it's a completely new medicine, extract it as best as you can.
Also estimate the total quantity needed based on the dosage instructions (e.g. "1-0-1 for 3 days" = 6).
Return the result STRICTLY as a JSON array of objects, where each object has:
- "name": the medicine name
- "qty": the estimated number of units/tablets (number)
Do not include markdown blocks, just the JSON array. Example: [{"name": "Inj. Voveran 1 Amp", "qty": 1}, {"name": "Pantoprazole 40mg (Pan 40)", "qty": 3}]
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: mimeType || 'image/jpeg',
                  data: cleanBase64,
                },
              },
            ],
          },
        ],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      const rawErr = errJson.error?.message || `HTTP ${resp.status}`;
      const cleanErr = redactSecret(rawErr);
      if (resp.status === 404) {
        return {
          success: false,
          error: 'MODEL_NOT_SUPPORTED',
          code: 404,
          details: `Selected Gemini model "${targetModel}" is not available or not supported on this endpoint (${cleanErr}). Please choose a supported model (such as gemini-2.5-flash) in Settings -> AI & Scanner Configuration.`,
        };
      }
      if (resp.status === 429) {
        return {
          success: false,
          error: 'QUOTA_EXCEEDED',
          code: 429,
          details: `Gemini API quota exceeded: ${cleanErr}. Please retry later or check your Google AI Studio quota.`,
        };
      }
      return {
        success: false,
        error: 'AI_CALL_FAILED',
        code: resp.status,
        details: cleanErr,
      };
    }

    const result = await resp.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\[.*\]/s);
    if (!match) {
      return { success: false, error: 'PARSE_ERROR', details: 'Could not extract medicines from prescription.' };
    }

    const items = JSON.parse(match[0]);
    return { success: true, medicines: items, modelUsed: targetModel };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', details: 'Request timed out after 35 seconds. Please check your internet connection.', code: 0 };
    }
    return { success: false, error: 'AI_CALL_FAILED', details: redactSecret(err.message), code: 0 };
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
ipcMain.handle('database:get-offline-auth-identity', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return null;
  try { return mod.getOfflineAuthIdentity(); } catch (e) { return null; }
});
ipcMain.handle('database:record-offline-auth-identity', async (event, identity) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.recordOfflineAuthIdentity(identity || {}); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:clear-offline-auth-identity', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.clearOfflineAuthIdentity(); } catch (e) { return { success: false, error: e.message }; }
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
ipcMain.handle('database:create-local-sale-return', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.createLocalSaleReturn(payload || {}); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:get-local-sale', async (event, billId) => {
  const mod = await initLocalDatabase();
  if (!mod) return null;
  try { return mod.getLocalSaleByBillId(billId); } catch (e) { return null; }
});
ipcMain.handle('database:get-pending-stock-overlays', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getPendingStockOverlays(); } catch (e) { return []; }
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
ipcMain.handle('database:get-sale-returns-for-reports', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getSaleReturnsForReports(); } catch { return []; }
});
ipcMain.handle('database:get-sales-history', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getSalesHistory(); } catch (e) { console.error('[LocalDB] getSalesHistory failed:', e.message); return []; }
});
ipcMain.handle('database:get-financial-sync-operations', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getFinancialSyncOperations(); } catch (e) { console.error('[LocalDB] getFinancialSyncOperations failed:', e.message); return []; }
});
ipcMain.handle('database:get-financial-integrity-snapshot', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return { success: false, error: 'Local database is unavailable', sales: [], operations: [] };
  try { return mod.getFinancialIntegritySnapshot(); } catch (e) {
    console.error('[LocalDB] getFinancialIntegritySnapshot failed:', e.message);
    return { success: false, error: e.message, sales: [], operations: [] };
  }
});
ipcMain.handle('database:get-unsynced-financial-sync-operations', async () => {
  const mod = await initLocalDatabase();
  if (!mod) return [];
  try { return mod.getUnsyncedFinancialSyncOperations(); } catch (e) { console.error('[LocalDB] getUnsyncedFinancialSyncOperations failed:', e.message); return []; }
});
ipcMain.handle('database:mark-financial-sync-attempt', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.markFinancialSyncAttempt(payload && payload.billId, payload && payload.error); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:mark-financial-sync-confirmed', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.markFinancialSyncConfirmed(payload && payload.billId, payload && payload.cloudSaleId); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:mark-financial-sync-sale-confirmed', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.markFinancialSyncSaleConfirmed(payload && payload.billId, payload && payload.cloudSaleId); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:mark-financial-sync-stock-pending', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.markFinancialSyncStockPending(payload && payload.billId, payload && payload.error); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('database:mark-financial-sync-review-required', async (event, payload) => {
  const mod = await initLocalDatabase();
  if (!mod) return DB_UNAVAILABLE();
  try { return mod.markFinancialSyncReviewRequired(payload && payload.billId, payload && payload.status, payload && payload.detail, payload && payload.cloudSaleId); } catch (e) { return { success: false, error: e.message }; }
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
// Asks Chromium to write any pending DOM storage (localStorage) to disk NOW. Chromium otherwise
// defers those writes by several seconds, so a hard kill / power loss right after a destructive
// admin operation could let the previous localStorage state come back while SQLite (which commits
// durably) has already changed. This ONLY flushes: it never clears or alters storage, cookies,
// cache or auth, and it acts on the calling renderer's own persistent session (the VHC window).
ipcMain.handle('storage:flush-local-storage', async (event) => {
  try {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return { success: false, error: 'The app window is not available' };
    wc.session.flushStorageData();
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
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
