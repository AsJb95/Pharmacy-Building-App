# NHC Pharmacy — Telegram Reporting Bot

**No configuration is needed on any pharmacy PC.** Installing the NHC Pharmacy POS app is
enough — the Telegram bot starts automatically, reads the live production data, and needs no
token entry, no setup screen, no separate service, and no terminal window. This document
describes the architecture and the one-time (developer/owner-side, **not** per-PC) setup it
depends on.

> This is the NHC Pharmacy build. All runtime state lives under **`C:\NHC_Pharmacy_Data`** and
> the bot talks to its **own** Supabase project — completely separate from any older VHC
> Pharmacy install (`C:\VHC_Pharmacy_Data`), which is never touched.

## Architecture: secure server-side relay

The real Telegram bot token is **never present on any pharmacy PC** — not in the installer,
not in `app.asar`, not in any local config file, not in the renderer. It lives exclusively as
a secret on a Supabase Edge Function (`telegram-relay`), which is the only thing that ever
talks to `api.telegram.org` directly.

```
Pharmacy PC                               Supabase (cloud)              Telegram
┌──────────────────────────┐             ┌───────────────────┐
│ Electron main process     │             │ telegram-relay      │
│  └─ forks bot.js (child)  │──HTTPS─────▶│  Edge Function       │──HTTPS──▶ api.telegram.org
│      (polls, no token)    │  Bearer:    │  (holds the real     │
│                             │  Pharmacy   │   bot token as a     │
│ Renderer (signed in)       │  app's own  │   server secret)      │
│  └─ Supabase session ──────┼─session JWT─┘   verifies the JWT,   │
│     token relayed via IPC  │             │   forwards to Telegram│
└──────────────────────────┘             └───────────────────┘
```

- `bot.js` authenticates to the relay using the **same Supabase session** the Pharmacy app is
  already signed in with. The token is relayed renderer → main process → bot child over IPC —
  see `electron/main.js`'s `supabase-session-token-changed` handler and
  `cloud-src/vhc-cloud-sync.js`'s `syncRealtimeAuth`. No separate credential is introduced on
  the client side.
- The relay checks that the caller is a genuinely signed-in user of this Supabase project,
  then forwards only an allowlisted set of methods (`getMe`, `sendMessage`, `getUpdates`) to
  Telegram using its own server-side `TELEGRAM_BOT_TOKEN` secret.
- Report **data** never goes through the relay or Supabase — `bot.js` reads it directly from
  the same local snapshot the desktop app keeps fresh
  (`C:\NHC_Pharmacy_Data\gdrive_backups\NHC_POS_AutoBackup.json`). One source of truth: what
  the POS app shows is what the bot reports.
- The relay URL this build calls is configured in `lib/telegram.js`
  (`.../functions/v1/telegram-relay` on the NHC Supabase project). It can be overridden for
  local testing with the `VHC_TEST_RELAY_URL` environment variable.

### One-time server-side setup (done once by the developer/owner — never per pharmacy PC)

The relay function must exist and hold the real token before any PC's bot can connect. This
can be done entirely from the Supabase Dashboard for the **NHC** project — no CLI required:

1. **Dashboard → Edge Functions → Create a new function**, name it exactly `telegram-relay`,
   and paste in the relay source. The reference implementation lives at
   `supabase/functions/telegram-relay/index.ts` (shared across builds; kept at the repository
   root, not inside this app package). Deploy it.
2. **Dashboard → Project Settings → Edge Functions → Secrets** → add `TELEGRAM_BOT_TOKEN`
   with the NHC bot's real token (from @BotFather). `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are provided to every Edge Function automatically.

After this, every pharmacy PC that installs the app works immediately, with no further action
anywhere.

> **The bot token is a server-side secret. Do not put it in this repository, the installer,
> `telegram_config.json`, or anywhere on a pharmacy PC.** If it is ever leaked or rotated,
> update only the `TELEGRAM_BOT_TOKEN` secret on the relay — nothing on any PC changes.

