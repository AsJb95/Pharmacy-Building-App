/*
 * NHC Pharmacy — Google Drive Cloud Backup (Settings add-on)
 * ---------------------------------------------------------
 * Plain <script> loaded by dist/index.html (same pattern as nhc-backup-policy.js /
 * nhc-telegram-users.js) — NO edits to the compiled React bundle. It replaces the old
 * manual-folder Google Drive subsection (which required pasting a folder link + Apps Script
 * URL + token) with a consumer-style, drive.file flow:
 *   - Connect Google Drive (browser OAuth; main process owns the encrypted refresh token).
 *   - App auto-creates/reuses "NHC Pharmacy Backup/{Automatic,Manual}" (see electron/main.js).
 *   - Backup Now → Manual/. Automatic background backups → Automatic/ (auto-sync-engine.js).
 *   - Drive Backups / Restore (lists BOTH types; safety-backs-up current data first).
 *   - Auto Backup ON/OFF, Disconnect.
 * It lives inside the EXISTING admin-only "Backup & Restore" section (its anchor only renders
 * for a Platform Admin), so a Clinic Admin never sees it; restore additionally re-checks admin.
 * All backup CONTENT/validation/restore reuse the proven logic in auto-sync-engine.js +
 * nhc-backup-policy.js — this file is UI + orchestration only.
 */
