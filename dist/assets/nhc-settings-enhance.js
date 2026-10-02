/*
 * NHC Pharmacy — Settings enhancer (add-on)
 * -----------------------------------------
 * Loaded as a plain <script> by dist/index.html (same add-on pattern as nhc-telegram-users.js /
 * nhc-cloud-backup.js), so it needs NO changes to the compiled React bundle. It does two jobs:
 *
 *  1. FUNCTIONAL FIX — the "⚡ Cloud Integrations & Data Sync" section expands to an EMPTY grid in
 *     the shipped bundle (the real Remote Reports Bot sub-section was nested inside an obsolete
 *     @Vhcpharm_bot card that is gated out with `false &&`). This script fills that grid with a
 *     clean integrations layout:
 *       • Telegram Remote Reports card — renders an <h4> containing "Remote Reports Bot", which is
 *         exactly the anchor nhc-telegram-users.js looks for, so the admin-only "👥 Manage Allowed
 *         Users" button is injected by that EXISTING script (no duplication, no second admin login).
 *       • Google Drive Backup card — OAuth connect / status / Backup Now / Manage / Disconnect,
 *         reusing the SAME electronAPI IPC + window.VHCAutoSync engine + localStorage keys that
 *         nhc-cloud-backup.js uses, so there is ONE Google Drive experience.
 *       • Patient & Data Sync card — read-only live status (never changes sync behaviour).
 *
 *  2. VISUAL POLISH — stamps [data-nhc="…"] hooks onto the Settings cards the live inspection
 *     flagged (Appearance, Account, App Details, Admin Tools, Admin Security, accordions) so the
 *     companion stylesheet (nhc-settings-polish.css) can restyle them; converts the always-open
 *     Changelog into a compact expandable; and collapses the Admin Security password field behind
 *     an "Unlock Admin Controls" disclosure WITHOUT changing the existing unlock validation.
 *
 * All DOM created here lives outside React's control and is re-applied defensively (MutationObserver
 * + idempotent id/attribute guards), so a React re-render can never leave it half-applied.
 */
