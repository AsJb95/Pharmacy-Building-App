const { parseExpiry, daysUntil, findInventoryMatch } = require('./data');
const { escapeHtml } = require('./telegram');

function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function num(n, digits = 0) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function computeSalesSummary(sales, inventory) {
  let totalAmount = 0, totalSubtotal = 0, totalTax = 0, totalUnits = 0, totalStrips = 0;
  let costTotal = 0, costUnknownUnits = 0;
  const paymentModes = {};
  const drugMap = new Map();

  for (const bill of sales) {
    totalAmount += bill.totalAmount || 0;
    totalSubtotal += bill.subtotal || 0;
    totalTax += bill.totalTax || 0;
    const mode = bill.paymentMode || 'Unknown';
    paymentModes[mode] = (paymentModes[mode] || 0) + (bill.totalAmount || 0);

    for (const item of bill.particulars || []) {
      const qty = item.quantity || 0;
      totalUnits += qty;

      const match = findInventoryMatch(inventory, item.drugName, item.batchNo);
      const unitsPerPack = match?.unitsPerPack || 1;
      totalStrips += qty / unitsPerPack;

      if (match && match.netRate > 0) {
        costTotal += (match.netRate / unitsPerPack) * qty;
      } else {
        costUnknownUnits += qty;
      }

      const key = item.drugName || 'Unknown';
      const prev = drugMap.get(key) || { name: key, units: 0, revenue: 0 };
      prev.units += qty;
      prev.revenue += item.total || 0;
      drugMap.set(key, prev);
    }
  }

  const drugTotals = [...drugMap.values()].sort((a, b) => b.units - a.units);

  return {
    billCount: sales.length,
    totalAmount, totalSubtotal, totalTax,
    totalUnits, totalStrips,
    costTotal, costUnknownUnits,
    paymentModes, drugTotals,
    estimatedProfit: totalSubtotal - costTotal,
  };
}

function computeStockAlerts(inventory, cfg) {
  const outOfStock = [];
  const lowStock = [];
  const nearExpiry = [];
  const expired = [];

  for (const item of inventory) {
    const unitsPerPack = item.unitsPerPack || 1;
    const strips = item.stock / unitsPerPack;

    if (item.stock <= 0) {
      outOfStock.push(item);
    } else if (item.stock <= cfg.lowStockUnits || strips <= cfg.lowStockStrips) {
      lowStock.push(item);
    }

    const expiryDate = parseExpiry(item.expiry);
    if (expiryDate) {
      const d = daysUntil(expiryDate);
      if (d < 0) expired.push({ ...item, daysLeft: d });
      else if (d <= cfg.nearExpiryDays) nearExpiry.push({ ...item, daysLeft: d });
    }
  }

  outOfStock.sort((a, b) => a.name.localeCompare(b.name));
  lowStock.sort((a, b) => a.stock - b.stock);
  nearExpiry.sort((a, b) => a.daysLeft - b.daysLeft);
  expired.sort((a, b) => a.daysLeft - b.daysLeft);

  return { outOfStock, lowStock, nearExpiry, expired };
}

// A more severe subset of computeStockAlerts()'s lowStock — items at half (or less) of the
// configured low-stock threshold. Deliberately does NOT change lowStock itself (still exactly
// what /report, /inventory and the scheduled close report have always shown) — this is purely
// additive, for the new dedicated "Critical Stock" button.
function computeCriticalStock(inventory, cfg) {
  const criticalUnits = Math.max(1, Math.floor((cfg.lowStockUnits || 0) / 2));
  const criticalStrips = Math.max(0.5, (cfg.lowStockStrips || 0) / 2);
  const critical = inventory.filter((item) => {
    if (item.stock <= 0) return false; // out-of-stock is its own, more severe category
    const unitsPerPack = item.unitsPerPack || 1;
    const strips = item.stock / unitsPerPack;
    return item.stock <= criticalUnits || strips <= criticalStrips;
  });
  critical.sort((a, b) => a.stock - b.stock);
  return critical;
}

