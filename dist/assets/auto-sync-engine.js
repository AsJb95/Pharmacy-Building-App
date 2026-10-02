/**
 * NHC Pharmacy POS - Automatic Background Backup Engine
 * Maintains a single auto-backup file: NHC_POS_AutoBackup.json — locally in NHC's own data folder
 * (C:\NHC_Pharmacy_Data\gdrive_backups) and in a separately configured NHC Google Drive folder.
 * NHCBackup validates cloud configuration, filenames and backup identity.
 */

(function () {
  const AUTO_BACKUP_FILENAME = 'NHC_POS_AutoBackup.json';
  const DEBOUNCE_DELAY_MS = 35000; // 35 seconds of inactivity before auto-syncing
  const RETRY_DELAY_MS = 60000; // 60 seconds retry on error

  // Keys that trigger database changes. Deliberately excludes 'pos_active_cart' and other
  // in-progress draft keys — those change on every keystroke during billing and don't need
  // a cloud backup; only completed, durable data should schedule a sync.
  const DB_KEYS = [
    'pos_settings',
    'pos_inventory',
    'vhc_pos_inventory',
    'vhc_pos_sales_history',
    'custom_opd_patients',
    'pos_audit_logs'
  ];

  let state = {
    status: 'synced', // 'synced' | 'syncing' | 'pending' | 'error' | 'offline' | 'unconfigured'
    lastSyncTime: localStorage.getItem('vhc_last_sync_time') || null,
    lastChangeTime: localStorage.getItem('vhc_last_change_time') || null,
    pendingChanges: localStorage.getItem('vhc_pending_changes') === 'true',
    errorMessage: '',
    cloudBackupAvailable: null
  };

  let debounceTimer = null;
  let listeners = new Set();

  function notifyListeners() {
    listeners.forEach((fn) => {
      try { fn(state); } catch (e) {}
    });
  }

  function setState(patch) {
    state = { ...state, ...patch };
    if (patch.lastSyncTime !== undefined) {
      if (patch.lastSyncTime) localStorage.setItem('vhc_last_sync_time', patch.lastSyncTime);
      else localStorage.removeItem('vhc_last_sync_time');
    }
    if (patch.lastChangeTime !== undefined) {
      if (patch.lastChangeTime) localStorage.setItem('vhc_last_change_time', patch.lastChangeTime);
      else localStorage.removeItem('vhc_last_change_time');
    }
    if (patch.pendingChanges !== undefined) {
      localStorage.setItem('vhc_pending_changes', String(patch.pendingChanges));
    }
    notifyListeners();
  }

  // Gather full database export object (compatible with existing JSON format)
  function getDatabaseSnapshot() {
    let inv = [];
    try {
      let invStr = localStorage.getItem('pos_inventory') || localStorage.getItem('vhc_pos_inventory');
      if (invStr) inv = JSON.parse(invStr);
    } catch (e) {}

    let settings = {};
    try {
      let setStr = localStorage.getItem('pos_settings');
      if (setStr) settings = JSON.parse(setStr);
    } catch (e) {}

    let patients = [];
    try {
      let patStr = localStorage.getItem('custom_opd_patients');
      if (patStr) patients = JSON.parse(patStr);
    } catch (e) {}

    let salesHistory = [];
    try {
      let salesStr = localStorage.getItem('vhc_pos_sales_history');
      if (salesStr) salesHistory = JSON.parse(salesStr);
    } catch (e) {}

    let cartDraft = [];
    try {
      let cartStr = localStorage.getItem('pos_active_cart');
      if (cartStr) cartDraft = JSON.parse(cartStr);
    } catch (e) {}

    return {
      appName: 'NHC Pharmacy POS',
      backupNamespace: window.NHCBackup.namespace,
      backupType: 'AutoBackup',
      timestamp: new Date().toISOString(),
      formattedDate: new Date().toLocaleString('en-IN'),
      settings: window.NHCBackup.exportSettings(settings),
      patients: patients,
      salesHistory: salesHistory,
      inventory: inv,
      cartDraft: cartDraft
    };
  }

  function getBackupSettings() {
    try { return JSON.parse(localStorage.getItem('pos_settings') || '{}'); } catch (_) { return {}; }
  }

  // Automatic CLOUD uploads on/off (Settings → Cloud Backup toggle). LOCAL backups always run
  // regardless of this flag or connectivity, so the Telegram bot's data file stays fresh. Default ON.
  function autoCloudEnabled() {
    try { return localStorage.getItem('nhc_auto_cloud_backup') !== 'false'; } catch (_) { return true; }
  }
  async function driveConnected() {
    try {
      const s = window.electronAPI && window.electronAPI.driveStatus ? await window.electronAPI.driveStatus() : null;
      return !!(s && s.signedIn);
    } catch (_) { return false; }
  }

  // Execute backup: ALWAYS write the local snapshot, then OPTIONALLY upload to Google Drive
  // (Automatic folder) via the drive.file OAuth path. A cloud failure never blocks the app and
  // never loses the local backup.
  async function performAutoSync(isClosing = false) {
    const snapshot = getDatabaseSnapshot();

    // Write the local snapshot FIRST, unconditionally — before any cloud attempt. This file
    // (NHC_POS_AutoBackup.json) is also what the embedded Telegram bot reads for /today,
    // /report, /inventory etc., so it must track the live local database regardless of
    // internet/Google Drive availability.
    if (window.electronAPI && window.electronAPI.saveGDriveBackup) {
      try {
        const result = await window.electronAPI.saveGDriveBackup(JSON.stringify(snapshot, null, 2), AUTO_BACKUP_FILENAME);
        if (!result || !result.success) throw new Error(result && result.error || 'Local backup failed');
      } catch (e) {
        setState({ status: 'error', errorMessage: 'NHC local backup failed: ' + e.message });
        return false;
      }
    }

    // Cloud upload is optional and asynchronous — it must NEVER block billing/POS. The local
    // backup above already succeeded, so any cloud problem below only affects the cloud copy.
    if (!autoCloudEnabled()) { setState({ status: 'synced', pendingChanges: false, errorMessage: '' }); return true; }
    if (!navigator.onLine) { setState({ status: 'offline', errorMessage: 'No internet connection' }); return false; }
    if (!(await driveConnected())) {
      setState({ status: 'unconfigured', errorMessage: 'Connect Google Drive in Settings → Cloud Backup to enable cloud backup.' });
      return false;
    }

    setState({ status: 'syncing', errorMessage: '' });
    try {
      const res = await window.electronAPI.driveUploadBackup({
        kind: 'Automatic',
        fileName: AUTO_BACKUP_FILENAME,
        content: JSON.stringify(snapshot, null, 2),
      });
      if (res && res.success) {
        setState({ status: 'synced', pendingChanges: false, lastSyncTime: new Date().toISOString(), errorMessage: '' });
        return true;
      }
      throw new Error((res && res.error) || 'Upload returned failure');
    } catch (err) {
      setState({ status: 'error', errorMessage: err.message || 'Auto cloud backup failed' });
      if (!isClosing) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => performAutoSync(false), RETRY_DELAY_MS);
      }
      return false;
    }
  }

  // Schedule debounced auto-sync when data changes
  function markDataChanged(key) {
    if (key && !DB_KEYS.includes(key)) return;

    const now = new Date().toISOString();
    setState({
      pendingChanges: true,
      lastChangeTime: now,
      status: navigator.onLine ? 'pending' : 'offline',
      errorMessage: ''
    });

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performAutoSync(false);
    }, DEBOUNCE_DELAY_MS);
  }

  // Hook localStorage.setItem globally to intercept database mutations
  const originalSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    originalSetItem(key, value);
    if (DB_KEYS.includes(key)) {
      markDataChanged(key);
    }
  };

  // Listen for online status restoration
  window.addEventListener('online', () => {
    if (state.pendingChanges || state.status === 'offline' || state.status === 'error') {
      setState({ status: 'pending' });
      clearTimeout(debounceTimer);
      // Wait 3 seconds after coming back online to sync
      debounceTimer = setTimeout(() => performAutoSync(false), 3000);
    }
  });

  window.addEventListener('offline', () => {
    setState({ status: 'offline' });
  });

  // App Close handler for final sync
  window.addEventListener('beforeunload', () => {
    if (state.pendingChanges) performAutoSync(true);
  });

  // Startup Cloud Check — WhatsApp-style "restore from cloud?" prompt. On a FRESH install there is
  // no local data (lastChangeTime null → localTime 0), so any cloud backup counts as newer and the
  // prompt is offered after Google Drive is connected. Uses the drive.file OAuth path.
  async function checkForNewerCloudBackup() {
    if (!navigator.onLine) return;
    if (!(await driveConnected())) return; // not connected → nothing to offer yet (connect first)

    try {
      const listRes = await window.electronAPI.driveListBackups();
      if (listRes && listRes.success && Array.isArray(listRes.files) && listRes.files.length > 0) {
        // Prefer NHC's own auto-backup; otherwise the newest NHC backup of any kind (Automatic or
        // Manual). The main process already restricts the list to this app's own folder tree and
        // NHC filenames, so there is no risk of mixing in another application's backups.
        let targetFile = listRes.files.find((f) => f.name === AUTO_BACKUP_FILENAME) || listRes.files[0];
        if (!targetFile) return;

        let cloudTime = new Date(targetFile.modifiedTime || 0).getTime();
        let localTime = state.lastChangeTime ? new Date(state.lastChangeTime).getTime() : 0;

        // If cloud backup is newer by more than 10 seconds (true for a fresh install with no local data)
        if (cloudTime > 0 && cloudTime > localTime + 10000) {
          setState({
            cloudBackupAvailable: {
              file: targetFile,
              cloudTime: new Date(cloudTime).toLocaleString('en-IN'),
              localTime: localTime ? new Date(localTime).toLocaleString('en-IN') : 'None'
            }
          });
          renderStartupPrompt(targetFile);
        }
      }
    } catch (e) {
      console.warn('Cloud startup check failed:', e);
    }
  }

  // Download and restore from a Google Drive cloud backup (drive.file OAuth path). A safety copy of
  // the CURRENT local data is written first, so a restore can never leave the device without a
  // fallback of what was there immediately before.
  async function restoreFromCloudBackup(file) {
    if (!file) return;
    try {
      try {
        const current = getDatabaseSnapshot();
        if (window.electronAPI && window.electronAPI.saveGDriveBackup) {
          await window.electronAPI.saveGDriveBackup(JSON.stringify(current, null, 2), 'NHC_POS_PreRestoreSafety.json');
        }
      } catch (_) { /* safety copy is best-effort; the local auto-backup already exists too */ }

      const dl = await window.electronAPI.driveDownloadBackup(file.id);
      if (!dl || !dl.success) throw new Error((dl && dl.error) || 'Could not download the cloud backup.');
      const backupData = window.NHCBackup.validate(JSON.parse(dl.content));

      // Restore data to localStorage without triggering change events
      if (backupData.settings) originalSetItem('pos_settings', JSON.stringify(window.NHCBackup.restoreSettings(backupData.settings, getBackupSettings())));
      if (backupData.patients) originalSetItem('custom_opd_patients', JSON.stringify(backupData.patients));
      if (backupData.salesHistory) originalSetItem('vhc_pos_sales_history', JSON.stringify(backupData.salesHistory));
      if (backupData.inventory) {
        if (window.VHC_AUDIT && window.VHC_AUDIT.logStock) {
          try {
            const oldInv = JSON.parse(localStorage.getItem('pos_inventory') || '[]');
            const oldByKey = new Map();
            oldInv.forEach((it) => oldByKey.set((it.name || '').toLowerCase().trim() + '||' + (it.batch || '').toLowerCase().trim(), it));
            backupData.inventory.forEach((it) => {
              const key = (it.name || '').toLowerCase().trim() + '||' + (it.batch || '').toLowerCase().trim();
              const oldItem = oldByKey.get(key);
              const oldStock = parseFloat(oldItem && oldItem.stock) || 0;
              const newStock = parseFloat(it.stock) || 0;
              if (!oldItem || oldStock !== newStock) {
                window.VHC_AUDIT.logStock({
                  type: 'RESTORE',
                  product: it.name || '',
                  batch: it.batch || '',
                  qty: newStock - oldStock,
                  opening: oldStock,
                  closing: newStock,
                  reason: 'Backup restore (Cloud auto-check prompt)',
                });
              }
            });
          } catch (e) {}
        }
        originalSetItem('pos_inventory', JSON.stringify(backupData.inventory));
        originalSetItem('vhc_pos_inventory', JSON.stringify(backupData.inventory));
      }

      originalSetItem('vhc_pending_changes', 'false');
      originalSetItem('vhc_last_sync_time', new Date().toISOString());

      alert('✅ Database successfully restored from Cloud Backup! Refreshing page...');
      window.location.reload();
    } catch (err) {
      alert('Error restoring cloud backup: ' + err.message);
    }
  }

  // Render modal dialog if newer cloud backup exists
  function renderStartupPrompt(file) {
    let existingModal = document.getElementById('vhc-cloud-prompt-modal');
    if (existingModal) existingModal.remove();

    const modalHtml = `
      <div id="vhc-cloud-prompt-modal" style="position: fixed; inset: 0; background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); z-index: 999999; display: flex; align-items: center; justify-content: center; padding: 1rem;">
        <div style="background: #ffffff; width: 100%; max-width: 480px; border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35); padding: 1.75rem; border: 1px solid #e2e8f0; font-family: system-ui, -apple-system, sans-serif;">
          <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
            <div style="width: 44px; height: 44px; border-radius: 12px; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">☁️</div>
            <div>
              <h3 style="margin: 0; font-size: 1.15rem; font-weight: 800; color: #0f172a;">Newer Cloud Backup Found</h3>
              <p style="margin: 2px 0 0 0; font-size: 0.8rem; color: #64748b;">Google Drive contains more recent data than local device.</p>
            </div>
          </div>

          <div style="background: #f8fafc; border-radius: 10px; padding: 1rem; border: 1px solid #e2e8f0; margin-bottom: 1.25rem; font-size: 0.82rem; color: #334155; line-height: 1.6;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.4rem;">
              <span style="font-weight: 600; color: #0369a1;">☁️ Cloud Backup:</span>
              <span style="font-weight: 700; color: #0c4a6e;">${new Date(file.modifiedTime || Date.now()).toLocaleString('en-IN')}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="font-weight: 600; color: #64748b;">💻 Local Device:</span>
              <span style="font-weight: 600; color: #475569;">${state.lastChangeTime ? new Date(state.lastChangeTime).toLocaleString('en-IN') : 'No local data recorded'}</span>
            </div>
          </div>

          <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
            <button id="vhc-keep-local-btn" style="padding: 0.6rem 1.1rem; border-radius: 8px; border: 1px solid #cbd5e1; background: #ffffff; color: #475569; font-weight: 700; font-size: 0.85rem; cursor: pointer;">Keep Local Data</button>
            <button id="vhc-restore-cloud-btn" style="padding: 0.6rem 1.2rem; border-radius: 8px; border: none; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #ffffff; font-weight: 700; font-size: 0.85rem; cursor: pointer; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);">Restore From Cloud</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('vhc-keep-local-btn')?.addEventListener('click', () => {
      document.getElementById('vhc-cloud-prompt-modal')?.remove();
      setState({ cloudBackupAvailable: null });
    });

    document.getElementById('vhc-restore-cloud-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('vhc-restore-cloud-btn');
      if (btn) btn.innerText = 'Restoring...';
      await restoreFromCloudBackup(file);
    });
  }

  // Global API exposed for React app components & window
  window.VHCAutoSync = {
    getState: () => ({ ...state }),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    syncNow: () => performAutoSync(false),
    markDataChanged: markDataChanged,
    checkForNewerCloudBackup: checkForNewerCloudBackup,
    // Reuse hooks for the Settings → Cloud Backup card (nhc-cloud-backup.js), so manual backup and
    // restore use the exact same snapshot format and restore logic as the automatic path.
    getSnapshot: () => getDatabaseSnapshot(),
    restoreFromCloud: (file) => restoreFromCloudBackup(file)
  };

  // Initial cloud status: if auto cloud backup is on but Google Drive isn't connected yet, show
  // "unconfigured" (local backups still run). Checked async; never blocks startup.
  (async () => {
    try {
      if (autoCloudEnabled() && !(await driveConnected())) {
        setState({ status: 'unconfigured', errorMessage: 'Connect Google Drive in Settings → Cloud Backup to enable cloud backup.' });
      }
    } catch (_) {}
  })();

  // If pending changes existed before reload, schedule auto-sync (including local backup).
  if (state.pendingChanges) {
    markDataChanged();
  }

  // Run startup cloud check after 3 seconds
  setTimeout(checkForNewerCloudBackup, 3000);
})();
