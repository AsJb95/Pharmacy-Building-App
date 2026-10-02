// Long-running interactive bot: polls Telegram for messages, answers authorized admin
// commands, enforces the user-ID allowlist, shows a persistent quick-action keyboard, and
// also fires the scheduled "OP close" report automatically at configured times.
//
// This copy (telegram-bot/bot.js) is the one that ships inside the NHC Pharmacy POS
// installer: the Electron main process (electron/main.js) forks it as a
// child process automatically on app startup and manages its lifecycle (restart on
// crash, clean shutdown on Exit). It reports its own status back to the parent process
// over the fork IPC channel (see sendStatus() below) whenever process.send is available,
// and degrades to plain console logging when it isn't (e.g. run standalone with `node
// bot.js` for local debugging — still fully supported).
//
// Usage: node bot.js  (standalone/dev) — or forked by electron/main.js (production).

const { loadConfig, CONFIG_PATH } = require('./lib/config');
const fs = require('fs');
const path = require('path');
const { getUpdates, sendMessageTo, mainKeyboard, advancedKeyboard, reportPeriodKeyboard, callTelegramApi, RELAY_URL } = require('./lib/telegram');
const { isAuthorized } = require('./lib/auth');
const { runCommand, runSearchCommand, runCustomRangeCommand, KNOWN_COMMANDS, HELP_TEXT } = require('./lib/commands');
const { logNotification } = require('./lib/notifications');
const { loadSnapshot, todayKey, salesOnDate } = require('./lib/data');
const { computeSalesSummary, computeStockAlerts, buildCloseReport } = require('./lib/report');
const { checkBackupStatus } = require('./lib/backup-status');

