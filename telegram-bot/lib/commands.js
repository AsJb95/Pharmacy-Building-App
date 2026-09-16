const { loadSnapshot, todayKey, dateKey, salesOnDate, salesInRange, last7DaysRange, monthRange, parseCustomRange, searchInventory } = require('./data');
const {
  computeSalesSummary,
  computeStockAlerts,
  computeCriticalStock,
  computeSlowMoving,
  computeDeadStock,
  buildCloseReport,
  buildTodayMessage,
  buildInventoryMessage,
  buildExpiryMessage,
  buildCreditMessage,
  buildBackupStatusMessage,
  buildPeriodSalesMessage,
  buildMonthlySummaryMessage,
  buildTopSellingMessage,
  buildSlowMovingMessage,
  buildDeadStockMessage,
  buildFullInventoryMessage,
  buildLowStockMessage,
  buildCriticalStockMessage,
  buildOutOfStockMessage,
  buildSearchResultsMessage,
  buildPeriodPaymentSummaryMessage,
  buildSupplierDuesMessage,
  buildSystemHealthMessage,
} = require('./report');
const { computeOutstandingCredit } = require('./credit');
const { checkBackupStatus } = require('./backup-status');

function formatLabel(dayKey) {
  const [y, m, d] = dayKey.split('-');
  return `${d}/${m}/${y}`;
}

const HELP_TEXT =
  `🏥 <b>NHC Pharmacy Bot</b>\n\n` +
  `Tap the keyboard icon (bottom-left of the message box) to show the shortcut buttons any ` +
  `time — the first screen has Today, Report, Inventory, Expiry, Credit and Backup; tap ` +
  `"➕ More Features" there for advanced tools like Top Selling, Search, and more.\n\n` +
  `You can also type these directly:\n` +
  `  /report — full OP close report\n` +
  `  /today — today's sales so far\n` +
  `  /inventory — stock summary\n` +
  `  /expiry — expired / expiring soon\n` +
  `  /backup — backup & sync status\n` +
  `  /credit — outstanding credit bills\n` +
  `  /whoami — show your Telegram user ID\n` +
  `  /help — this message`;