// Items still in stock but barely moving in the given period's sales — a helper for the
// "Slow Moving" button. minUnits/maxUnits bound what counts as "barely" (0 is dead stock, a
// separate category below; too many units sold means it's just a normal seller).
function computeSlowMoving(inventory, salesInPeriod, maxUnits = 3) {
  const unitsSoldByName = new Map();
  for (const bill of salesInPeriod) {
    for (const item of bill.particulars || []) {
      const key = (item.drugName || '').trim().toUpperCase();
      if (!key) continue;
      unitsSoldByName.set(key, (unitsSoldByName.get(key) || 0) + (item.quantity || 0));
    }
  }
  const slow = inventory
    .filter((item) => item.stock > 0)
    .map((item) => ({ item, unitsSold: unitsSoldByName.get((item.name || '').trim().toUpperCase()) || 0 }))
    .filter((entry) => entry.unitsSold >= 1 && entry.unitsSold <= maxUnits);
  slow.sort((a, b) => a.unitsSold - b.unitsSold || a.item.name.localeCompare(b.item.name));
  return slow;
}

// Items still in stock with ZERO sales anywhere in the given (wider) window — for "Dead
// Stock". Deliberately a separate, wider-window call from Slow Moving rather than "0 units"
// within the same short period, since a single week of zero sales is normal for a slow but
// real seller — dead stock is meant to flag genuinely stale shelf inventory.
function computeDeadStock(inventory, salesInWindow) {
  const soldNames = new Set();
  for (const bill of salesInWindow) {
    for (const item of bill.particulars || []) {
      const key = (item.drugName || '').trim().toUpperCase();
      if (key) soldNames.add(key);
    }
  }
  const dead = inventory.filter((item) => item.stock > 0 && !soldNames.has((item.name || '').trim().toUpperCase()));
  dead.sort((a, b) => a.name.localeCompare(b.name));
  return dead;
}

function limitList(list, max) {
  if (list.length <= max) return { shown: list, more: 0 };
  return { shown: list.slice(0, max), more: list.length - max };
}