// ─── Diagnostic logging ───
// Everything written through log() goes to stdout, which the Electron main process pipes into
// C:\NHC_Pharmacy_Data\telegram_bot_service.log (see electron/main.js's logToFile). These lines
// are the primary tool for answering "why did /start / a button give no reply?" — they make each
// stage visible: config loaded, relay connected, each incoming message, the authorization
// decision, which command ran, and whether the reply was actually sent. Kept deliberately quiet
// on the every-3s empty poll (only non-empty polls and real events are logged) so the file stays
// readable rather than flooding with "0 updates" lines.
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
// Redacts everything but the last 4 digits of a numeric Telegram id in free text — safe to log.
function shortId(id) {
  const s = String(id ?? '');
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

// Written to the shared production data folder, not next to this script — under a real
// install this script lives inside app.asar.unpacked (or even Program Files, when running
// standalone), where a per-user process may not have write access. C:\NHC_Pharmacy_Data is
// already the app's convention for all other writable runtime state.
function schedulerStatePath(cfg) {
  return (cfg && cfg.schedulerStateFile) || 'C:\\NHC_Pharmacy_Data\\telegram_scheduler_state.json';
}

// ─── Status reporting to the parent (Electron main) process ───
// Only active when this script was launched via child_process.fork() — process.send is
// undefined for a plain `node bot.js` run, so all of this is a no-op in standalone/dev use.
let lastReportedState = null;
function sendStatus(patch) {
  if (typeof process.send !== 'function') return;
  try {
    process.send({ channel: 'vhc-telegram-status', ...patch, ts: Date.now() });
  } catch (e) {
    // Parent process gone / channel closed — nothing to do, polling loop continues regardless.
  }
}
// Convenience wrapper: always stamps a timestamp field appropriate to the transition, and
// avoids flooding the IPC channel with a message on every 3s poll tick when nothing changed.
function reportState(state, extra = {}) {
  const changed = state !== lastReportedState;
  lastReportedState = state;
  if (changed || extra.force) {
    sendStatus({ state, ...extra });
  }
}

// Maps the text shown on a tapped keyboard button back to its command. Covers all three
// keyboard screens — see lib/telegram.js's mainKeyboard() / advancedKeyboard() /
// reportPeriodKeyboard() for what's actually shown on each. "/report" (typed directly, or
// from HELP_TEXT) still means the original full OP-close report — the "📊 Report" BUTTON
// now opens the period picker instead (/report_menu), per the new Report UX; the picker's
// own "📅 Today" reuses the exact same command as the main-screen Today button.
const KEYBOARD_LABELS = {
  // Screen 1 (main)
  '📅 Today': '/today',
  '📊 Report': '/report_menu',
  '📦 Inventory': '/inventory',
  '⏰ Expiry': '/expiry',
  '💳 Credit': '/credit',
  '☁️ Backup': '/backup',
  '➕ More Features': '/more',
  // Screen 2 (advanced)
  '🏆 Top Selling': '/topselling',
  '🐢 Slow Moving': '/slowmoving',
  '💀 Dead Stock': '/deadstock',
  '📋 Full Inventory': '/inventory_full',
  '🟡 Low Stock': '/lowstock',
  '🟠 Critical Stock': '/criticalstock',
  '🔴 Out of Stock': '/outofstock',
  '🔍 Search Medicine': '/search_prompt',
  '💵 Payment Summary': '/paymentsummary',
  '🏭 Supplier Dues': '/supplierdues',
  '⚙️ System Health': '/systemhealth',
  '◀️ Back': '/back',
  // Report period picker
  '📆 Yesterday': '/report_yesterday',
  '🗓️ Last 7 Days': '/report_last7',
  '📈 This Month': '/report_thismonth',
  '📉 Last Month': '/report_lastmonth',
  '🗂️ Custom Range': '/report_custom_prompt',
};

// Lightweight, in-memory, per-chat "the bot just asked a follow-up question" state — used
// only by Search Medicine and Report → Custom Range, the two features that need one extra
// piece of free-text input. Not persisted (a restart simply forgets any pending prompt,
// which is fine — the user just presses the button again) and self-expires after
// AWAITING_TTL_MS so a stale prompt from long ago can never hijack an unrelated later
// message. Deliberately NOT using any cached/previous report data here — same "never treat
// old data as current" principle as the POS app's Print Thermal Receipt fix.
const AWAITING_TTL_MS = 5 * 60 * 1000;
const awaitingSearch = new Map(); // chatId -> timestamp
const awaitingCustomRange = new Map(); // chatId -> timestamp

function markAwaiting(map, chatId) {
  map.set(chatId, Date.now());
}
function consumeAwaiting(map, chatId) {
  const ts = map.get(chatId);
  map.delete(chatId);
  return !!ts && Date.now() - ts <= AWAITING_TTL_MS;
}
function clearAwaiting(chatId) {
  awaitingSearch.delete(chatId);
  awaitingCustomRange.delete(chatId);
}

// The Pharmacy app's current Supabase session access token, relayed here from
// electron/main.js (which gets it from the renderer — see vhc-cloud-sync.js's
// syncRealtimeAuth). This — not any local file — is what authenticates every call to the
// telegram-relay Edge Function; see lib/telegram.js. Only active when forked by Electron;
// stays null for a standalone `node bot.js` run, where every Telegram call will report
// "waiting for sign-in" (expected — there's no Pharmacy app renderer to sign in from).
let currentSupabaseToken = null;
if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg && typeof msg === 'object' && msg.channel === 'vhc-supabase-token') {
      currentSupabaseToken = msg.token || null;
    }
  });
  // Tell the parent this process is actually ready to receive IPC messages. Sending the
  // token immediately after fork() (before this file has finished loading — require()-ing
  // half a dozen modules takes real time) races the child's message listener being attached
  // at all: Node does not buffer/replay 'message' events for listeners added after they
  // arrive, so an eagerly-sent token can be silently lost. main.js waits for this signal
  // before sending, instead of sending right after fork().
  if (typeof process.send === 'function') {
    try { process.send({ channel: 'vhc-bot-ready' }); } catch (e) {}
  }
}

function reloadConfig() {
  // Re-read from disk every time rather than caching, so changes made via the POS app's
  // Settings screen (allowedUserIds, autoReportEnabled, reportTimes) take effect without
  // restarting this process. Never throws — see lib/config.js — so callers don't need to
  // guard against a missing/corrupted file; it silently falls back to sane defaults.
  const cfg = loadConfig();
  cfg.supabaseToken = currentSupabaseToken;
  return cfg;
}

function resolveCommand(text) {
  const trimmed = (text || '').trim();
  if (KEYBOARD_LABELS[trimmed]) return KEYBOARD_LABELS[trimmed];
  if (trimmed.startsWith('/')) return trimmed;
  return null;
}

