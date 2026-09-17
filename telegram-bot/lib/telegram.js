// Talks to Telegram ONLY through the secure server-side relay (a Supabase Edge Function —
// see supabase/functions/telegram-relay/index.ts). The real bot token lives exclusively in
// that function's server-side secret; it is never present anywhere in this app, the
// installer, or on a pharmacy PC's disk. Every call here is authenticated with the SAME
// Supabase session the Pharmacy app itself is already signed in with — cfg.supabaseToken is
// set by bot.js from a message main.js forwards from the renderer (see main.js's
// 'supabase-session-token-changed' handling and vhc-cloud-sync.js's syncRealtimeAuth).

// VHC_TEST_RELAY_URL lets a dev/test launch point at a local mock relay instead of the real
// one, mirroring the VHC_TEST_USERDATA / VHC_TEST_DATA_DIR pattern used elsewhere. Unset for
// all normal users/installs — behavior is unchanged.
const RELAY_URL = process.env.VHC_TEST_RELAY_URL || 'https://fjtgszdzbiepmdmnjsxn.supabase.co/functions/v1/telegram-relay';
const SUPABASE_ANON_KEY = 'sb_publishable_QG4Nk02c6MAXygDjhhApgg_5RA9V-vt'; // publishable key — not a secret, same one already embedded in the renderer's Supabase client

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Telegram messages are capped at 4096 chars; split on line breaks so we never cut mid-tag.
function splitMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(cfg, text) {
  if (!cfg.channelChatId) {
    throw new Error('config.json: channelChatId is empty. Run get-chat-id.js first to find it.');
  }
  await sendMessageTo(cfg, cfg.channelChatId, text);
}

// Generic low-level call to any allowed Telegram Bot API method, via the relay.
async function callTelegramApi(cfg, method, params) {
  if (!cfg.supabaseToken) {
    const err = new Error('Waiting for the Pharmacy app to sign in (no active session yet).');
    err.noSessionError = true;
    throw err;
  }

  // Hard timeout so a stalled connection to the relay (Supabase down, network issue) never
  // hangs the polling loop indefinitely — mirrors the safety net the old direct-to-Telegram
  // getUpdates() used to have on its own long-poll request.
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.supabaseToken}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ method, params: params || {} }),
      signal: controller.signal,
    });
  } catch (err) {
    const cause = err.cause ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
    throw new Error(`Relay request failed: ${err.message}${cause}`);
  } finally {
    clearTimeout(hardTimeout);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    // A 404 with this exact shape ({code, message}, no "ok" field) is Supabase's OWN
    // platform response for "no function with this name is deployed" — it never reaches
    // this relay's code at all, so it looks nothing like a Telegram-side error. Worth
    // surfacing distinctly and clearly rather than as a generic "Not Found", since the fix
    // is a one-time server-side deployment step (see telegram-bot/README.md), not anything
    // wrong with this PC, the token, or polling.
    if (res.status === 404 && data.code === 'NOT_FOUND' && data.ok === undefined) {
      const err = new Error(
        'Telegram relay is not deployed yet on the server (Supabase Edge Function "telegram-relay" does not exist in this project). ' +
        'This is a one-time setup step for the project admin — see telegram-bot/README.md "One-time setup". Not something this PC can fix on its own.'
      );
      err.relayNotDeployed = true;
      throw err;
    }
    const description = data.description || data.message || res.statusText;
    const err = new Error(`Telegram API error (${method}): ${description}`);
    if (res.status === 401) {
      // Two different 401 causes look identical at the HTTP-status level but need different
      // handling: the relay's OWN session check failing (this PC's Pharmacy-app sign-in
      // expired/hasn't happened yet — self-heals once the app is signed in again) vs.
      // Telegram itself rejecting the bot token the relay holds server-side (a problem only
      // the relay's admin can fix — no amount of retrying on this PC helps).
      if (/Missing Authorization header|Invalid or expired session/i.test(description)) {
        err.noSessionError = true;
      } else {
        err.telegramAuthError = true;
      }
    }
    throw err;
  }
  return data.result;
}

// Sends a message to an arbitrary chat (a user's private chat, a group, or the configured
// channel), splitting into multiple messages if needed, with optional reply_markup (e.g. a
// custom keyboard) attached only to the LAST chunk so the keyboard doesn't repeat.
async function sendMessageTo(cfg, chatId, text, options = {}) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const params = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: options.parseMode !== undefined ? options.parseMode : 'HTML',
      disable_web_page_preview: true,
    };
    if (isLast && options.replyMarkup) params.reply_markup = options.replyMarkup;
    await callTelegramApi(cfg, 'sendMessage', params);
  }
}

// Fetch new updates via the relay (short-polling — see bot.js's main loop for why timeout=0
// is used rather than a genuine long-poll on this network).
async function getUpdates(cfg, offset, timeoutSec = 25) {
  return callTelegramApi(cfg, 'getUpdates', { offset, timeout: timeoutSec });
}

// The three reply keyboards the bot uses. Deliberately NOT `is_persistent: true` — that flag
// tells Telegram clients to keep forcing the keyboard open even after the user collapses it
// via the normal keyboard-toggle icon, which is exactly the "don't force it open" behavior
// this app must avoid. Sending a keyboard here only ever happens at specific, deliberate
// points (see bot.js) — most replies are sent with no reply_markup at all, leaving the
// keyboard exactly as the user last left it (open, collapsed, or on whichever screen).

// Screen 1 — the six everyday buttons, plus one way into the advanced screen.
function mainKeyboard() {
  return {
    keyboard: [
      ['📅 Today', '📊 Report'],
      ['📦 Inventory', '⏰ Expiry'],
      ['💳 Credit', '☁️ Backup'],
      ['➕ More Features'],
    ],
    resize_keyboard: true,
  };
}

// Screen 2 — advanced/less-frequent features, reached via "➕ More Features".
function advancedKeyboard() {
  return {
    keyboard: [
      ['🏆 Top Selling', '🐢 Slow Moving'],
      ['💀 Dead Stock', '📋 Full Inventory'],
      ['🟡 Low Stock', '🟠 Critical Stock'],
      ['🔴 Out of Stock', '🔍 Search Medicine'],
      ['💵 Payment Summary', '🏭 Supplier Dues'],
      ['⚙️ System Health'],
      ['◀️ Back'],
    ],
    resize_keyboard: true,
  };
}

// Report-period picker, reached via "📊 Report" — replaces requiring separate commands per
// period. "📅 Today" here intentionally reuses the exact same label/command as the Today
// button on screen 1 (same result either way).
function reportPeriodKeyboard() {
  return {
    keyboard: [
      ['📅 Today', '📆 Yesterday'],
      ['🗓️ Last 7 Days', '📈 This Month'],
      ['📉 Last Month', '🗂️ Custom Range'],
      ['◀️ Back'],
    ],
    resize_keyboard: true,
  };
}

module.exports = {
  sendTelegramMessage,
  sendMessageTo,
  callTelegramApi,
  getUpdates,
  mainKeyboard,
  advancedKeyboard,
  reportPeriodKeyboard,
  escapeHtml,
  splitMessage,
};
