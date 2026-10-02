/*
 * NHC Pharmacy — Telegram Allowed-User Management (Settings add-on)
 * ----------------------------------------------------------------
 * Loaded as a plain <script> by dist/index.html (same pattern as nhc-backup-policy.js /
 * vhc-cloud-sync.js), so it needs NO changes to the compiled React bundle. It:
 *   1. Shows a "👥 Manage Allowed Users" button inside the existing "Remote Reports Bot
 *      (@NHCPharmacybot)" Settings card ONLY for a Platform Admin.
 *   2. Uses the app's EXISTING, server-verified authorization —
 *      window.VHC_CLOUD.isPlatformAdmin() (reads profiles.is_platform_admin under RLS, fails
 *      closed). There is NO separate Telegram admin login / re-authentication: the Platform
 *      Admin signs into NHC Pharmacy normally, exactly like the native Danger Zone.
 *   3. For a Clinic Admin / normal client the button is COMPLETELY ABSENT — never shown,
 *      never disabled, no lock icon, no hint the feature exists.
 *   4. Re-verifies on session/account change: sign-out or switching to a non-admin account
 *      removes the button immediately, and it only reappears once the NEW session is verified
 *      as Platform Admin (admin=true is never carried across a different session).
 *   5. Lets the admin view / add / edit / remove allowed Telegram users (numeric IDs,
 *      de-duplicated, optional name/note) and Save via secure IPC — which the main process
 *      ALSO re-authorizes server-side before writing. The bot picks up changes within seconds
 *      (it re-reads its config each poll); no app or bot restart.
 *
 * All DOM this creates lives OUTSIDE React's control (button re-injected defensively; modals
 * appended to <body>), so it cannot disturb React's reconciliation of the real app.
 */