## How it runs on a pharmacy PC

- The Electron main process (`electron/main.js`) starts the bot as a managed child process on
  every launch — forked from `telegram-bot/bot.js`, which is marked `asarUnpack` in
  `package.json` so it exists as real files on disk (`resources/app.asar.unpacked/telegram-bot/`)
  and can be launched as a genuine child process.
- `C:\NHC_Pharmacy_Data` and a non-secret `telegram_config.json` inside it (allowlisted
  Telegram user IDs, alert thresholds, report time — **no token**) are created automatically on
  first launch. Nothing to create by hand.
- Closing the POS window (X) does **not** stop the bot — the app keeps running in the Windows
  system tray and the bot keeps polling. Only the tray's **Exit / Quit** (or an OS-level
  shutdown) stops both together.
- If the bot process crashes, the main process restarts it automatically with backoff (a few
  seconds, doubling up to a 60s cap). A confirmed-good poll resets the backoff.
- Opening the app a second time while it's already running does not start a second bot — a
  single-instance lock just brings the existing window forward.
- Real-time bot status (Starting / Running / Error / Disconnected / Stopped, last poll, last
  error) is reported back to the POS app over IPC. While the app is still completing its own
  sign-in, the bot reports **"Waiting for the Pharmacy app to sign in…"** rather than an error —
  this is expected and self-resolves once signed in.

## Commands and keyboard

Only Telegram user IDs listed in `allowedUserIds` can use commands; anyone else gets a polite
"not authorized" reply that also logs a `security` notification. **`/whoami` works for anyone**
(even before authorization) so a new user can find the ID to hand to the admin.

**Screen 1 (main)** — via `/start` or `/help`:

| Button | Command | Sends |
|---|---|---|
| 📅 Today | `/today` | Today's sales summary |
| 📊 Report | *(opens the period picker)* | — |
| 📦 Inventory | `/inventory` | Low-stock alert summary |
| ⏰ Expiry | `/expiry` | Expired / expiring-soon list |
| 💳 Credit | `/credit` | Outstanding Credit-mode bills |
| ☁️ Backup | `/backup` | Auto-backup freshness |
| ➕ More Features | *(Screen 2)* | — |

**Report period picker** — via "📊 Report": Today, Yesterday, Last 7 Days, This Month
(with last-month comparison), Last Month, Custom Range (`01/08/2026-15/08/2026`), Back.

**Screen 2 (advanced)** — via "➕ More Features":

| Button | Command | Sends |
|---|---|---|
| 🏆 Top Selling | `/topselling` | Best sellers, last 30 days |
| 🐢 Slow Moving | `/slowmoving` | In stock, few sales in last 30 days |
| 💀 Dead Stock | `/deadstock` | In stock, zero sales in last 60 days |
| 📋 Full Inventory | `/inventory_full` | Every item (auto-split across messages) |
| 🟡 Low Stock | `/lowstock` | Full low-stock list |
| 🟠 Critical Stock | `/criticalstock` | The most urgent low-stock items |
| 🔴 Out of Stock | `/outofstock` | Full out-of-stock list |
| 🔍 Search Medicine | `/search_prompt` | Prompts for a name, shows stock/batch/expiry/price |
| 💵 Payment Summary | `/paymentsummary` | Today's Cash/UPI/Card/Credit breakdown |
| 🏭 Supplier Dues | `/supplierdues` | "Not tracked" — no supplier-ledger data in this app |
| ⚙️ System Health | `/systemhealth` | Bot status, authorized users, report schedule, backup — no secrets |
| ◀️ Back | — | Returns to Screen 1 |

Typed slash commands also work directly: `/report`, `/today`, `/inventory`, `/expiry`,
`/backup`, `/credit`, `/help`, `/start`, `/whoami`. `/report` is the full "OP close" report
(sales + stock alerts + backup combined); the **📊 Report button** opens the period picker.

