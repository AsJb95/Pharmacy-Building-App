const fs = require('fs');
const http = require('http');
const PORT = Number(process.env.VHC_CDP_PORT || 9332);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const h = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? h.rej(new Error(msg.error.message)) : h.res(msg.result);
      }
    };
  });
}

const expr = `(${async function restartValidation() {
  const salesKey = 'vhc_pos_sales_history';
  const readHistory = () => JSON.parse(localStorage.getItem(salesKey) || '[]');
  const beforeHistory = readHistory();
  const beforeDb = await window.electronAPI.getSalesHistory();
  const beforeInv = JSON.parse(localStorage.getItem('pos_inventory') || '[]');
  const billId = 'LIVE-STARTED-OFFLINE-' + Date.now();
  const total = 51;
  const bill = {
    billId,
    date: new Date().toISOString(),
    patientName: 'Live Test Patient',
    patientId: 'LIVE-TEST-PATIENT',
    patientSnapshot: { name: 'Live Test Patient', patientId: 'LIVE-TEST-PATIENT', contact: '' },
    doctorName: 'Live Test Doctor',
    paymentMode: 'Split',
    subtotal: total,
    totalTax: 0,
    totalAmount: total,
    gstMode: 'regular',
    discount: 0,
    discountPercent: 0,
    amountReceived: 30,
    outstandingAmount: 21,
    paymentStatus: 'Partially Paid',
    paymentBreakdown: { Cash: 20, UPI: 10, credit: 21 },
    recordedBy: 'live-restart-validation',
    particulars: [{ category: 'Medicine', drugName: 'Live Validation Tablet', batchNo: 'LV-1', expiryDate: '12/2028', quantity: 1, rate: total, total }],
  };
  localStorage.setItem(salesKey, JSON.stringify([bill, ...beforeHistory.filter((b) => b && b.billId !== billId)]));
  const dbRes = await window.electronAPI.createLocalSale({
    billId,
    patientSnapshot: bill.patientSnapshot,
    doctorName: bill.doctorName,
    paymentMode: 'Split',
    subtotal: total,
    totalTax: 0,
    totalAmount: total,
    gstMode: 'regular',
    discount: 0,
    discountPercent: 0,
    paymentDetails: { amountReceived: 30, outstandingAmount: 21, status: 'Partially Paid', breakdown: bill.paymentBreakdown, recordedBy: 'live-restart-validation' },
    items: [{ name: 'Live Validation Tablet', itemId: 'LIVE-VALIDATION-ITEM', category: 'Medicine', batch: 'LV-1', expiry: '12/2028', mrp: total, price: total, qty: 1, stock: 100, unitsPerPack: 1 }],
    extraParticulars: [],
  });
  const afterHistory = readHistory();
  const afterDb = await window.electronAPI.getSalesHistory();
  return {
    appVersion: await window.electronAPI.getAppVersion(),
    previousLocalStorageLiveBillCount: beforeHistory.filter((b) => String(b.billId).startsWith('LIVE-')).length,
    previousDatabaseLiveBillCount: beforeDb.filter((b) => String(b.billId).startsWith('LIVE-')).length,
    inventoryLiveMedicineStillPresent: beforeInv.some((it) => String(it.id).startsWith('LIVE-MED-') && it.stock === 9),
    startedOfflineBillId: billId,
    startedOfflineDbSuccess: !!(dbRes && dbRes.success),
    startedOfflineLocalStoragePresent: afterHistory.some((b) => b.billId === billId),
    startedOfflineDatabasePresent: afterDb.some((b) => b.billId === billId),
    pendingChanges: localStorage.getItem('vhc_pending_changes'),
    duplicateStartedOfflineLocalCount: afterHistory.filter((b) => b.billId === billId).length,
  };
}})()`;

async function main() {
  await new Promise((r) => setTimeout(r, 2500));
  const pages = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = pages.find((p) => p.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const res = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  cdp.close();
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
  const outPath = process.env.VHC_LIVE_RESTART_OUT || 'evidence_live_offline_v3182/live_restart_result.json';
  fs.writeFileSync(outPath, JSON.stringify(res.result.value, null, 2));
  console.log(JSON.stringify({ written: outPath, result: res.result.value }, null, 2));
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