(function () {
  'use strict';
  if (window.__nhcTelegramUsersLoaded) return;
  window.__nhcTelegramUsersLoaded = true;

  // TEMPORARY runtime diagnostics (safe — logs no tokens/secrets). Open DevTools console to see
  // whether this script loaded, whether VHC_CLOUD/electronAPI are present, the isPlatformAdmin
  // result, and whether the button was injected. Remove once the UI is confirmed visible.
  function dlog() { try { console.log.apply(console, ['[NHC Telegram UI]'].concat([].slice.call(arguments))); } catch (e) {} }
  dlog('script loaded');
  var lastAnchorWarn = 0;

  var BTN_ID = 'nhc-manage-tg-users-btn';
  var CARD_HEADING_MATCH = 'Remote Reports Bot'; // matches "📊 Remote Reports Bot (@NHCPharmacybot)"

  function api() { return window.electronAPI || null; }

  // ---- small themed DOM helpers -------------------------------------------------
  function el(tag, style, props) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (props) Object.keys(props).forEach(function (k) { n[k] = props[k]; });
    return n;
  }
  function toast(msg, kind) {
    var bg = kind === 'error' ? 'var(--danger-strong, #dc2626)'
      : kind === 'warning' ? 'var(--warning-strong, #d97706)'
      : 'var(--success-strong, #16a34a)';
    var t = el('div', 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + 'background:' + bg + ';color:#fff;font-weight:700;font-size:0.85rem;padding:0.7rem 1.1rem;'
      + 'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.25);max-width:80vw;text-align:center;');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3100);
  }
  function overlay() {
    return el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.5);'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;');
  }
  function panel() {
    return el('div', 'background:var(--surface, var(--surface-raised, #fff));color:var(--text-primary,#111);'
      + 'border:1px solid var(--border,#e5e7eb);border-radius:14px;width:520px;max-width:100%;'
      + 'max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,0.35);');
  }
  function primaryBtn(label) {
    return el('button', 'background:#2563eb;color:#fff;font-weight:800;font-size:0.85rem;'
      + 'padding:0.55rem 1rem;border:none;border-radius:8px;cursor:pointer;', { type: 'button', textContent: label });
  }
  function outlineBtn(label) {
    return el('button', 'background:transparent;color:var(--text-primary,#111);font-weight:700;font-size:0.82rem;'
      + 'padding:0.5rem 0.9rem;border:1px solid var(--border,#d1d5db);border-radius:8px;cursor:pointer;',
      { type: 'button', textContent: label });
  }
  function input(placeholder, value) {
    return el('input', 'width:100%;box-sizing:border-box;padding:0.55rem 0.7rem;font-size:0.9rem;'
      + 'border:1px solid var(--border,#d1d5db);border-radius:8px;background:var(--surface-raised,#fff);'
      + 'color:var(--text-primary,#111);', { type: 'text', placeholder: placeholder || '', value: value || '' });
  }
  function closeOnBackdrop(ov) { ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); }); }

  // ---- user manager modal (opened only from the admin-only button) --------------
  function openManager() {
    if (!api() || !api().getTelegramAllowedUsers) { toast('Telegram management is unavailable in this build.', 'error'); return; }
    api().getTelegramAllowedUsers().then(function (res) {
      var users = (res && res.success && Array.isArray(res.users)) ? res.users.map(function (u) { return { id: String(u.id), name: u.name || '' }; }) : [];
      renderManager(users);
    }).catch(function (e) { toast('Failed to load users: ' + e.message, 'error'); });
  }

  function renderManager(users) {
    var ov = overlay(); var p = panel();
    var head = el('div', 'display:flex;justify-content:space-between;align-items:center;padding:1.1rem 1.3rem;border-bottom:1px solid var(--border,#e5e7eb);');
    head.appendChild(el('h3', 'margin:0;font-size:1.1rem;color:var(--text-primary,#111);', { textContent: '👥 Telegram Access' }));
    var x = el('button', 'background:none;border:none;font-size:1.3rem;line-height:1;cursor:pointer;color:var(--text-secondary,#6b7280);', { type: 'button', textContent: '×' });
    x.onclick = function () { ov.remove(); };
    head.appendChild(x); p.appendChild(head);

    var body = el('div', 'padding:1.1rem 1.3rem;');
    body.appendChild(el('p', 'margin:0 0 0.9rem;font-size:0.82rem;color:var(--text-secondary,#6b7280);',
      { textContent: 'These Telegram users may use the NHC Pharmacy bot. IDs are numeric — a user can send /whoami to @NHCPharmacybot to find theirs.' }));
    var list = el('div', ''); body.appendChild(list);

    function draw() {
      list.innerHTML = '';
      if (!users.length) {
        list.appendChild(el('div', 'padding:0.9rem;text-align:center;color:var(--text-secondary,#6b7280);font-size:0.85rem;border:1px dashed var(--border,#d1d5db);border-radius:10px;',
          { textContent: 'No allowed users yet. Add one below.' }));
      }
      users.forEach(function (u, i) {
        var rowc = el('div', 'display:flex;align-items:center;gap:0.6rem;background:var(--surface-raised,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:0.6rem 0.8rem;margin-bottom:0.55rem;');
        var info = el('div', 'flex:1;min-width:0;');
        info.appendChild(el('div', 'font-weight:700;font-size:0.9rem;color:var(--text-primary,#111);overflow:hidden;text-overflow:ellipsis;', { textContent: u.name || '(no name)' }));
        info.appendChild(el('div', 'font-size:0.8rem;color:var(--text-secondary,#6b7280);', { textContent: u.id }));
        rowc.appendChild(info);
        var edit = outlineBtn('Edit'); edit.style.padding = '0.35rem 0.7rem'; edit.style.fontSize = '0.78rem';
        var del = outlineBtn('Remove'); del.style.padding = '0.35rem 0.7rem'; del.style.fontSize = '0.78rem';
        del.style.color = 'var(--danger-strong,#dc2626)'; del.style.borderColor = 'var(--danger-border,#fecaca)';
        edit.onclick = function () { openEditor(u, function (updated) { users[i] = updated; draw(); }); };
        del.onclick = function () { users.splice(i, 1); draw(); };
        rowc.appendChild(edit); rowc.appendChild(del);
        list.appendChild(rowc);
      });
    }
    draw();

    var addBtn = outlineBtn('+ Add User'); addBtn.style.marginTop = '0.3rem';
    addBtn.onclick = function () { openEditor(null, function (created) { users.push(created); draw(); }); };
    body.appendChild(addBtn);
    p.appendChild(body);

    var foot = el('div', 'display:flex;justify-content:flex-end;gap:0.7rem;padding:1rem 1.3rem;border-top:1px solid var(--border,#e5e7eb);');
    var cancel = outlineBtn('Cancel'); cancel.onclick = function () { ov.remove(); };
    var save = primaryBtn('Save Changes');
    save.onclick = function () {
      save.disabled = true; save.textContent = 'Saving…';
      api().saveTelegramAllowedUsers(users.map(function (u) { return { id: u.id, name: u.name }; }))
        .then(function (r) {
          if (r && r.success) { ov.remove(); toast('Telegram access updated successfully.'); }
          else { toast(r && r.error ? r.error : 'Save failed.', 'error'); save.disabled = false; save.textContent = 'Save Changes'; }
        })
        .catch(function (e) { toast('Save failed: ' + e.message, 'error'); save.disabled = false; save.textContent = 'Save Changes'; });
    };
    foot.appendChild(cancel); foot.appendChild(save); p.appendChild(foot);

    ov.appendChild(p); document.body.appendChild(ov); closeOnBackdrop(ov);
  }

  function openEditor(existing, onDone) {
    var ov = overlay(); var p = panel(); p.style.width = '420px';
    var body = el('div', 'padding:1.2rem 1.3rem;');
    body.appendChild(el('h3', 'margin:0 0 1rem;font-size:1.05rem;color:var(--text-primary,#111);',
      { textContent: existing ? 'Edit User' : 'Add User' }));
    body.appendChild(el('label', 'display:block;font-size:0.78rem;font-weight:700;margin:0 0 0.25rem;color:var(--text-secondary,#6b7280);', { textContent: 'Telegram User ID (numeric)' }));
    var idIn = input('e.g. 733453718', existing ? existing.id : ''); idIn.inputMode = 'numeric';
    body.appendChild(idIn);
    body.appendChild(el('label', 'display:block;font-size:0.78rem;font-weight:700;margin:0.8rem 0 0.25rem;color:var(--text-secondary,#6b7280);', { textContent: 'Name / note (optional)' }));
    var nameIn = input('e.g. Arun', existing ? existing.name : '');
    body.appendChild(nameIn);
    var row = el('div', 'display:flex;justify-content:flex-end;gap:0.6rem;margin-top:1.3rem;');
    var cancel = outlineBtn('Cancel'); var ok = primaryBtn(existing ? 'Update' : 'Add');
    row.appendChild(cancel); row.appendChild(ok); body.appendChild(row);
    p.appendChild(body); ov.appendChild(p); document.body.appendChild(ov); idIn.focus();
    cancel.onclick = function () { ov.remove(); };
    ok.onclick = function () {
      var id = (idIn.value || '').trim();
      if (!/^\d{5,15}$/.test(id)) { toast('Telegram User ID must be numeric (6–10 digits).', 'warning'); return; }
      ov.remove();
      onDone({ id: id, name: (nameIn.value || '').trim().slice(0, 60) });
    };
    closeOnBackdrop(ov);
  }

  // ---- button injection / removal ----------------------------------------------
  function findBotCardHeading() {
    var hs = document.querySelectorAll('h4');
    for (var i = 0; i < hs.length; i++) {
      if ((hs[i].textContent || '').indexOf(CARD_HEADING_MATCH) !== -1) return hs[i];
    }
    return null;
  }
  function injectButton() {
    if (document.getElementById(BTN_ID)) return; // already present (idempotent)
    var heading = findBotCardHeading();
    if (!heading) {
      // Diagnostic: we're a verified admin but the "Remote Reports Bot" card isn't in the DOM yet
      // (user may not be on Settings → Remote Reports Bot). Throttled so it doesn't flood.
      if (adminForSession && Date.now() - lastAnchorWarn > 5000) { lastAnchorWarn = Date.now(); dlog('admin OK, but "Remote Reports Bot" card not found in DOM yet (open Settings → Remote Reports Bot).'); }
      return;
    }
    var container = heading.parentElement || heading;
    var wrap = el('div', 'margin-top:0.9rem;');
    var btn = primaryBtn('👥 Manage Allowed Users');
    btn.id = BTN_ID;
    btn.style.background = 'var(--info-strong, #2563eb)';
    btn.onclick = function () { openManager(); }; // no re-auth: the button only exists for admins
    wrap.appendChild(btn);
    container.appendChild(wrap);
    dlog('Manage Allowed Users button injected.');
  }
  function removeButton() {
    var b = document.getElementById(BTN_ID);
    if (!b) return;
    var wrap = b.parentNode;
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    else if (b.parentNode) b.parentNode.removeChild(b);
  }

  // ---- session-aware Platform Admin gating -------------------------------------
  // adminForSession is ONLY ever true for the exact sessionUserId it was verified against; any
  // change of user (including sign-out → null) resets it to false and hides the button until the
  // NEW session is re-verified. admin=true is never carried across a different session.
  var sessionUserId;            // undefined = never checked; null = signed out; string = current user id
  var adminForSession = false;  // server-verified admin status for sessionUserId
  var adminResolved = false;    // true once the admin check returned a DEFINITIVE answer for this session

  function getCurrentUserId() {
    try {
      if (window.VHC_CLOUD && window.VHC_CLOUD.getSession) {
        return Promise.resolve(window.VHC_CLOUD.getSession())
          .then(function (s) { return s && s.user ? s.user.id : null; })
          .catch(function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }
  function enforceVisibility() {
    if (adminForSession) injectButton(); else removeButton();
  }
  // Verifies the CURRENT session's admin status. A definitive result (true/false) sets
  // adminResolved so we stop re-querying; a thrown error leaves it UNRESOLVED and fails closed
  // (button hidden), so a later tick retries — a transient network error can't permanently lock
  // a genuine admin out of the feature for the rest of their session.
  function verifyAdminForCurrentSession(uid) {
    if (!(window.VHC_CLOUD && window.VHC_CLOUD.isPlatformAdmin)) { adminForSession = false; return Promise.resolve(); }
    return Promise.resolve(window.VHC_CLOUD.isPlatformAdmin()).then(function (v) {
      if (sessionUserId === uid) { adminForSession = !!v; adminResolved = true; dlog('isPlatformAdmin for current session =', !!v); enforceVisibility(); }
    }).catch(function () {
      if (sessionUserId === uid) { adminForSession = false; adminResolved = false; enforceVisibility(); } // fail closed, retry next tick
    });
  }
  function refreshAuthState() {
    return getCurrentUserId().then(function (uid) {
      if (uid !== sessionUserId) {
        // Session/account changed (sign-in, sign-out, or switch to a different user).
        sessionUserId = uid;
        adminForSession = false;   // never carry a previous admin=true into a new/other session
        adminResolved = false;
        removeButton();            // hide immediately until the new session is verified
        if (!uid) return;          // signed out → stay hidden
        return verifyAdminForCurrentSession(uid);
      }
      // Same session: if a previous check errored (unresolved), retry it; otherwise just keep
      // the button state matching the known admin status (e.g. after navigating into Settings).
      if (uid && !adminResolved) return verifyAdminForCurrentSession(uid);
      enforceVisibility();
    }).catch(function () {
      // Fail closed on any error resolving the session.
      sessionUserId = null; adminForSession = false; adminResolved = false; removeButton();
    });
  }

  // DOM changes (navigation, React re-renders) → cheap, synchronous visibility enforcement using
  // the already-known admin state. It never injects for a non-admin because adminForSession is
  // false until a session is verified. The async session/role re-check runs on its own interval.
  var enforceScheduled = false;
  function scheduleEnforce() {
    if (enforceScheduled) return; enforceScheduled = true;
    setTimeout(function () { enforceScheduled = false; try { enforceVisibility(); } catch (e) {} }, 150);
  }

  function start() {
    dlog('start · VHC_CLOUD=' + !!window.VHC_CLOUD + ' · electronAPI.getTelegramAllowedUsers=' + !!(api() && api().getTelegramAllowedUsers));
    new MutationObserver(scheduleEnforce).observe(document.body, { childList: true, subtree: true });
    refreshAuthState();                 // initial check
    setInterval(refreshAuthState, 3000); // catch login/logout/account-switch
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