## Configuration

Config lives at **`C:\NHC_Pharmacy_Data\telegram_config.json`** (auto-created with sane
defaults on first launch). It holds only non-secret fields:

| Field | Purpose |
|---|---|
| `allowedUserIds` | Telegram user IDs allowed to use commands |
| `channelChatId` | Channel for the scheduled daily report — empty by default |
| `autoReportEnabled`, `reportTimes` | Editable from **Settings → Remote Reports Bot**; picked up live within a few seconds, no restart |
| `dataFile`, `ledgerDir` | Where the bot reads sales/inventory/ledger data |
| `notificationLogFile` | Notification log (also read by the POS app) |
| `schedulerStateFile` | Tracks which scheduled report slots already fired today |
| `lowStockUnits`, `lowStockStrips`, `nearExpiryDays` | Alert thresholds |

There is **no `botToken` field** — see **Architecture** above.

> **Set your own `allowedUserIds` before handing the build to the client.** The built-in
> defaults are development IDs; each authorized person should send `/whoami` to the bot and
> have their ID added (via **Settings → Remote Reports Bot**, or by editing
> `telegram_config.json`). Everyone else is rejected automatically.

**Scheduled daily report (optional, per deployment):** `channelChatId` starts empty, so the
*automatic* daily report has nowhere to post until it's set once. On-demand commands work
immediately regardless. To enable it: add the NHC bot as an admin (with "Post Messages") of
the target Telegram channel, post any message there, obtain the channel's numeric chat id, and
put it in `channelChatId`.

## Error states you may see (and where the fix is)

| Bot status / message | Meaning | Where to fix |
|---|---|---|
| Waiting for the Pharmacy app to sign in… | App not signed in yet, or session expired | Sign in to the POS app — self-resolves |
| Relay request failed (network/cause) | No internet / Supabase unreachable | Restore connectivity — retries automatically |
| Telegram relay is not deployed yet… | The `telegram-relay` function doesn't exist on the project | Deploy it — see **One-time server-side setup** |
| …bot token is invalid… (server) | `TELEGRAM_BOT_TOKEN` secret is wrong/revoked | Fix the secret on the relay — not a per-PC issue |
| TELEGRAM_BOT_TOKEN is not configured… | The secret was never set | Add it — see **One-time server-side setup** |
| 🔒 You're not authorized… | Sender's Telegram ID isn't in `allowedUserIds` | Add the ID via Settings, or ignore |

The bot never exits over any of these — it keeps polling and reports the current state, so it
recovers on its own the moment the underlying cause is resolved.

## Notifications

Every report sent, command handled, and unauthorized attempt is logged to
`C:\NHC_Pharmacy_Data\telegram_notifications.json` (capped at the last 500 entries) and can be
surfaced in the POS app. Types: `report`, `command`, `security`, `alert`.

## Files (this shipped copy)

| File | Purpose |
|---|---|
| `bot.js` | Polling loop: commands, allowlist, scheduled report, status reporting, receives the Supabase token via fork IPC |
| `lib/config.js` | Loads `telegram_config.json`, falls back to built-in defaults if missing/invalid (never throws) |
| `lib/telegram.js` | Calls the secure `telegram-relay` Edge Function — **no bot token here** |
| `lib/auth.js` | Allowlist check |
| `lib/commands.js` | Command → handler mapping |
| `lib/notifications.js` | Append-only notification log |
| `lib/data.js` | Reads the POS auto-backup JSON, matches sales to inventory |
| `lib/report.js` | Builds report text |
| `lib/credit.js` | Outstanding credit calculation |
| `lib/backup-status.js` | Backup freshness check |
| `lib/ledger.js` | Reads refunds/discounts (used by the standalone ledger tool) |

Server-side: the `telegram-relay` Edge Function is the only code that holds or sends the real
bot token; deploy it once (see **One-time server-side setup**).