function buildEveningMessage(dateLabel, summary, refunds, discounts) {
  const refundTotal = refunds.reduce((s, r) => s + (Number(r.refundAmount) || 0), 0);
  const discountTotal = discounts.reduce((s, d) => s + (Number(d.discountAmount) || 0), 0);
  const netSales = summary.totalAmount - refundTotal;
  const netProfit = summary.estimatedProfit - refundTotal;

  let msg = `🌙 <b>End of Day Summary — ${dateLabel}</b>\n<i>VARNIKA HEALTH CARE</i>\n\n`;

  msg += `🧾 Bills: <b>${num(summary.billCount)}</b>\n`;
  msg += `💊 Tablets/Units Sold: <b>${num(summary.totalUnits)}</b>\n`;
  msg += `📦 Strips/Packs Sold: <b>${num(summary.totalStrips, 1)}</b>\n\n`;

  msg += `💰 Gross Sales: <b>${inr(summary.totalAmount)}</b>\n`;
  if (discountTotal > 0) msg += `🏷️ Discounts Given: <b>-${inr(discountTotal)}</b> (${discounts.length} bill${discounts.length === 1 ? '' : 's'})\n`;
  if (refundTotal > 0) msg += `↩️ Refunds Issued: <b>-${inr(refundTotal)}</b> (${refunds.length} item${refunds.length === 1 ? '' : 's'})\n`;
  msg += `📈 Net Sales: <b>${inr(netSales)}</b>\n`;
  msg += `💵 Estimated Profit: <b>${inr(netProfit)}</b>`;
  if (summary.costUnknownUnits > 0) msg += ` <i>(purchase cost missing for ${num(summary.costUnknownUnits)} units sold — profit may be understated)</i>`;
  msg += `\n\n`;

  const modeLines = Object.entries(summary.paymentModes)
    .sort((a, b) => b[1] - a[1])
    .map(([mode, amt]) => `  • ${escapeHtml(mode)}: ${inr(amt)}`);
  if (modeLines.length) {
    msg += `💳 <b>Payment Mode Breakdown</b>\n${modeLines.join('\n')}\n\n`;
  }

  const { shown, more } = limitList(summary.drugTotals, 8);
  if (shown.length) {
    msg += `🏆 <b>Top Selling Drugs Today</b>\n`;
    msg += shown.map((d, i) => `  ${i + 1}. ${escapeHtml(d.name)} — ${num(d.units)} units (${inr(d.revenue)})`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n\n`;
  }

  if (refunds.length) {
    msg += `⚠️ <b>Returns / Refunds Today</b>\n`;
    msg += refunds
      .map((r) => `  • ${escapeHtml(r.drugName)}${r.batchNo ? ` (Batch ${escapeHtml(r.batchNo)})` : ''} — Qty ${num(r.quantity)} — ${escapeHtml(r.reason || 'Not specified')} — Refunded ${inr(r.refundAmount)}`)
      .join('\n');
    msg += `\n<i>Remember to add returned stock back into inventory in the POS app.</i>\n`;
  }

  return msg.trim();
}

function buildMorningMessage(dateLabel, yesterdayLabel, summary, refunds, discounts, alerts) {
  let msg = `🌅 <b>Good Morning — Daily Brief — ${dateLabel}</b>\n<i>VARNIKA HEALTH CARE</i>\n\n`;

  msg += `📋 <b>Yesterday's Recap (${yesterdayLabel})</b>\n`;
  if (summary.billCount === 0) {
    msg += `  No sales recorded.\n\n`;
  } else {
    const refundTotal = refunds.reduce((s, r) => s + (Number(r.refundAmount) || 0), 0);
    const netSales = summary.totalAmount - refundTotal;
    msg += `  Bills: ${num(summary.billCount)}  |  Units: ${num(summary.totalUnits)}  |  Strips: ${num(summary.totalStrips, 1)}\n`;
    msg += `  Sales: ${inr(summary.totalAmount)}`;
    if (refundTotal > 0) msg += `  |  Refunds: -${inr(refundTotal)}  |  Net: ${inr(netSales)}`;
    msg += `\n  Est. Profit: ${inr(summary.estimatedProfit - refundTotal)}\n\n`;
  }

  const outCount = alerts.outOfStock.length;
  const lowCount = alerts.lowStock.length;
  const expiredCount = alerts.expired.length;
  const nearExpCount = alerts.nearExpiry.length;

  if (outCount === 0 && lowCount === 0 && expiredCount === 0 && nearExpCount === 0) {
    msg += `✅ <b>Stock looks healthy — nothing urgent to reorder today.</b>\n`;
    return msg.trim();
  }

  msg += `🛒 <b>Drugs to Replace / Reorder Today</b>\n`;

  if (outCount) {
    const { shown, more } = limitList(alerts.outOfStock, 10);
    msg += `\n🔴 <b>Out of Stock (${outCount})</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)}${i.stockist ? ` — ${escapeHtml(i.stockist)}` : ''}`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }

  if (lowCount) {
    const { shown, more } = limitList(alerts.lowStock, 10);
    msg += `\n🟠 <b>Running Low (${lowCount})</b>\n`;
    msg += shown
      .map((i) => `  • ${escapeHtml(i.name)} — ${num(i.stock)} units left (~${num(i.stock / (i.unitsPerPack || 1), 1)} strips)${i.stockist ? ` — ${escapeHtml(i.stockist)}` : ''}`)
      .join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }

  if (expiredCount) {
    const { shown, more } = limitList(alerts.expired, 10);
    msg += `\n⚫ <b>Already Expired — Remove from Shelf (${expiredCount})</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)} — Batch ${escapeHtml(i.batch || '—')} — expired ${escapeHtml(i.expiry)}`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }

  if (nearExpCount) {
    const { shown, more } = limitList(alerts.nearExpiry, 10);
    msg += `\n🟡 <b>Expiring Soon (${nearExpCount})</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)} — Batch ${escapeHtml(i.batch || '—')} — in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'} (${escapeHtml(i.expiry)})`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }

  return msg.trim();
}

// --- On-demand / close-report builders (added for the interactive bot) ---

function buildInventorySection(alerts, totalItems) {
  let msg = `📦 <b>Inventory Summary</b>\n`;
  msg += `  Total Items Tracked: ${num(totalItems)}\n`;
  msg += `  🔴 Out of Stock: ${num(alerts.outOfStock.length)}\n`;
  msg += `  🟠 Running Low: ${num(alerts.lowStock.length)}\n`;
  msg += `  ⚫ Expired: ${num(alerts.expired.length)}\n`;
  msg += `  🟡 Expiring Soon: ${num(alerts.nearExpiry.length)}\n`;
  return msg;
}

function buildTopSellingSection(drugTotals, max = 8) {
  const { shown, more } = limitList(drugTotals, max);
  if (!shown.length) return `🏆 <b>Top Selling Medicines</b>\n  No sales in this period.\n`;
  let msg = `🏆 <b>Top Selling Medicines</b>\n`;
  msg += shown.map((d, i) => `  ${i + 1}. ${escapeHtml(d.name)} — ${num(d.units)} units (${inr(d.revenue)})`).join('\n');
  if (more) msg += `\n  …and ${more} more`;
  return msg + '\n';
}

function buildExpiringSection(alerts, max = 10) {
  let msg = `⏰ <b>Expiring Medicines</b>\n`;
  if (alerts.expired.length === 0 && alerts.nearExpiry.length === 0) {
    return msg + `  Nothing expired or expiring soon.\n`;
  }
  if (alerts.expired.length) {
    const { shown, more } = limitList(alerts.expired, max);
    msg += `\n⚫ <b>Already Expired (${alerts.expired.length})</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)} — Batch ${escapeHtml(i.batch || '—')} — expired ${escapeHtml(i.expiry)}`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }
  if (alerts.nearExpiry.length) {
    const { shown, more } = limitList(alerts.nearExpiry, max);
    msg += `\n🟡 <b>Expiring Soon (${alerts.nearExpiry.length})</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)} — Batch ${escapeHtml(i.batch || '—')} — in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'} (${escapeHtml(i.expiry)})`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }
  return msg;
}

function buildPaymentSummarySection(paymentModes) {
  const entries = Object.entries(paymentModes).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return `💳 <b>Payment Summary</b>\n  No payments recorded.\n`;
  let msg = `💳 <b>Payment Summary</b>\n`;
  msg += entries.map(([mode, amt]) => `  • ${escapeHtml(mode)}: ${inr(amt)}`).join('\n');
  return msg + '\n';
}

function buildSystemStatusSection(backupStatus) {
  return `⚙️ <b>System Status</b>\n  ${backupStatus.ok ? '🟢' : '🟠'} ${escapeHtml(backupStatus.message)}\n`;
}

// The comprehensive "OP close" report: business summary, payment summary, inventory
// summary, top sellers, expiring meds, and system status — everything in one message. Used
// both for /report on demand and for the scheduled automatic close report.
function buildCloseReport(dateLabel, summary, alerts, backupStatus, totalItems) {
  let msg = `🧾 <b>OP Close Report — ${dateLabel}</b>\n<i>VARNIKA HEALTH CARE</i>\n\n`;
  msg += `📋 <b>Business Summary</b>\n`;
  msg += `  Bills: ${num(summary.billCount)}  |  Units Sold: ${num(summary.totalUnits)}  |  Strips: ${num(summary.totalStrips, 1)}\n`;
  msg += `  Gross Sales: ${inr(summary.totalAmount)}  |  Est. Profit: ${inr(summary.estimatedProfit)}\n\n`;
  msg += buildPaymentSummarySection(summary.paymentModes) + '\n';
  msg += buildInventorySection(alerts, totalItems) + '\n';
  msg += buildTopSellingSection(summary.drugTotals) + '\n';
  msg += buildExpiringSection(alerts) + '\n';
  msg += buildSystemStatusSection(backupStatus);
  return msg.trim();
}

function buildTodayMessage(dateLabel, summary) {
  let msg = `📅 <b>Today So Far — ${dateLabel}</b>\n\n`;
  msg += `🧾 Bills: <b>${num(summary.billCount)}</b>\n`;
  msg += `💊 Units Sold: <b>${num(summary.totalUnits)}</b>\n`;
  msg += `📦 Strips Sold: <b>${num(summary.totalStrips, 1)}</b>\n`;
  msg += `💰 Gross Sales: <b>${inr(summary.totalAmount)}</b>\n`;
  msg += `💵 Est. Profit: <b>${inr(summary.estimatedProfit)}</b>\n\n`;
  msg += buildPaymentSummarySection(summary.paymentModes);
  return msg.trim();
}

function buildInventoryMessage(alerts, totalItems) {
  let msg = buildInventorySection(alerts, totalItems);
  if (alerts.outOfStock.length) {
    const { shown, more } = limitList(alerts.outOfStock, 15);
    msg += `\n🔴 <b>Out of Stock</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)}`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }
  if (alerts.lowStock.length) {
    const { shown, more } = limitList(alerts.lowStock, 15);
    msg += `\n🟠 <b>Running Low</b>\n`;
    msg += shown.map((i) => `  • ${escapeHtml(i.name)} — ${num(i.stock)} units left`).join('\n');
    if (more) msg += `\n  …and ${more} more`;
    msg += `\n`;
  }
  return msg.trim();
}

function buildExpiryMessage(alerts) {
  return buildExpiringSection(alerts).trim();
}

function buildCreditMessage(credit) {
  if (credit.billCount === 0) return `💳 <b>Outstanding Credit</b>\n\nNo Credit-mode bills recorded.`;
  let msg = `💳 <b>Outstanding Credit</b>\n<i>All recorded Credit-mode bills — the POS does not yet track repayment, so this list is everything ever billed as Credit.</i>\n\n`;
  msg += `Total: <b>${inr(credit.total)}</b> across ${num(credit.billCount)} bill${credit.billCount === 1 ? '' : 's'}\n\n`;
  const { shown, more } = limitList(credit.patients, 15);
  msg += shown.map((p) => `  • ${escapeHtml(p.patientName)} — ${inr(p.total)} (${p.billCount} bill${p.billCount === 1 ? '' : 's'})`).join('\n');
  if (more) msg += `\n  …and ${more} more patients`;
  return msg.trim();
}

function buildBackupStatusMessage(backupStatus) {
  return buildSystemStatusSection(backupStatus).trim() + `\n\nLast write: ${backupStatus.lastWrite ? new Date(backupStatus.lastWrite).toLocaleString('en-IN') : 'never'}`;
}

// --- Report-period menu (Priority 4/5) ---

// Generic "sales for this period" message — buildTodayMessage's exact layout, reusable for
// Yesterday / Last 7 Days / This Month / Last Month / Custom Range so the period picker
// doesn't need a separate builder per option.
function buildPeriodSalesMessage(periodLabel, summary) {
  if (summary.billCount === 0) {
    return `📅 <b>${escapeHtml(periodLabel)}</b>\n\nNo sales recorded in this period.`;
  }
  let msg = `📅 <b>${escapeHtml(periodLabel)}</b>\n\n`;
  msg += `🧾 Bills: <b>${num(summary.billCount)}</b>\n`;
  msg += `💊 Units Sold: <b>${num(summary.totalUnits)}</b>\n`;
  msg += `📦 Strips Sold: <b>${num(summary.totalStrips, 1)}</b>\n`;
  msg += `💰 Gross Sales: <b>${inr(summary.totalAmount)}</b>\n`;
  msg += `💵 Est. Profit: <b>${inr(summary.estimatedProfit)}</b>`;
  if (summary.costUnknownUnits > 0) msg += ` <i>(cost data missing for ${num(summary.costUnknownUnits)} units — may be understated)</i>`;
  msg += `\n\n`;
  msg += buildPaymentSummarySection(summary.paymentModes);
  return msg.trim();
}

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null; // null = "can't express as %, previous was zero"
  return ((current - previous) / previous) * 100;
}

function changeLine(label, current, previous, formatter) {
  const diff = current - previous;
  const pct = pctChange(current, previous);
  const arrow = diff > 0 ? '🔺' : diff < 0 ? '🔻' : '➖';
  const pctText = pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
  return `  ${label}: ${formatter(current)} ${arrow} vs ${formatter(previous)} last month${pctText}`;
}

// "This Month" business summary with a same-metric comparison to last month — Priority 5.
// Never fabricates a profit figure: if cost data is missing for sold units, that's stated
// plainly (same wording buildPeriodSalesMessage already uses), never silently substituted.
function buildMonthlySummaryMessage(label, summary, prevLabel, prevSummary) {
  let msg = `📈 <b>Monthly Business Summary — ${escapeHtml(label)}</b>\n\n`;
  if (summary.billCount === 0) {
    msg += `No sales recorded yet this month.\n`;
  } else {
    msg += `🧾 Bills: <b>${num(summary.billCount)}</b>\n`;
    msg += `💰 Total Sales: <b>${inr(summary.totalAmount)}</b>\n`;
    msg += `💵 Estimated Profit: <b>${inr(summary.estimatedProfit)}</b>`;
    if (summary.costUnknownUnits > 0) msg += ` <i>(cost data missing for ${num(summary.costUnknownUnits)} units — may be understated)</i>`;
    msg += `\n\n`;
    msg += buildPaymentSummarySection(summary.paymentModes) + '\n';
  }

  msg += `📊 <b>Compared to ${escapeHtml(prevLabel)}</b>\n`;
  if (prevSummary.billCount === 0 && summary.billCount === 0) {
    msg += `  No sales in either month to compare.\n`;
  } else {
    msg += changeLine('Sales', summary.totalAmount, prevSummary.totalAmount, inr) + '\n';
    msg += changeLine('Bills', summary.billCount, prevSummary.billCount, (n) => num(n)) + '\n';
    msg += changeLine('Est. Profit', summary.estimatedProfit, prevSummary.estimatedProfit, inr) + '\n';
  }
  return msg.trim();
}

// --- Inventory intelligence (Priority 7) ---

function buildTopSellingMessage(periodLabel, drugTotals, max = 20) {
  let msg = `🏆 <b>Top Selling — ${escapeHtml(periodLabel)}</b>\n\n`;
  if (!drugTotals.length) return msg + `No sales in this period.`;
  const { shown, more } = limitList(drugTotals, max);
  msg += shown.map((d, i) => `  ${i + 1}. ${escapeHtml(d.name)} — ${num(d.units)} units (${inr(d.revenue)})`).join('\n');
  if (more) msg += `\n  …and ${more} more`;
  return msg.trim();
}

function buildSlowMovingMessage(periodLabel, slowItems, max = 40) {
  let msg = `🐢 <b>Slow Moving — ${escapeHtml(periodLabel)}</b>\n<i>In stock, but only 1–3 units sold in this period.</i>\n\n`;
  if (!slowItems.length) return msg + `Nothing qualifies — everything in stock is either selling well or had zero sales (see Dead Stock for that).`;
  const { shown, more } = limitList(slowItems, max);
  msg += shown.map((e) => `  • ${escapeHtml(e.item.name)} — ${e.unitsSold} unit${e.unitsSold === 1 ? '' : 's'} sold, ${num(e.item.stock)} in stock`).join('\n');
  if (more) msg += `\n  …and ${more} more`;
  return msg.trim();
}

function buildDeadStockMessage(windowLabel, deadItems, max = 60) {
  let msg = `💀 <b>Dead Stock — no sales in ${escapeHtml(windowLabel)}</b>\n<i>In stock, zero units sold in this window.</i>\n\n`;
  if (!deadItems.length) return msg + `Nothing qualifies — everything in stock has sold at least one unit in this window.`;
  const { shown, more } = limitList(deadItems, max);
  msg += shown.map((i) => `  • ${escapeHtml(i.name)} — ${num(i.stock)} in stock`).join('\n');
  if (more) msg += `\n  …and ${more} more`;
  return msg.trim();
}

function formatStockLine(item) {
  const price = item.price ?? item.mrp;
  let line = `  • ${escapeHtml(item.name)} — ${num(item.stock)} unit${item.stock === 1 ? '' : 's'}`;
  if (item.batch) line += ` — Batch ${escapeHtml(item.batch)}`;
  if (item.expiry) line += ` — Exp ${escapeHtml(item.expiry)}`;
  if (price != null && price !== '') line += ` — ${inr(price)}`;
  return line;
}

// Full listing, deliberately uncapped — sendMessageTo() already splits long text across
// multiple Telegram messages, so there is no reason to silently truncate this the way the
// short /inventory summary intentionally does. This is what closes that gap.
function buildFullInventoryMessage(inventory) {
  const totalItems = inventory.length;
  const outOfStock = inventory.filter((i) => i.stock <= 0).length;
  const inStock = [...inventory].filter((i) => i.stock > 0).sort((a, b) => a.name.localeCompare(b.name));
  let msg = `📋 <b>Full Inventory</b>\n`;
  msg += `  Total Items: ${num(totalItems)}\n`;
  msg += `  🔴 Out of Stock: ${num(outOfStock)}\n\n`;
  msg += inStock.map(formatStockLine).join('\n');
  return msg.trim();
}

function buildLowStockMessage(lowStock) {
  let msg = `🟡 <b>Low Stock (${num(lowStock.length)})</b>\n\n`;
  if (!lowStock.length) return msg + `Nothing is running low right now.`;
  msg += lowStock.map(formatStockLine).join('\n');
  return msg.trim();
}

function buildCriticalStockMessage(criticalStock) {
  let msg = `🟠 <b>Critical Stock (${num(criticalStock.length)})</b>\n<i>At or below half the low-stock threshold — reorder these first.</i>\n\n`;
  if (!criticalStock.length) return msg + `Nothing is at critical stock level right now.`;
  msg += criticalStock.map(formatStockLine).join('\n');
  return msg.trim();
}

function buildOutOfStockMessage(outOfStock) {
  let msg = `🔴 <b>Out of Stock (${num(outOfStock.length)})</b>\n\n`;
  if (!outOfStock.length) return msg + `Nothing is out of stock right now.`;
  msg += outOfStock.map((i) => `  • ${escapeHtml(i.name)}${i.stockist ? ` — ${escapeHtml(i.stockist)}` : ''}`).join('\n');
  return msg.trim();
}

// --- Search (Priority 8) ---

function buildSearchResultsMessage(query, matches) {
  let msg = `🔍 <b>Search: "${escapeHtml(query)}"</b>\n\n`;
  if (!matches.length) return msg + `No medicines found matching that name.`;
  msg += matches.map(formatStockLine).join('\n');
  return msg.trim();
}

// --- Payments / Credit (Priority 9) ---

function buildPeriodPaymentSummaryMessage(periodLabel, summary) {
  let msg = `💵 <b>Payment Summary — ${escapeHtml(periodLabel)}</b>\n\n`;
  if (summary.billCount === 0) return msg + `No payments recorded in this period.`;
  msg += `Total: <b>${inr(summary.totalAmount)}</b> across ${num(summary.billCount)} bill${summary.billCount === 1 ? '' : 's'}\n\n`;
  msg += buildPaymentSummarySection(summary.paymentModes);
  return msg.trim();
}

// Supplier payable data (purchase orders, amounts owed to stockists, payment status) is not
// tracked anywhere in this app's data model — only sales-side data exists (see lib/data.js's
// loadSnapshot: settings/patients/salesHistory/inventory, nothing purchase-side). Per the
// explicit "only use data that already exists reliably — do not invent" requirement, this is
// a clear, honest "not available" response rather than a fabricated figure.
function buildSupplierDuesMessage() {
  return `🏭 <b>Supplier Pending Payments</b>\n\n` +
    `Not available — this app doesn't currently track purchase orders or amounts owed to ` +
    `stockists, only sales-side data. This would need a supplier/purchase-ledger feature ` +
    `added to the POS app itself before the bot could report it accurately.`;
}

// --- System health (Priority 10) ---

// Only ever reports signals this process can genuinely observe — no bot token, no database
// credentials, no secrets of any kind, per the explicit requirement. "Database status" here
// means the local auto-backup file (the bot's own data source), not a live Supabase check —
// this process has no established connection to Supabase itself to report on honestly.
function buildSystemHealthMessage(botInfo, backupStatus) {
  let msg = `⚙️ <b>System Health</b>\n\n`;
  msg += `🤖 Telegram Bot: <b>🟢 Running</b> (you just got this reply via it)\n`;
  msg += `👥 Authorized Users: ${num(botInfo.authorizedUserCount)}\n`;
  msg += `📅 Scheduled Report: ${botInfo.autoReportEnabled ? `🟢 Enabled` : `⚪ Disabled`}`;
  if (botInfo.autoReportEnabled) {
    msg += botInfo.channelConfigured
      ? ` at ${escapeHtml((botInfo.reportTimes || []).join(', ') || '—')}`
      : ` <i>(no channel configured yet — won't actually send)</i>`;
  }
  msg += `\n\n`;
  msg += buildSystemStatusSection(backupStatus);
  msg += `  Last write: ${backupStatus.lastWrite ? new Date(backupStatus.lastWrite).toLocaleString('en-IN') : 'never'}\n`;
  return msg.trim();
}

module.exports = {
  computeSalesSummary,
  computeStockAlerts,
  computeCriticalStock,
  computeSlowMoving,
  computeDeadStock,
  buildEveningMessage,
  buildMorningMessage,
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
  inr,
  num,
};