function readSchedulerState(cfg) {
  const p = schedulerStatePath(cfg);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeSchedulerState(cfg, state) {
  const p = schedulerStatePath(cfg);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

function currentHHMM(timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function currentDateKeyLocal(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

// Checks whether any configured report time is due right now and hasn't already fired
// today, and if so sends the close report to the configured channel. Tolerant of the check
// running slightly late/early (matches within the same minute) since it's polled frequently.
async function maybeSendScheduledReport(cfg) {
  if (!cfg.autoReportEnabled) return;
  const times = Array.isArray(cfg.reportTimes) ? cfg.reportTimes : [];
  if (!times.length) return;
  if (!cfg.channelChatId) return; // nowhere to send it — silently skip, /report still works on demand

  const nowHHMM = currentHHMM(cfg.timezone);
  const today = currentDateKeyLocal(cfg.timezone);
  if (!times.includes(nowHHMM)) return;

  const state = readSchedulerState(cfg);
  const stateKey = `${today}_${nowHHMM}`;
  if (state[stateKey]) return; // already sent this slot today

  try {
    const snapshot = loadSnapshot(cfg);
    const sales = salesOnDate(snapshot.salesHistory, today, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    const backupStatus = checkBackupStatus(cfg);
    const [y, m, d] = today.split('-');
    const dateLabel = `${d}/${m}/${y}`;
    const text = buildCloseReport(dateLabel, summary, alerts, backupStatus, snapshot.inventory.length);
    await sendMessageTo(cfg, cfg.channelChatId, text);
    logNotification(cfg, { type: 'report', title: `Scheduled OP Close Report (${nowHHMM})`, summary: `Sent to channel for ${dateLabel}`, chatId: cfg.channelChatId });
    console.log(`[${new Date().toISOString()}] Scheduled report sent for slot ${stateKey}.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Scheduled report failed for slot ${stateKey}:`, err.message);
    logNotification(cfg, { type: 'alert', title: 'Scheduled report failed', summary: err.message });
  } finally {
    state[stateKey] = true;
    // Keep the state file from growing forever — only keep today's entries.
    for (const key of Object.keys(state)) {
      if (!key.startsWith(today)) delete state[key];
    }
    writeSchedulerState(cfg, state);
  }
}

async function handleMessage(cfg, message) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  const text = message.text;
  if (!text) return; // photos etc. are handled by the in-app bot's own inbox flow, not this one

  const command = resolveCommand(text);
  log(`Message from userId=${shortId(userId)} chatId=${shortId(chatId)}: "${String(text).slice(0, 40)}" → command=${command || '(none)'}`);

  if (command === '/whoami') {
    await sendMessageTo(cfg, chatId, `Your Telegram user ID is: <b>${userId}</b>\n\nGive this to your admin to be added to the authorized list.`);
    log(`Replied to /whoami for userId=${shortId(userId)}.`);
    return;
  }

  // Not a recognized command/button — either it's the answer to a pending Search Medicine /
  // Custom Range prompt, or it's genuinely unrecognized text. Checked before the "unknown
  // command" help fallback so a typed medicine name or date range is actually consumed by
  // whichever prompt is pending, instead of just getting a generic help reply.
  if (!command) {
    if (isAuthorized(cfg, userId) && consumeAwaiting(awaitingSearch, chatId)) {
      const result = runSearchCommand(cfg, text);
      await sendMessageTo(cfg, chatId, result.text);
      logNotification(cfg, { type: 'command', title: `Search: "${text}"`, summary: `Requested by user ${userId}`, chatId, userId });
      return;
    }
    if (isAuthorized(cfg, userId) && consumeAwaiting(awaitingCustomRange, chatId)) {
      const result = runCustomRangeCommand(cfg, text);
      if (!result) {
        await sendMessageTo(cfg, chatId, `Couldn't read that as two dates. Send a range like <b>01/08/2026-15/08/2026</b> (DD/MM/YYYY).`);
        return;
      }
      await sendMessageTo(cfg, chatId, result.text);
      logNotification(cfg, { type: 'command', title: `Report: Custom Range`, summary: `Requested by user ${userId}`, chatId, userId });
      return;
    }
    await sendMessageTo(cfg, chatId, HELP_TEXT, { replyMarkup: isAuthorized(cfg, userId) ? mainKeyboard() : undefined });
    return;
  }

  if (!isAuthorized(cfg, userId)) {
    await sendMessageTo(cfg, chatId, `🔒 You're not authorized to use this bot.\n\nYour Telegram user ID is <b>${userId}</b> — send it to your admin to be added.`);
    logNotification(cfg, { type: 'security', title: 'Unauthorized command attempt', summary: `User ${userId} tried "${command}"`, chatId, userId });
    log(`REJECTED unauthorized userId=${shortId(userId)} for "${command}". Add this ID to allowedUserIds in ${CONFIG_PATH} to grant access.`);
    return;
  }

  // A real, recognized command/button always takes priority over any pending Search/Custom
  // Range prompt — pressing an actual button is an unambiguous "never mind" signal.
  clearAwaiting(chatId);

  if (command === '/help' || command === '/start') {
    await sendMessageTo(cfg, chatId, HELP_TEXT, { replyMarkup: mainKeyboard() });
    log(`Replied to ${command} for authorized userId=${shortId(userId)} with the main keyboard.`);
    return;
  }

  // --- Keyboard-screen navigation. These aren't reports — they only switch which buttons
  // are shown, so (unlike every other reply below) they deliberately DO attach a keyboard;
  // that's the one and only purpose of pressing them. Every other command reply below sends
  // with no reply_markup at all, leaving the keyboard exactly as the user left it instead of
  // the bot re-asserting one on every message — that repeated re-assertion was the "keyboard
  // won't stay collapsed" behavior this UI pass was asked to fix.
  if (command === '/more') {
    await sendMessageTo(cfg, chatId, `➕ <b>More Features</b>\nAdvanced tools — tap "◀️ Back" any time to return.`, { replyMarkup: advancedKeyboard() });
    return;
  }
  if (command === '/back') {
    await sendMessageTo(cfg, chatId, `🏠 Main menu.`, { replyMarkup: mainKeyboard() });
    return;
  }
  if (command === '/report_menu') {
    await sendMessageTo(cfg, chatId, `📊 <b>Report</b>\nChoose a period:`, { replyMarkup: reportPeriodKeyboard() });
    return;
  }
  if (command === '/search_prompt') {
    markAwaiting(awaitingSearch, chatId);
    await sendMessageTo(cfg, chatId, `🔍 Type the medicine name to search for.`);
    return;
  }
  if (command === '/report_custom_prompt') {
    markAwaiting(awaitingCustomRange, chatId);
    await sendMessageTo(cfg, chatId, `🗂️ Send the date range, e.g. <b>01/08/2026-15/08/2026</b> (DD/MM/YYYY, either order).`);
    return;
  }

  try {
    const result = runCommand(cfg, command);
    if (!result) {
      await sendMessageTo(cfg, chatId, `Unknown command. ${HELP_TEXT}`, { replyMarkup: mainKeyboard() });
      return;
    }
    await sendMessageTo(cfg, chatId, result.text);
    log(`Replied to "${command}" for authorized userId=${shortId(userId)} (${result.text.length} chars).`);
    logNotification(cfg, { type: 'command', title: `Command: ${command}`, summary: `Requested by user ${userId}`, chatId, userId });
  } catch (err) {
    log(`Command "${command}" FAILED for userId=${shortId(userId)}: ${err.message}`);
    await sendMessageTo(cfg, chatId, `⚠️ Something went wrong running that command:\n${err.message}`);
    logNotification(cfg, { type: 'alert', title: `Command "${command}" failed`, summary: err.message, chatId, userId });
  }
}

async function main() {
  reportState('starting');
  let cfg = reloadConfig(); // never throws — see lib/config.js

  // ── Startup diagnostics ── one clear block that answers "is the bot even configured right?"
  // before any polling begins. Distinguishes "missing config" from every downstream failure.
  const ids = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [];
  const configExists = fs.existsSync(CONFIG_PATH);
  const dataFileExists = cfg.dataFile ? fs.existsSync(cfg.dataFile) : false;
  log('──────── NHC Pharmacy Telegram Bot starting ────────');
  log(`Config file: ${CONFIG_PATH} (${configExists ? 'found' : 'MISSING — using built-in defaults'})`);
  log(`Authorized Telegram user IDs: ${ids.length} configured${ids.length ? ' (' + ids.map(shortId).join(', ') + ')' : ' — NOBODY can use commands until at least one is added'}`);
  log(`Data file: ${cfg.dataFile || '(none)'} (${dataFileExists ? 'found' : 'NOT found yet — report commands will error until the POS app writes an auto-backup'})`);
  log(`Scheduled report: ${cfg.autoReportEnabled ? 'enabled at ' + (Array.isArray(cfg.reportTimes) ? cfg.reportTimes.join(', ') : '?') : 'disabled'}; channel ${cfg.channelChatId ? 'configured' : 'NOT set (on-demand commands still work)'}`);
  log(`Relay endpoint: ${RELAY_URL}`);
  log(`Supabase session token: ${cfg.supabaseToken ? 'present (app is signed in)' : 'NOT yet received — waiting for the POS app to sign in'}`);

  let offset = 0;
  let retryDelayMs = 2000;
  let consecutiveErrors = 0;
  let lastSchedulerCheck = 0;
  let connectedLogged = false; // re-announce "Connected to Telegram" after a reconnect, not just once ever

  for (;;) {
    cfg = reloadConfig();
    const statusFields = {
      authorizedUserCount: (cfg.allowedUserIds || []).length,
      autoReportEnabled: !!cfg.autoReportEnabled,
      reportTimes: Array.isArray(cfg.reportTimes) ? cfg.reportTimes : [],
      channelConfigured: !!cfg.channelChatId,
    };

    // Check the report schedule roughly once a minute, independent of how fast/slow polling is.
    if (Date.now() - lastSchedulerCheck > 60000) {
      lastSchedulerCheck = Date.now();
      await maybeSendScheduledReport(cfg).catch((e) => console.error('Scheduler check failed:', e.message));
    }

    try {
      if (!connectedLogged) {
        const me = await callTelegramApi(cfg, 'getMe', {});
        log(`Connected to Telegram as @${me.username} (via secure relay). Polling active — send /start to @${me.username} to test.`);
        connectedLogged = true;
      }

      // Short-polling (timeout=0, returns immediately) rather than Telegram's long-poll
      // hold-open: on this network, holding the connection open for the long-poll window
      // gets ECONNRESET almost immediately (looks like a firewall/AV/proxy that dislikes
      // long-held idle connections), which made long-polling actively less reliable than
      // just asking frequently. A short, fixed delay between successful polls keeps this
      // well within Telegram's rate limits for a single low-traffic bot.
      const updates = await getUpdates(cfg, offset, 0);
      if (updates.length) log(`getUpdates: received ${updates.length} update(s).`);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(cfg, update.message).catch((e) =>
            log(`Failed to handle message (send/handler error): ${e.message}`)
          );
        }
      }
      retryDelayMs = 2000;
      consecutiveErrors = 0;
      reportState('running', { ...statusFields, lastPollAt: Date.now(), lastError: null });
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      connectedLogged = false; // will re-announce once a poll succeeds again
      consecutiveErrors++;
      retryDelayMs = Math.min(retryDelayMs * 2, 60000);

      let state, message, category;
      if (err.noSessionError) {
        // Expected right after launch, before the Pharmacy app finishes signing in — self-
        // resolves the moment main.js relays a session token, no local fix needed. Retried
        // quickly rather than backing all the way off, since sign-in usually completes
        // within a few seconds of the app opening.
        state = 'starting';
        category = 'WAITING-FOR-SIGN-IN';
        message = 'Waiting for the Pharmacy app to sign in…';
        retryDelayMs = Math.min(retryDelayMs, 5000);
      } else if (err.telegramAuthError) {
        // The relay's server-side bot token is wrong/revoked — an operations problem (the
        // Edge Function's TELEGRAM_BOT_TOKEN secret), not something any pharmacy PC can fix
        // by itself. Still retried (the secret could be corrected at any time), just clearly
        // labeled so it isn't mistaken for an ordinary network hiccup.
        state = 'error';
        category = 'INVALID-SERVER-BOT-TOKEN';
        message = 'Telegram relay reports the bot token is invalid — this must be fixed on the server (Edge Function TELEGRAM_BOT_TOKEN secret), not on this PC.';
      } else if (err.relayNotDeployed) {
        // The telegram-relay Edge Function itself doesn't exist yet in Supabase — a one-time
        // deployment step, not a per-PC problem. See lib/telegram.js for how this is
        // distinguished from a normal error, and telegram-bot/README.md for the fix.
        state = 'error';
        category = 'RELAY-NOT-DEPLOYED';
        message = err.message;
      } else {
        // A single transient failure is reported as 'error' (still trying); several in a row
        // means the bot has effectively lost connectivity, reported as 'disconnected' so the
        // UI can distinguish "had one hiccup" from "internet/API has been down for a while".
        state = consecutiveErrors >= 3 ? 'disconnected' : 'error';
        // A relay fetch that never completed (DNS/connection refused/timeout) is a network
        // problem on this PC; anything else that got a reply is a Telegram/relay API failure.
        category = /Relay request failed/i.test(err.message) ? 'NETWORK-FAILURE' : 'TELEGRAM-API-FAILURE';
        message = err.message;
      }
      log(`Polling error [${category}] (attempt ${consecutiveErrors}): ${message}`);
      reportState(state, { ...statusFields, lastError: message, lastErrorAt: Date.now(), force: true });
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error starting bot:', err.message);
  reportState('stopped', { lastError: err.message, force: true });
  process.exit(1);
});

// A clean SIGTERM (the parent process's normal way of stopping this child on Exit/Quit) should
// exit immediately without an "error" state being reported — this is an intentional stop, not
// a crash. SIGINT covered too for standalone Ctrl+C use.
function handleShutdownSignal(signal) {
  reportState('stopped', { lastError: null, force: true });
  console.log(`[${new Date().toISOString()}] Received ${signal}, shutting down.`);
  process.exit(0);
}
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