(function () {
  'use strict';
  if (window.__nhcCloudBackupLoaded) return;
  window.__nhcCloudBackupLoaded = true;

  // TEMPORARY runtime diagnostics (safe — no tokens/secrets). Remove once UI is confirmed visible.
  function dlog() { try { console.log.apply(console, ['[NHC Cloud Backup UI]'].concat([].slice.call(arguments))); } catch (e) {} }
  dlog('script loaded');
  var lastAnchorWarn = 0;

  var CARD_ID = 'nhc-cloud-backup-card';
  var OLD_SECTION_HEADING = 'Google Drive Account';
  var OLD_SECTION_MARKER = 'Dedicated NHC Google Drive Folder Link'; // unique to the old manual flow

  function api() { return window.electronAPI || null; }
  function el(tag, style, props) { var n = document.createElement(tag); if (style) n.setAttribute('style', style); if (props) Object.keys(props).forEach(function (k) { n[k] = props[k]; }); return n; }
  function toast(msg, kind) {
    var bg = kind === 'error' ? 'var(--danger-strong,#dc2626)' : kind === 'warning' ? 'var(--warning-strong,#d97706)' : 'var(--success-strong,#16a34a)';
    var t = el('div', 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:' + bg + ';color:#fff;font-weight:700;font-size:0.85rem;padding:0.7rem 1.1rem;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.25);max-width:80vw;text-align:center;');
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2800);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3300);
  }
  function overlay() { return el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:16px;'); }
  function panel() { return el('div', 'background:var(--surface,var(--surface-raised,#fff));color:var(--text-primary,#111);border:1px solid var(--border,#e5e7eb);border-radius:14px;width:560px;max-width:100%;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,0.35);'); }
  function btn(label, bg) { return el('button', 'background:' + (bg || '#2563eb') + ';color:#fff;font-weight:800;font-size:0.82rem;padding:0.5rem 0.95rem;border:none;border-radius:8px;cursor:pointer;', { type: 'button', textContent: label }); }
  function outline(label) { return el('button', 'background:transparent;color:var(--text-primary,#111);font-weight:700;font-size:0.8rem;padding:0.45rem 0.85rem;border:1px solid var(--border,#d1d5db);border-radius:8px;cursor:pointer;', { type: 'button', textContent: label }); }
  function closeOnBackdrop(ov) { ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); }); }

  function autoOn() { try { return localStorage.getItem('nhc_auto_cloud_backup') !== 'false'; } catch (_) { return true; } }
  function setAutoOn(v) { try { localStorage.setItem('nhc_auto_cloud_backup', v ? 'true' : 'false'); } catch (_) {} }
  function isAdmin() { try { return window.VHC_CLOUD && window.VHC_CLOUD.isPlatformAdmin ? Promise.resolve(window.VHC_CLOUD.isPlatformAdmin()).then(function (v) { return !!v; }).catch(function () { return false; }) : Promise.resolve(false); } catch (_) { return Promise.resolve(false); } }
  function lastSync() { try { return localStorage.getItem('vhc_last_sync_time'); } catch (_) { return null; } }
  function statusWord() { try { return (window.VHCAutoSync && window.VHCAutoSync.getState) ? window.VHCAutoSync.getState().status : null; } catch (_) { return null; } }
  function fmt(t) { try { return t ? new Date(t).toLocaleString('en-IN') : '—'; } catch (_) { return '—'; } }

  // ---- card rendering ----
  function buildCard() {
    var card = el('div', 'background:var(--surface-raised,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:1.1rem;margin-bottom:1rem;');
    card.id = CARD_ID;
    var head = el('div', 'display:flex;align-items:center;gap:0.6rem;margin-bottom:0.6rem;');
    head.appendChild(el('span', 'font-size:1.3rem;', { textContent: '☁️' }));
    var ht = el('div');
    ht.appendChild(el('h4', 'margin:0;font-size:1rem;color:var(--text-primary,#111);', { textContent: 'Cloud Backup — Google Drive' }));
    ht.appendChild(el('p', 'margin:2px 0 0;font-size:0.78rem;color:var(--text-secondary,#6b7280);', { textContent: 'Automatic + manual backups to your Google account. No folder or file setup needed.' }));
    head.appendChild(ht); card.appendChild(head);
    var bodyWrap = el('div'); bodyWrap.id = CARD_ID + '-body'; card.appendChild(bodyWrap);
    renderBody(bodyWrap);
    return card;
  }

  function row(label, value, strong) {
    var r = el('div', 'display:flex;justify-content:space-between;gap:1rem;font-size:0.82rem;padding:0.2rem 0;');
    r.appendChild(el('span', 'color:var(--text-secondary,#6b7280);', { textContent: label }));
    r.appendChild(el('span', 'color:var(--text-primary,#111);font-weight:' + (strong ? '800' : '600') + ';text-align:right;', { textContent: value }));
    return r;
  }

  function renderBody(wrap) {
    wrap.innerHTML = '';
    if (!api() || !api().driveStatus) { wrap.appendChild(el('p', 'font-size:0.82rem;color:var(--danger-strong,#dc2626);', { textContent: 'Cloud backup is unavailable in this build.' })); return; }
    wrap.appendChild(el('p', 'font-size:0.8rem;color:var(--text-secondary,#6b7280);margin:0 0 0.6rem;', { textContent: 'Checking Google Drive…' }));
    api().driveStatus().then(function (s) {
      wrap.innerHTML = '';
      if (!s || !s.signedIn) {
        wrap.appendChild(el('p', 'font-size:0.82rem;color:var(--text-secondary,#6b7280);margin:0 0 0.8rem;', { textContent: 'Not connected. Connect a Google account to enable cloud backup & restore.' }));
        var connect = btn('🔐 Connect Google Drive', '#0284c7');
        connect.onclick = function () { doConnect(connect, wrap); };
        wrap.appendChild(connect);
        return;
      }
      // Connected view
      var info = el('div', 'background:var(--surface,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:0.7rem 0.9rem;margin-bottom:0.8rem;');
      info.appendChild(row('Connected as', s.email || '—', true));
      info.appendChild(row('Backup folder', s.rootFolderName || 'NHC Pharmacy Backup'));
      info.appendChild(row('Last cloud backup', fmt(lastSync())));
      var st = statusWord();
      var stLabel = st === 'synced' ? 'Synced' : st === 'syncing' ? 'Syncing…' : st === 'pending' ? 'Pending' : st === 'offline' ? 'Offline' : st === 'error' ? 'Failed' : st === 'unconfigured' ? 'Not connected' : '—';
      info.appendChild(row('Status', stLabel, true));
      wrap.appendChild(info);

      var controls = el('div', 'display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;');
      var backupNow = btn('☁️ Backup Now'); backupNow.onclick = function () { doBackupNow(backupNow, wrap); };
      var restore = outline('🗂️ Drive Backups / Restore'); restore.onclick = function () { openRestore(); };
      var disconnect = outline('Disconnect'); disconnect.style.color = 'var(--danger-strong,#dc2626)'; disconnect.onclick = function () { doDisconnect(wrap); };
      controls.appendChild(backupNow); controls.appendChild(restore);
      // Auto toggle
      var toggleWrap = el('label', 'display:inline-flex;align-items:center;gap:0.4rem;font-size:0.8rem;color:var(--text-primary,#111);cursor:pointer;margin-left:0.2rem;');
      var cb = el('input', '', { type: 'checkbox', checked: autoOn() });
      cb.onchange = function () { setAutoOn(cb.checked); toast('Auto backup ' + (cb.checked ? 'ON' : 'OFF') + '.'); };
      toggleWrap.appendChild(cb); toggleWrap.appendChild(document.createTextNode('Auto Backup'));
      controls.appendChild(toggleWrap);
      controls.appendChild(disconnect);
      wrap.appendChild(controls);
    }).catch(function () { wrap.innerHTML = ''; wrap.appendChild(el('p', 'font-size:0.82rem;color:var(--danger-strong,#dc2626);', { textContent: 'Could not check Google Drive status.' })); });
  }

  function refresh() { var w = document.getElementById(CARD_ID + '-body'); if (w) renderBody(w); }

  function doConnect(button, wrap) {
    button.disabled = true; button.textContent = '⏳ Waiting for Google sign-in…';
    api().googleOAuthSignIn().then(function (r) {
      if (!r || !r.success) { toast('Google sign-in failed: ' + ((r && r.error) || 'cancelled'), 'error'); button.disabled = false; button.textContent = '🔐 Connect Google Drive'; return; }
      return api().driveEnsureFolders().then(function (f) {
        if (f && f.success) toast('Google Drive connected as ' + r.email + '.');
        else toast('Connected, but folder setup failed: ' + ((f && f.error) || ''), 'warning');
        refresh();
      });
    }).catch(function (e) { toast('Sign-in failed: ' + e.message, 'error'); button.disabled = false; button.textContent = '🔐 Connect Google Drive'; });
  }

  function doBackupNow(button, wrap) {
    if (!(window.VHCAutoSync && window.VHCAutoSync.getSnapshot)) { toast('Backup engine unavailable.', 'error'); return; }
    button.disabled = true; button.textContent = '⏳ Uploading…';
    var snapshot, content;
    try { snapshot = window.VHCAutoSync.getSnapshot(); content = JSON.stringify(snapshot, null, 2); }
    catch (e) { toast('Could not build backup: ' + e.message, 'error'); button.disabled = false; button.textContent = '☁️ Backup Now'; return; }
    var fileName = 'NHC_POS_Backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    // Also refresh the LOCAL backup so local + cloud stay in step (never destructive).
    if (api().saveGDriveBackup) { try { api().saveGDriveBackup(content, 'NHC_POS_AutoBackup.json'); } catch (_) {} }
    api().driveUploadBackup({ kind: 'Manual', fileName: fileName, content: content }).then(function (r) {
      button.disabled = false; button.textContent = '☁️ Backup Now';
      if (r && r.success) {
        try { localStorage.setItem('vhc_last_sync_time', new Date().toISOString()); } catch (_) {}
        toast('Backup uploaded to Google Drive successfully.'); refresh();
      } else if (r && r.needReconnect) { toast('Please reconnect Google Drive (permission expired).', 'warning'); refresh(); }
      else { toast('Cloud upload failed: ' + ((r && r.error) || 'unknown') + ' (local backup kept).', 'error'); }
    }).catch(function (e) { button.disabled = false; button.textContent = '☁️ Backup Now'; toast('Cloud upload failed: ' + e.message + ' (local backup kept).', 'error'); });
  }

  function doDisconnect(wrap) {
    var ov = overlay(); var p = panel(); p.style.width = '420px';
    var b = el('div', 'padding:1.2rem 1.3rem;');
    b.appendChild(el('h3', 'margin:0 0 0.6rem;font-size:1.05rem;color:var(--text-primary,#111);', { textContent: 'Disconnect Google Drive?' }));
    b.appendChild(el('p', 'margin:0 0 1rem;font-size:0.85rem;color:var(--text-secondary,#6b7280);', { textContent: 'This stops automatic cloud uploads and signs out of Google on this device. Your existing Drive backups and local backups are kept. You can connect another account later.' }));
    var rowb = el('div', 'display:flex;justify-content:flex-end;gap:0.6rem;'); var cancel = outline('Cancel'); var go = btn('Disconnect', '#dc2626');
    rowb.appendChild(cancel); rowb.appendChild(go); b.appendChild(rowb); p.appendChild(b); ov.appendChild(p); document.body.appendChild(ov); closeOnBackdrop(ov);
    cancel.onclick = function () { ov.remove(); };
    go.onclick = function () { api().googleOAuthSignOut().then(function () { ov.remove(); toast('Google Drive disconnected.'); refresh(); }).catch(function (e) { toast('Disconnect failed: ' + e.message, 'error'); }); };
  }

  function openRestore() {
    if (!api().driveListBackups) { toast('Restore unavailable.', 'error'); return; }
    var ov = overlay(); var p = panel();
    var head = el('div', 'display:flex;justify-content:space-between;align-items:center;padding:1.1rem 1.3rem;border-bottom:1px solid var(--border,#e5e7eb);');
    head.appendChild(el('h3', 'margin:0;font-size:1.1rem;color:var(--text-primary,#111);', { textContent: '🗂️ Restore from Google Drive' }));
    var x = el('button', 'background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--text-secondary,#6b7280);', { type: 'button', textContent: '×' }); x.onclick = function () { ov.remove(); };
    head.appendChild(x); p.appendChild(head);
    var body = el('div', 'padding:1.1rem 1.3rem;'); p.appendChild(body);
    body.appendChild(el('p', 'margin:0 0 0.8rem;font-size:0.82rem;color:var(--text-secondary,#6b7280);', { textContent: 'Choose a backup to restore. A safety copy of your CURRENT data is made first. This replaces current local data, then reloads.' }));
    var list = el('div', ''); body.appendChild(list);
    list.appendChild(el('div', 'font-size:0.85rem;color:var(--text-secondary,#6b7280);', { textContent: 'Loading…' }));
    ov.appendChild(p); document.body.appendChild(ov); closeOnBackdrop(ov);

    api().driveListBackups().then(function (res) {
      list.innerHTML = '';
      if (!res || !res.success) { list.appendChild(el('div', 'font-size:0.85rem;color:var(--danger-strong,#dc2626);', { textContent: (res && res.needReconnect) ? 'Please reconnect Google Drive.' : ('Could not list backups: ' + ((res && res.error) || '')) })); return; }
      if (!res.files.length) { list.appendChild(el('div', 'font-size:0.85rem;color:var(--text-secondary,#6b7280);padding:0.8rem;text-align:center;border:1px dashed var(--border,#d1d5db);border-radius:10px;', { textContent: 'No cloud backups found yet.' })); return; }
      res.files.forEach(function (f) {
        var r = el('div', 'display:flex;align-items:center;gap:0.6rem;border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:0.6rem 0.8rem;margin-bottom:0.5rem;');
        var meta = el('div', 'flex:1;min-width:0;');
        var badge = f.type === 'Manual' ? '🟦 Manual' : '🟩 Automatic';
        meta.appendChild(el('div', 'font-weight:700;font-size:0.85rem;color:var(--text-primary,#111);', { textContent: badge + ' · ' + fmt(f.modifiedTime) }));
        meta.appendChild(el('div', 'font-size:0.74rem;color:var(--text-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;', { textContent: f.name + (f.size ? '  ·  ' + Math.round(f.size / 1024) + ' KB' : '') }));
        r.appendChild(meta);
        var pick = btn('Restore'); pick.style.padding = '0.4rem 0.8rem';
        pick.onclick = function () { confirmRestore(f, ov); };
        r.appendChild(pick); list.appendChild(r);
      });
    }).catch(function (e) { list.innerHTML = ''; list.appendChild(el('div', 'font-size:0.85rem;color:var(--danger-strong,#dc2626);', { textContent: 'Error: ' + e.message })); });
  }

  function confirmRestore(file, listOv) {
    isAdmin().then(function (ok) {
      if (!ok) { toast('Only a Platform Admin can restore backups.', 'error'); return; }
      var ov = overlay(); var p = panel(); p.style.width = '440px';
      var b = el('div', 'padding:1.2rem 1.3rem;');
      b.appendChild(el('h3', 'margin:0 0 0.6rem;font-size:1.05rem;color:var(--text-primary,#111);', { textContent: 'Confirm restore' }));
      b.appendChild(el('p', 'margin:0 0 1rem;font-size:0.85rem;color:var(--text-secondary,#6b7280);line-height:1.5;', { textContent: 'Restore ' + (file.type || '') + ' backup from ' + fmt(file.modifiedTime) + ' (' + file.name + ')? A safety copy of current data is saved first. Current local data will be replaced and the app will reload.' }));
      var rowb = el('div', 'display:flex;justify-content:flex-end;gap:0.6rem;'); var cancel = outline('Cancel'); var go = btn('Restore now', '#0369a1');
      rowb.appendChild(cancel); rowb.appendChild(go); b.appendChild(rowb); p.appendChild(b); ov.appendChild(p); document.body.appendChild(ov); closeOnBackdrop(ov);
      cancel.onclick = function () { ov.remove(); };
      go.onclick = function () {
        go.disabled = true; go.textContent = 'Restoring…';
        // Reuse the engine's restore (safety backup + download + validate + apply + reload).
        Promise.resolve(window.VHCAutoSync.restoreFromCloud(file)).catch(function (e) { toast('Restore failed: ' + e.message, 'error'); go.disabled = false; go.textContent = 'Restore now'; });
      };
    });
  }

  // ---- inject into the admin-only Backup & Restore section; hide the old manual Drive block ----
  function findHeading(text) { var hs = document.querySelectorAll('h1,h2,h3,h4,h5'); for (var i = 0; i < hs.length; i++) { if ((hs[i].textContent || '').indexOf(text) !== -1) return hs[i]; } return null; }

  function hideOldSection(anchorHeading) {
    // Walk up from the "Google Drive Account" heading to the smallest ancestor that also contains
    // the old manual "Dedicated NHC Google Drive Folder Link" field, and hide exactly that block.
    var node = anchorHeading;
    for (var i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (node && (node.textContent || '').indexOf(OLD_SECTION_MARKER) !== -1) { node.style.display = 'none'; node.setAttribute('data-nhc-hidden-old-drive', '1'); return node; }
    }
    return null;
  }

  function inject() {
    if (document.getElementById(CARD_ID)) return;
    var anchor = findHeading(OLD_SECTION_HEADING);
    if (!anchor) {
      if (Date.now() - lastAnchorWarn > 5000) { lastAnchorWarn = Date.now(); dlog('"' + OLD_SECTION_HEADING + '" anchor not found yet (open Settings → Backup & Restore as a Platform Admin).'); }
      return; // section not rendered (e.g., Clinic Admin, or not on Settings) → nothing to do
    }
    var oldBlock = hideOldSection(anchor);
    var insertBeforeNode = oldBlock || anchor;
    var parent = insertBeforeNode.parentElement; if (!parent) return;
    var card = buildCard();
    parent.insertBefore(card, insertBeforeNode);
    dlog('Cloud Backup card injected' + (oldBlock ? ' (old manual Drive section hidden).' : '.'));
  }

  var scheduled = false;
  function schedule() { if (scheduled) return; scheduled = true; setTimeout(function () { scheduled = false; try { inject(); } catch (e) {} }, 200); }

  // ---- WhatsApp-style fresh-install restore prompt (after NHC login) ----
  // On a brand-new install there is no local pharmacy data and Drive isn't connected yet, so the
  // engine's own startup check can't offer a restore. This proactively asks (once per session, and
  // only once ever per install via a persistent flag) whether to connect Google Drive and restore a
  // previous backup. Admin-gated; never auto-restores — the user explicitly chooses.
  function hasLocalData() {
    try {
      var inv = localStorage.getItem('pos_inventory') || localStorage.getItem('vhc_pos_inventory');
      var sales = localStorage.getItem('vhc_pos_sales_history');
      var changed = localStorage.getItem('vhc_last_change_time');
      var parse = function (s) { try { return JSON.parse(s) || []; } catch (_) { return []; } };
      return (parse(inv).length > 0) || (parse(sales).length > 0) || !!changed;
    } catch (_) { return true; } // on error, assume data exists (never nag / never risk overwrite)
  }
  function freshPromptDone() { try { return localStorage.getItem('nhc_fresh_restore_prompted') === 'true'; } catch (_) { return true; } }
  function markFreshPromptDone() { try { localStorage.setItem('nhc_fresh_restore_prompted', 'true'); } catch (_) {} }
  function hasSession() { try { return window.VHC_CLOUD && window.VHC_CLOUD.getSession ? Promise.resolve(window.VHC_CLOUD.getSession()).then(function (s) { return !!(s && s.user); }).catch(function () { return false; }) : Promise.resolve(false); } catch (_) { return Promise.resolve(false); } }

  function showFreshInstallPrompt() {
    var ov = overlay(); var p = panel(); p.style.width = '460px';
    var b = el('div', 'padding:1.4rem 1.4rem;');
    var h = el('div', 'display:flex;align-items:center;gap:0.7rem;margin-bottom:0.8rem;');
    h.appendChild(el('div', 'width:44px;height:44px;border-radius:12px;background:#e0f2fe;color:#0284c7;display:flex;align-items:center;justify-content:center;font-size:1.5rem;', { textContent: '☁️' }));
    var ht = el('div');
    ht.appendChild(el('h3', 'margin:0;font-size:1.1rem;font-weight:800;color:var(--text-primary,#0f172a);', { textContent: 'Restore from Google Drive?' }));
    ht.appendChild(el('p', 'margin:2px 0 0;font-size:0.8rem;color:var(--text-secondary,#64748b);', { textContent: 'This device has no pharmacy data yet. If you backed up before, connect Google Drive to restore it.' }));
    h.appendChild(ht); b.appendChild(h);
    var rowb = el('div', 'display:flex;gap:0.6rem;justify-content:flex-end;margin-top:1.2rem;');
    var later = outline('Start Fresh'); var connect = btn('Connect & Restore', '#0284c7');
    rowb.appendChild(later); rowb.appendChild(connect); b.appendChild(rowb);
    p.appendChild(b); ov.appendChild(p); document.body.appendChild(ov);
    later.onclick = function () { ov.remove(); };
    connect.onclick = function () {
      connect.disabled = true; connect.textContent = '⏳ Connecting…';
      api().googleOAuthSignIn().then(function (r) {
        if (!r || !r.success) { toast('Google sign-in failed: ' + ((r && r.error) || 'cancelled'), 'error'); connect.disabled = false; connect.textContent = 'Connect & Restore'; return; }
        return api().driveEnsureFolders().then(function () { return api().driveListBackups(); }).then(function (res) {
          ov.remove();
          if (res && res.success && res.files && res.files.length) { confirmRestore(res.files[0], null); }
          else { toast('Connected. No previous cloud backup found — starting fresh.'); refresh(); }
        });
      }).catch(function (e) { toast('Could not connect: ' + e.message, 'error'); connect.disabled = false; connect.textContent = 'Connect & Restore'; });
    };
  }

  function freshInstallCheck() {
    if (freshPromptDone()) return;
    hasSession().then(function (signedIn) {
      if (!signedIn) return;            // wait until the user has logged into NHC
      if (hasLocalData()) { markFreshPromptDone(); return; } // not a fresh install → never prompt
      isAdmin().then(function (ok) {
        if (!ok) { markFreshPromptDone(); return; } // only the admin is offered a restore
        if (!api() || !api().driveStatus) { markFreshPromptDone(); return; }
        api().driveStatus().then(function (s) {
          markFreshPromptDone(); // show at most once
          if (s && s.signedIn) { try { window.VHCAutoSync && window.VHCAutoSync.checkForNewerCloudBackup(); } catch (_) {} }
          else { showFreshInstallPrompt(); }
        });
      });
    });
  }

  function start() {
    dlog('start · VHC_CLOUD=' + !!window.VHC_CLOUD + ' · electronAPI.driveStatus=' + !!(api() && api().driveStatus) + ' · VHCAutoSync=' + !!window.VHCAutoSync);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
    // Give the app a few seconds to restore its Supabase session after launch, then (once) offer
    // the fresh-install restore. Retries on an interval until a session appears or it's resolved.
    setInterval(freshInstallCheck, 4000);
    setTimeout(freshInstallCheck, 4000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