// Each handler returns { text, keyboard? } — the caller decides whether to actually send it
// (auth is checked by the caller, not here, so these are pure/testable). None of these ever
// fall back to stale/cached data: every one re-loads the current snapshot from disk and
// computes fresh, the same principle applied to the Print Thermal Receipt fix in the POS app
// — a report either reflects live data right now, or the handler says plainly there's none.
const HANDLERS = {
  '/report': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const day = todayKey(cfg.timezone);
    const sales = salesOnDate(snapshot.salesHistory, day, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    const backupStatus = checkBackupStatus(cfg);
    return { text: buildCloseReport(formatLabel(day), summary, alerts, backupStatus, snapshot.inventory.length) };
  },
  '/today': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const day = todayKey(cfg.timezone);
    const sales = salesOnDate(snapshot.salesHistory, day, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildTodayMessage(formatLabel(day), summary) };
  },
  '/inventory': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    return { text: buildInventoryMessage(alerts, snapshot.inventory.length) };
  },
  '/expiry': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    return { text: buildExpiryMessage(alerts) };
  },
  '/backup': (cfg) => {
    const backupStatus = checkBackupStatus(cfg);
    return { text: buildBackupStatusMessage(backupStatus) };
  },
  '/credit': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const credit = computeOutstandingCredit(snapshot.salesHistory);
    return { text: buildCreditMessage(credit) };
  },
  '/help': () => ({ text: HELP_TEXT }),
  '/start': () => ({ text: HELP_TEXT }),

  // --- Report period menu (Priority 4/5) ---
  '/report_yesterday': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const [y, m, d] = todayKey(cfg.timezone).split('-').map(Number);
    const yest = new Date(Date.UTC(y, m - 1, d));
    yest.setUTCDate(yest.getUTCDate() - 1);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(yest);
    const sales = salesOnDate(snapshot.salesHistory, day, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildPeriodSalesMessage(`Yesterday (${formatLabel(day)})`, summary) };
  },
  '/report_last7': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const { fromKey, toKey, label } = last7DaysRange(cfg.timezone);
    const sales = salesInRange(snapshot.salesHistory, fromKey, toKey, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildPeriodSalesMessage(`${label} (${formatLabel(fromKey)} – ${formatLabel(toKey)})`, summary) };
  },
  '/report_thismonth': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const cur = monthRange(0, cfg.timezone);
    const prev = monthRange(1, cfg.timezone);
    const curSales = salesInRange(snapshot.salesHistory, cur.fromKey, cur.toKey, cfg.timezone);
    const prevSales = salesInRange(snapshot.salesHistory, prev.fromKey, prev.toKey, cfg.timezone);
    const curSummary = computeSalesSummary(curSales, snapshot.inventory);
    const prevSummary = computeSalesSummary(prevSales, snapshot.inventory);
    return { text: buildMonthlySummaryMessage(cur.label, curSummary, prev.label, prevSummary) };
  },
  '/report_lastmonth': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const target = monthRange(1, cfg.timezone);
    const sales = salesInRange(snapshot.salesHistory, target.fromKey, target.toKey, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildPeriodSalesMessage(target.label, summary) };
  },

  // --- Inventory intelligence (Priority 6/7) ---
  '/inventory_full': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    return { text: buildFullInventoryMessage(snapshot.inventory) };
  },
  '/lowstock': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    return { text: buildLowStockMessage(alerts.lowStock) };
  },
  '/criticalstock': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    return { text: buildCriticalStockMessage(computeCriticalStock(snapshot.inventory, cfg)) };
  },
  '/outofstock': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const alerts = computeStockAlerts(snapshot.inventory, cfg);
    return { text: buildOutOfStockMessage(alerts.outOfStock) };
  },
  // Top Selling / Slow Moving / Dead Stock use a fixed, clearly-labeled lookback window
  // rather than a full period picker of their own — keeps this from needing yet another
  // sub-menu on top of the Report period picker. 30 days for the first two (recent selling
  // pattern), 60 for Dead Stock (a longer, more meaningful window for "hasn't moved").
  '/topselling': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const to = todayKey(cfg.timezone);
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(
      new Date(Date.now() - 29 * 86400000)
    );
    const sales = salesInRange(snapshot.salesHistory, from, to, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildTopSellingMessage('Last 30 Days', summary.drugTotals) };
  },
  '/slowmoving': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const to = todayKey(cfg.timezone);
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(
      new Date(Date.now() - 29 * 86400000)
    );
    const sales = salesInRange(snapshot.salesHistory, from, to, cfg.timezone);
    return { text: buildSlowMovingMessage('Last 30 Days', computeSlowMoving(snapshot.inventory, sales)) };
  },
  '/deadstock': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const to = todayKey(cfg.timezone);
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(
      new Date(Date.now() - 59 * 86400000)
    );
    const sales = salesInRange(snapshot.salesHistory, from, to, cfg.timezone);
    return { text: buildDeadStockMessage('Last 60 Days', computeDeadStock(snapshot.inventory, sales)) };
  },

  // --- Payments / Credit / System (Priority 9/10) ---
  '/paymentsummary': (cfg) => {
    const snapshot = loadSnapshot(cfg);
    const day = todayKey(cfg.timezone);
    const sales = salesOnDate(snapshot.salesHistory, day, cfg.timezone);
    const summary = computeSalesSummary(sales, snapshot.inventory);
    return { text: buildPeriodPaymentSummaryMessage(`Today (${formatLabel(day)})`, summary) };
  },
  '/supplierdues': () => ({ text: buildSupplierDuesMessage() }),
  '/systemhealth': (cfg) => {
    const backupStatus = checkBackupStatus(cfg);
    const info = {
      authorizedUserCount: (cfg.allowedUserIds || []).length,
      autoReportEnabled: !!cfg.autoReportEnabled,
      reportTimes: Array.isArray(cfg.reportTimes) ? cfg.reportTimes : [],
      channelConfigured: !!cfg.channelChatId,
    };
    return { text: buildSystemHealthMessage(info, backupStatus) };
  },
};

// Runs an authorized command. Throws if the command text doesn't match a known command —
// caller should catch and reply with the help text rather than crash the poll loop.
function runCommand(cfg, commandText) {
  const cmd = (commandText || '').trim().split(/\s+/)[0].toLowerCase();
  const handler = HANDLERS[cmd];
  if (!handler) return null;
  return handler(cfg);
}

// Free-text search (Priority 8) — not in HANDLERS since it takes user-typed text as its
// argument rather than being a fixed command; bot.js calls this directly once it knows the
// chat is in "awaiting search" mode (see bot.js's search-prompt handling).
function runSearchCommand(cfg, query) {
  const snapshot = loadSnapshot(cfg);
  const matches = searchInventory(snapshot.inventory, query);
  return { text: buildSearchResultsMessage(query, matches) };
}

// Free-text custom date range (Priority 4) — same reasoning as runSearchCommand above.
// Returns null if the text couldn't be parsed as two dates, so bot.js can ask again.
function runCustomRangeCommand(cfg, rawText) {
  const range = parseCustomRange(rawText);
  if (!range) return null;
  const snapshot = loadSnapshot(cfg);
  const sales = salesInRange(snapshot.salesHistory, range.fromKey, range.toKey, cfg.timezone);
  const summary = computeSalesSummary(sales, snapshot.inventory);
  return { text: buildPeriodSalesMessage(`${formatLabel(range.fromKey)} – ${formatLabel(range.toKey)}`, summary) };
}

const KNOWN_COMMANDS = Object.keys(HANDLERS);

module.exports = { runCommand, runSearchCommand, runCustomRangeCommand, KNOWN_COMMANDS, HELP_TEXT };