(function () {
  'use strict';
  if (window.__nhcSettingsEnhanceLoaded) return;
  window.__nhcSettingsEnhanceLoaded = true;

  function log() { try { console.log.apply(console, ['[NHC Settings+]'].concat([].slice.call(arguments))); } catch (e) {} }
  function api() { return window.electronAPI || null; }

  function el(tag, style, props) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (props) Object.keys(props).forEach(function (k) { n[k] = props[k]; });
    return n;
  }
  function toast(msg, kind) {
    var bg = kind === 'error' ? 'var(--danger-strong,#dc2626)' : kind === 'warning' ? 'var(--warning-strong,#d97706)' : 'var(--success-strong,#16a34a)';
    var t = el('div', 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:' + bg + ';color:#fff;font-weight:700;font-size:0.85rem;padding:0.7rem 1.1rem;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.25);max-width:80vw;text-align:center;');
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3100);
  }
  function findHeading(re, sel) {
    var hs = document.querySelectorAll(sel || 'h1,h2,h3,h4,h5');
    for (var i = 0; i < hs.length; i++) { if (re.test(hs[i].textContent || '')) return hs[i]; }
    return null;
  }
  function onSettings() { return !!findHeading(/^\s*Settings\s*$/, 'h1') || !!findHeading(/Appearance/, 'h3'); }

  // ---------------------------------------------------------------- visual-polish hooks
  function tagCards() {
    var h;
    if ((h = findHeading(/Appearance/, 'h3'))) {
      var ap = h.closest('.glass-panel');
      if (ap) {
        ap.setAttribute('data-nhc', 'appearance');
        var p = ap.querySelector('p'); if (p) p.setAttribute('data-nhc-el', 'desc');
        var tiles = ap.querySelectorAll('button');
        for (var i = 0; i < tiles.length; i++) {
          var tt = tiles[i].textContent || '';
          if (/Light Mode|Dark Mode/.test(tt)) tiles[i].setAttribute('data-nhc', 'appearance-tile');
        }
      }
    }
    // Account card = the one containing "Signed in as"
    var acc = null, divs = document.querySelectorAll('.glass-panel');
    for (var a = 0; a < divs.length; a++) { if (/Signed in as/i.test(divs[a].textContent || '') && (divs[a].textContent || '').length < 120) { acc = divs[a]; break; } }
    if (acc) acc.setAttribute('data-nhc', 'account');
    if ((h = findHeading(/App Details/, 'h3'))) {
      var ad = h.closest('.glass-panel');
      if (ad) {
        ad.setAttribute('data-nhc', 'appdetails');
        var g = ad.querySelector('div[style*="grid"]'); if (g) g.setAttribute('data-nhc-el', 'grid');
      }
    }
    if ((h = findHeading(/Admin Security Unlock|Pharmacy & Stock Admin Settings/, 'h3'))) {
      var as = h.closest('.glass-panel'); if (as) as.setAttribute('data-nhc', 'admin-security');
    }
    // Admin tools gradient buttons
    var btns = document.querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) {
      var bt = btns[b].textContent || '';
      if (/Backup & Restore/.test(bt) && /Local, Google Drive/.test(bt)) {
        btns[b].setAttribute('data-nhc', 'tool-backup');
        var row = btns[b].parentElement; if (row) row.setAttribute('data-nhc', 'admin-tools');
      } else if (/Stock Audit/.test(bt) && /movement history/.test(bt)) {
        btns[b].setAttribute('data-nhc', 'tool-stock');
      }
    }
    // Accordion cards (collapsed-height polish)
    var acc2 = findHeading(/Pharmacy Details & General Configuration/, 'h3');
    if (acc2) { var c1 = acc2.closest('.glass-panel'); if (c1) c1.setAttribute('data-nhc', 'accordion'); }
    var acc3 = findHeading(/Cloud Integrations & Data Sync/, 'h3');
    if (acc3) { var c2 = acc3.closest('.glass-panel'); if (c2) c2.setAttribute('data-nhc', 'accordion'); }
  }

  // ---------------------------------------------------------------- changelog accordion
  var changelogOpen = false;
  function applyChangelog() {
    var h4 = findHeading(/Changelog — v/, 'h4');
    if (!h4) return;
    var ul = h4.nextElementSibling;
    if (!ul || ul.tagName !== 'UL') return;
    if (document.getElementById('nhc-changelog-head')) {
      // already built — just keep visibility in sync with our state
      ul.style.display = changelogOpen ? '' : 'none';
      return;
    }
    h4.style.display = 'none';
    var ver = (h4.textContent.match(/v[\d.]+/) || ['v3.18.3'])[0];
    var head = el('div', null, { id: 'nhc-changelog-head' });
    head.setAttribute('data-nhc-el', 'changelog-head');
    head.appendChild(document.createTextNode('📋 What’s New in ' + ver));
    var toggle = el('span', null, { textContent: 'View' });
    toggle.setAttribute('data-nhc-el', 'changelog-toggle');
    toggle.onclick = function () {
      changelogOpen = !changelogOpen;
      ul.style.display = changelogOpen ? '' : 'none';
      toggle.textContent = changelogOpen ? 'Hide' : 'View';
    };
    head.appendChild(toggle);
    h4.parentNode.insertBefore(head, h4);
    ul.style.display = changelogOpen ? '' : 'none';
  }

  // ---------------------------------------------------------------- admin-security disclosure
  var adminRevealed = false;
  function applyAdminSecurity() {
    var card = document.querySelector('[data-nhc="admin-security"]');
    if (!card) return;
    // Only the LOCKED state has a password field; when unlocked the card shows the admin tools
    // (never touch those). Find the admin-password input + its Unlock button.
    var inputs = card.querySelectorAll('input');
    var pwd = null;
    for (var i = 0; i < inputs.length; i++) { if (/admin password/i.test(inputs[i].placeholder || '') || inputs[i].type === 'password') { pwd = inputs[i]; break; } }
    if (!pwd) { // unlocked state → make sure any leftover disclosure is gone, then leave as-is
      var leftover = document.getElementById('nhc-sec-locked'); if (leftover && leftover.parentNode) leftover.parentNode.removeChild(leftover);
      return;
    }
    var unlockBtn = null, btns = card.querySelectorAll('button');
    for (var b = 0; b < btns.length; b++) {
      var bt = btns[b].textContent || '';
      // The React unlock button is exactly "Unlock Admin"; exclude our own disclosure button
      // ("Unlock Admin Controls") so we never hide it by mistake.
      if (/unlock admin/i.test(bt) && !/controls/i.test(bt) && !btns[b].hasAttribute('data-nhc-el')) { unlockBtn = btns[b]; break; }
    }
    // The row that holds the password input (its input-group), hidden/shown as one unit. Prefer a
    // tight wrapper so we never hide the whole card.
    var group = pwd.closest('.input-group') || pwd.parentElement || pwd;
    var existing = document.getElementById('nhc-sec-locked');

    if (adminRevealed) {
      group.style.display = '';
      if (unlockBtn) unlockBtn.style.display = '';
      if (existing) existing.style.display = 'none';
      return;
    }
    // locked: hide the real input row + its Unlock button, show our disclosure
    group.style.display = 'none';
    if (unlockBtn && !group.contains(unlockBtn)) unlockBtn.style.display = 'none';
    if (existing) { existing.style.display = 'block'; return; }
    var wrap = el('div', null, { id: 'nhc-sec-locked' }); wrap.style.display = 'block';
    var note = el('div', null, { textContent: '🔒 Administrative controls are locked.' });
    note.setAttribute('data-nhc-el', 'sec-locked-note');
    var ubtn = el('button', null, { type: 'button' });
    ubtn.setAttribute('data-nhc-el', 'sec-unlock-btn');
    ubtn.appendChild(document.createTextNode('🔓 Unlock Admin Controls'));
    ubtn.onclick = function () { adminRevealed = true; applyAdminSecurity(); try { pwd.focus(); } catch (e) {} };
    wrap.appendChild(note); wrap.appendChild(ubtn);
    // Insert as a DIRECT child of the card, just before the block that contains the (now hidden)
    // input row — so our disclosure can never land inside a hidden ancestor.
    var topBlock = group; while (topBlock.parentElement && topBlock.parentElement !== card) topBlock = topBlock.parentElement;
    if (topBlock.parentElement === card) card.insertBefore(wrap, topBlock); else card.appendChild(wrap);
  }

  // ---------------------------------------------------------------- Cloud Integrations content
  function ciGrid() {
    var h = findHeading(/Cloud Integrations & Data Sync/, 'h3');
    if (!h) return null;
    var card = h.closest('.glass-panel'); if (!card) return null;
    var body = card.querySelector('.animate-fade-in'); if (!body) return null; // collapsed
    return body.firstElementChild || null; // the display:grid container
  }

  // --- Telegram card ---
  var tgStatus = {};
  var tgSubscribed = false;
  function tgMeta(state) {
    return ({
      starting: { label: 'Starting…', color: '#f59e0b' },
      running: { label: 'Connected', color: '#059669' },
      error: { label: 'Error — retrying', color: '#ea580c' },
      disconnected: { label: 'Disconnected', color: 'var(--danger-hover,#dc2626)' },
      stopped: { label: 'Waiting', color: 'var(--text-soft,#64748b)' },
    })[state] || { label: 'Unavailable', color: 'var(--text-soft,#64748b)' };
  }
  function paintTg() {
    var node = document.getElementById('nhc-ci-tg-status'); if (!node) return;
    var m = tgMeta(tgStatus.state);
    node.innerHTML = '';
    var dot = el('span', null, { className: 'nhc-ci-dot' }); dot.style.background = m.color;
    node.appendChild(dot);
    node.appendChild(document.createTextNode(' Service: ' + m.label));
    node.style.color = m.color;
  }
  function refreshTg() {
    if (!(api() && api().getTelegramBotStatus)) return;
    api().getTelegramBotStatus().then(function (s) { tgStatus = s || {}; paintTg(); }).catch(function () {});
    if (!tgSubscribed && api().onTelegramBotStatusChanged) {
      tgSubscribed = true;
      try { api().onTelegramBotStatusChanged(function (s) { tgStatus = s || {}; paintTg(); }); } catch (e) {}
    }
  }
  function buildTelegramCard() {
    var card = el('div', null, { className: 'nhc-ci-card', id: 'nhc-ci-telegram-card' });
    // NOTE: this <h4> text ("Remote Reports Bot") is the exact anchor nhc-telegram-users.js
    // searches for; it injects the admin-only "Manage Allowed Users" button into this card.
    var h4 = el('h4', null); h4.appendChild(document.createTextNode('📊 Remote Reports Bot (@NHCPharmacybot)'));
    card.appendChild(h4);
    var status = el('span', null, { id: 'nhc-ci-tg-status', className: 'nhc-ci-statusline' });
    status.appendChild(el('span', null, { className: 'nhc-ci-dot' }));
    status.appendChild(document.createTextNode(' Service: …'));
    card.appendChild(status);
    card.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Daily OP-close reports and on-demand /report, /today, /inventory, /expiry, /backup, /credit commands.' }));
    return card;
  }

  // --- Google Drive card (reuses electronAPI + window.VHCAutoSync; one Drive experience) ---
  function autoOn() { try { return localStorage.getItem('nhc_auto_cloud_backup') !== 'false'; } catch (e) { return true; } }
  function setAutoOn(v) { try { localStorage.setItem('nhc_auto_cloud_backup', v ? 'true' : 'false'); } catch (e) {} }
  function lastSync() { try { return localStorage.getItem('vhc_last_sync_time'); } catch (e) { return null; } }
  function fmt(t) { try { return t ? new Date(t).toLocaleString('en-IN') : '—'; } catch (e) { return '—'; } }
  function ciBtn(label, kind) {
    var b = el('button', null, { type: 'button', className: 'nhc-ci-btn ' + (kind === 'primary' ? 'nhc-ci-btn-primary' : 'nhc-ci-btn-outline') });
    b.textContent = label; return b;
  }
  function openBackupManager() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) { var t = btns[i].textContent || ''; if (/Backup & Restore/.test(t) && /Local, Google Drive/.test(t)) { btns[i].click(); return true; } }
    return false;
  }
  function driveBackupNow(button) {
    if (!(window.VHCAutoSync && window.VHCAutoSync.getSnapshot)) { toast('Backup engine unavailable.', 'error'); return; }
    button.disabled = true; var old = button.textContent; button.textContent = '⏳ Uploading…';
    var content;
    try { content = JSON.stringify(window.VHCAutoSync.getSnapshot(), null, 2); }
    catch (e) { toast('Could not build backup: ' + e.message, 'error'); button.disabled = false; button.textContent = old; return; }
    var fileName = 'NHC_POS_Backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    if (api().saveGDriveBackup) { try { api().saveGDriveBackup(content, 'NHC_POS_AutoBackup.json'); } catch (e) {} }
    api().driveUploadBackup({ kind: 'Manual', fileName: fileName, content: content }).then(function (r) {
      button.disabled = false; button.textContent = old;
      if (r && r.success) { try { localStorage.setItem('vhc_last_sync_time', new Date().toISOString()); } catch (e) {} toast('Backup uploaded to Google Drive.'); renderDrive(); }
      else if (r && r.needReconnect) { toast('Please reconnect Google Drive (permission expired).', 'warning'); renderDrive(); }
      else { toast('Cloud upload failed: ' + ((r && r.error) || 'unknown') + ' (local backup kept).', 'error'); }
    }).catch(function (e) { button.disabled = false; button.textContent = old; toast('Cloud upload failed: ' + e.message, 'error'); });
  }
  function driveConnect(button) {
    button.disabled = true; button.textContent = '⏳ Waiting for Google sign-in…';
    api().googleOAuthSignIn().then(function (r) {
      if (!r || !r.success) { toast('Google sign-in failed: ' + ((r && r.error) || 'cancelled'), 'error'); renderDrive(); return; }
      return (api().driveEnsureFolders ? api().driveEnsureFolders() : Promise.resolve()).then(function () { toast('Google Drive connected as ' + r.email + '.'); renderDrive(); });
    }).catch(function (e) { toast('Sign-in failed: ' + e.message, 'error'); renderDrive(); });
  }
  function driveDisconnect() {
    if (!api().googleOAuthSignOut) return;
    api().googleOAuthSignOut().then(function () { toast('Google Drive disconnected.'); renderDrive(); }).catch(function (e) { toast('Disconnect failed: ' + e.message, 'error'); });
  }
  function renderDrive() {
    var wrap = document.getElementById('nhc-ci-drive-body'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!(api() && api().driveStatus)) { wrap.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Cloud backup is unavailable in this build.' })); return; }
    wrap.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Checking Google Drive…' }));
    api().driveStatus().then(function (s) {
      wrap.innerHTML = '';
      if (!s || !s.signedIn) {
        wrap.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Secure cloud backup & restore. No folder or file setup needed.' }));
        var connect = ciBtn('🔐 Connect Google Drive', 'primary');
        connect.onclick = function () { driveConnect(connect); };
        var act = el('div', null, { className: 'nhc-ci-actions' }); act.appendChild(connect); wrap.appendChild(act);
        return;
      }
      var statusLine = el('span', null, { className: 'nhc-ci-statusline' });
      var dot = el('span', null, { className: 'nhc-ci-dot' }); dot.style.background = '#059669'; statusLine.appendChild(dot);
      statusLine.appendChild(document.createTextNode(' Connected')); statusLine.style.color = '#059669';
      wrap.appendChild(statusLine);
      var r1 = el('div', null, { className: 'nhc-ci-row' }); r1.appendChild(el('span', null, { textContent: 'Account' })); r1.appendChild(el('span', null, { textContent: s.email || '—' })); wrap.appendChild(r1);
      var r2 = el('div', null, { className: 'nhc-ci-row' }); r2.appendChild(el('span', null, { textContent: 'Last backup' })); r2.appendChild(el('span', null, { textContent: fmt(lastSync()) })); wrap.appendChild(r2);
      var toggle = el('label', null, { className: 'nhc-ci-toggle' });
      var cb = el('input', null, { type: 'checkbox', checked: autoOn() });
      cb.onchange = function () { setAutoOn(cb.checked); toast(cb.checked ? 'Automatic cloud backup ON.' : 'Automatic cloud backup OFF.'); };
      toggle.appendChild(cb); toggle.appendChild(document.createTextNode('Auto Backup')); wrap.appendChild(toggle);
      var act = el('div', null, { className: 'nhc-ci-actions' });
      var backupNow = ciBtn('☁️ Backup Now', 'primary'); backupNow.onclick = function () { driveBackupNow(backupNow); };
      var manage = ciBtn('🗂️ Manage Backups', 'outline'); manage.onclick = function () { if (!openBackupManager()) toast('Open Backup & Restore to manage backups.', 'warning'); };
      var disconnect = ciBtn('Disconnect', 'outline'); disconnect.onclick = function () { driveDisconnect(); };
      act.appendChild(backupNow); act.appendChild(manage); act.appendChild(disconnect); wrap.appendChild(act);
    }).catch(function () { wrap.innerHTML = ''; wrap.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Could not check Google Drive status.' })); });
  }
  function buildDriveCard() {
    var card = el('div', null, { className: 'nhc-ci-card', id: 'nhc-ci-drive-card' });
    var h4 = el('h4', null); h4.appendChild(document.createTextNode('☁️ Google Drive Backup')); card.appendChild(h4);
    card.appendChild(el('div', null, { id: 'nhc-ci-drive-body' }));
    return card;
  }

  // --- Patient & Data Sync card (status only) ---
  function buildPatientSyncCard() {
    var card = el('div', null, { className: 'nhc-ci-card', id: 'nhc-ci-sync-card' });
    var h4 = el('h4', null); h4.appendChild(document.createTextNode('🔄 Patient & Data Sync')); card.appendChild(h4);
    var online = (typeof navigator !== 'undefined') ? navigator.onLine : true;
    var hasCloud = !!window.VHC_CLOUD;
    var statusLine = el('span', null, { id: 'nhc-ci-sync-status', className: 'nhc-ci-statusline' });
    var color = (online && hasCloud) ? '#059669' : 'var(--text-soft,#64748b)';
    var dot = el('span', null, { className: 'nhc-ci-dot' }); dot.style.background = color; statusLine.appendChild(dot);
    statusLine.appendChild(document.createTextNode((online && hasCloud) ? ' Live — cloud sync active' : (online ? ' Connecting…' : ' Offline — will sync when back online')));
    statusLine.style.color = color;
    card.appendChild(statusLine);
    card.appendChild(el('p', null, { className: 'nhc-ci-sub', textContent: 'Sales, inventory and patients sync automatically across devices via the NHC cloud. Local-first — billing keeps working offline and syncs on reconnect.' }));
    return card;
  }

  function fillCloudIntegrations() {
    var grid = ciGrid(); if (!grid) return;
    if (grid.querySelector('#nhc-ci-telegram-card')) { refreshTg(); return; } // already filled
    grid.appendChild(buildTelegramCard());
    grid.appendChild(buildDriveCard());
    grid.appendChild(buildPatientSyncCard());
    log('Cloud Integrations grid populated (Telegram + Google Drive + Patient Sync).');
    refreshTg();
    renderDrive();
  }

  // ---------------------------------------------------------------- scheduler
  var scheduled = false;
  function applyAll() {
    if (!onSettings()) return;
    try { tagCards(); } catch (e) {}
    try { applyChangelog(); } catch (e) {}
    try { applyAdminSecurity(); } catch (e) {}
    try { fillCloudIntegrations(); } catch (e) {}
  }
  function schedule() { if (scheduled) return; scheduled = true; setTimeout(function () { scheduled = false; try { applyAll(); } catch (e) {} }, 180); }

  function start() {
    log('start · electronAPI=' + !!api() + ' · VHCAutoSync=' + !!window.VHCAutoSync + ' · VHC_CLOUD=' + !!window.VHC_CLOUD);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
    setInterval(function () { try { applyAll(); } catch (e) {} }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
