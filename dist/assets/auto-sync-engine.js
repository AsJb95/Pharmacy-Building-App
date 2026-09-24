/**
 * VHC Pharmacy POS - Automatic Background Backup Engine
 * Maintains a single auto-backup file: VHC_POS_AutoBackup.json in Google Drive.
 */

(function () {
  const AUTO_BACKUP_FILENAME = 'VHC_POS_AutoBackup.json';
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
    status: 'synced', // 'synced' | 'syncing' | 'pending' | 'error' | 'offline'
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
      appName: 'VHC Pharmacy POS',
      backupType: 'AutoBackup',
      timestamp: new Date().toISOString(),
      formattedDate: new Date().toLocaleString('en-IN'),
      settings: settings,
      patients: patients,
      salesHistory: salesHistory,
      inventory: inv,
      cartDraft: cartDraft
    };
  }

  const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyQNSa8FMSV4RXwegDKFrUO-6JfLLkA40N91mHR9dsd7vA9CsxYZ6KTfUrRnVLDiSpvZw/exec';

  function getScriptUrlAndFolder() {
    try {
      let settingsStr = localStorage.getItem('pos_settings');
      let settings = settingsStr ? JSON.parse(settingsStr) : {};
      let scriptUrl = (settings.gDriveScriptUrl || '').trim() || DEFAULT_SCRIPT_URL;

      if (!settings.gDriveScriptUrl) {
        settings.gDriveScriptUrl = DEFAULT_SCRIPT_URL;
        originalSetItem('pos_settings', JSON.stringify(settings));
      }

      let driveUrl = settings.googleDriveUrl || settings.oneDriveUrl || '';
      let folderMatch = driveUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
      let folderId = folderMatch ? folderMatch[1] : '';
      return { scriptUrl, folderId };
    } catch (e) {
      return { scriptUrl: DEFAULT_SCRIPT_URL, folderId: '' };
    }
  }

  // Execute backup upload
  async function performAutoSync(isClosing = false) {
    const { scriptUrl, folderId } = getScriptUrlAndFolder();
    const snapshot = getDatabaseSnapshot();

    // Write the local snapshot FIRST, unconditionally — before attempting (or even checking
    // reachability for) the cloud upload. This file (VHC_POS_AutoBackup.json) is also what
    // the embedded Telegram bot reads for /today, /report, /inventory etc., so it must track
    // the live local database regardless of internet/Google Drive availability. Previously
    // this write only happened as a side effect of a SUCCESSFUL cloud upload, so a slow,
    // misconfigured, or offline cloud sync silently left Telegram showing stale (often zero)
    // data even though the POS app itself was fully up to date locally. The cloud upload
    // below is unchanged — still attempted, still retried on failure — this only decouples
    // the LOCAL copy's freshness from whether that remote step succeeds.
    if (window.electronAPI && window.electronAPI.saveGDriveBackup) {
      try {
        await window.electronAPI.saveGDriveBackup(JSON.stringify(snapshot, null, 2), AUTO_BACKUP_FILENAME);
      } catch (e) {}
    }

    if (!scriptUrl) {
      setState({ status: 'pending', errorMessage: 'Script URL not set' });
      return false;
    }

    if (!navigator.onLine) {
      setState({ status: 'offline', errorMessage: 'No internet connection' });
      return false;
    }

    setState({ status: 'syncing', errorMessage: '' });

    try {
      const payload = {
        fileName: AUTO_BACKUP_FILENAME,
        folderId: folderId,
        fileContent: JSON.stringify(snapshot, null, 2)
      };

      let response;
      if (window.electronAPI && window.electronAPI.gdriveUpload) {
        response = await window.electronAPI.gdriveUpload(scriptUrl, payload);
      } else {
        const res = await fetch(scriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload)
        });
        response = await res.json();
      }

      if (response && response.success) {
        const now = new Date().toISOString();
        setState({
          status: 'synced',
          pendingChanges: false,
          lastSyncTime: now,
          errorMessage: ''
        });
        return true;
      } else {
        throw new Error((response && response.error) || 'Upload returned failure');
      }
    } catch (err) {
      setState({
        status: 'error',
        errorMessage: err.message || 'Auto sync failed'
      });
      // Schedule retry after 60s if not closing
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
      status: navigator.onLine ? 'pending' : 'offline'
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
  window.addEventListener('beforeunload', (e) => {
    if (state.pendingChanges && navigator.onLine) {
      const { scriptUrl, folderId } = getScriptUrlAndFolder();
      if (scriptUrl) {
        const snapshot = getDatabaseSnapshot();
        const payload = {
          fileName: AUTO_BACKUP_FILENAME,
          folderId: folderId,
          fileContent: JSON.stringify(snapshot, null, 2)
        };
        if (window.electronAPI && window.electronAPI.gdriveUpload) {
          window.electronAPI.gdriveUpload(scriptUrl, payload);
        }
      }
    }
  });

  // Startup Cloud Check
  async function checkForNewerCloudBackup() {
    const { scriptUrl, folderId } = getScriptUrlAndFolder();
    if (!scriptUrl || !navigator.onLine) return;

    try {
      const listUrl = `${scriptUrl}?action=list&folderId=${encodeURIComponent(folderId)}`;
      let listRes;
      if (window.electronAPI && window.electronAPI.gdriveFetch) {
        listRes = await window.electronAPI.gdriveFetch(listUrl);
      } else {
        const res = await fetch(listUrl);
        listRes = await res.json();
      }

      if (listRes && listRes.success && Array.isArray(listRes.files) && listRes.files.length > 0) {
        // Find auto-backup file or newest backup file
        let targetFile = listRes.files.find((f) => f.name === AUTO_BACKUP_FILENAME) || listRes.files[0];
        if (!targetFile) return;

        let cloudTime = new Date(targetFile.lastModified || targetFile.updated || targetFile.created || 0).getTime();
        let localTime = state.lastChangeTime ? new Date(state.lastChangeTime).getTime() : 0;

        // If cloud backup is newer by more than 10 seconds
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

  // Download and restore from cloud backup
  async function restoreFromCloudBackup(file) {
    const { scriptUrl } = getScriptUrlAndFolder();
    if (!scriptUrl || !file) return;

    try {
      const getUrl = `${scriptUrl}?action=get&fileId=${encodeURIComponent(file.id)}`;
      let getRes;
      if (window.electronAPI && window.electronAPI.gdriveFetch) {
        getRes = await window.electronAPI.gdriveFetch(getUrl);
      } else {
        const res = await fetch(getUrl);
        getRes = await res.json();
      }

      if (!getRes || !getRes.success || !getRes.content) {
        alert('Failed to download cloud backup content.');
        return;
      }

      let backupData = JSON.parse(getRes.content);
      if (!backupData || typeof backupData !== 'object') {
        alert('Invalid cloud backup file structure.');
        return;
      }

      // Restore data to localStorage without triggering change events
      if (backupData.settings) originalSetItem('pos_settings', JSON.stringify(backupData.settings));
      if (backupData.patients) originalSetItem('custom_opd_patients', JSON.stringify(backupData.patients));
      if (backupData.salesHistory) {
        let beforeSales = [];
        try { beforeSales = JSON.parse(localStorage.getItem('vhc_pos_sales_history') || '[]'); } catch (e) {}
        originalSetItem('vhc_pos_sales_history', JSON.stringify(backupData.salesHistory));
        if (window.VHC_AUDIT && window.VHC_AUDIT.logFinancial) {
          window.VHC_AUDIT.logFinancial('RESTORE_IMPORT_SALES_HISTORY', {
            source: 'cloud-auto-backup',
            previous: { count: Array.isArray(beforeSales) ? beforeSales.length : 0 },
            next: { count: Array.isArray(backupData.salesHistory) ? backupData.salesHistory.length : 0 },
            message: 'Startup cloud backup restore replaced local sales history.',
          });
        }
        if (window.VHC_AUDIT && window.VHC_AUDIT.runFinancialIntegrityAudit) {
          window.VHC_AUDIT.runFinancialIntegrityAudit({ source: 'cloud-auto-backup-restore', alwaysStore: true });
        }
      }
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
              <span style="font-weight: 700; color: #0c4a6e;">${new Date(file.lastModified || file.updated || Date.now()).toLocaleString('en-IN')}</span>
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
    checkForNewerCloudBackup: checkForNewerCloudBackup
  };

  // If pending changes existed before reload, schedule auto-sync
  if (state.pendingChanges) {
    markDataChanged();
  }

  // Run startup cloud check after 3 seconds
  setTimeout(checkForNewerCloudBackup, 3000);
})();
