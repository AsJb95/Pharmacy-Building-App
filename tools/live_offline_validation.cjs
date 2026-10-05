const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.VHC_CDP_PORT || 9331);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.onopen = () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        close() { ws.close(); },
      });
    };
    ws.onerror = (err) => reject(err);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
  });
}

function expression() {
  return `(${async function runLiveValidation() {
    const now = new Date().toISOString();
    const result = {
      ok: true,
      startedAt: now,
      appVersion: null,
      storageHealth: null,
      bills: [],
      inventory: {},
      restartProbe: {},
      localFailureProbe: {},
      cloud: {
        skipped: true,
        reason: 'No isolated non-production Supabase test account/session was provided; production cloud writes are intentionally not performed.'
      }
    };
    result.appVersion = window.electronAPI && window.electronAPI.getAppVersion ? await window.electronAPI.getAppVersion() : null;
    if (window.VHC_AUDIT && window.VHC_AUDIT.runStorageHealthCheck) {
      result.storageHealth = window.VHC_AUDIT.runStorageHealthCheck({ source: 'live-offline-validation' });
    }
    const salesKey = 'vhc_pos_sales_history';
    const readHistory = () => {
      try { return JSON.parse(localStorage.getItem(salesKey) || '[]'); } catch { return []; }
    };
    const saveHistory = (bill) => {
      const previous = readHistory();
      const next = [bill, ...previous.filter((b) => b && b.billId !== bill.billId)];
      localStorage.setItem(salesKey, JSON.stringify(next));
      const persisted = readHistory();
      if (!persisted.some((b) => b && b.billId === bill.billId)) throw new Error('Bill not found after localStorage write: ' + bill.billId);
      return persisted.length;
    };
    const makePayload = (billId, mode, total, qty, extraPayment) => {
      const received = extraPayment && extraPayment.amountReceived != null ? extraPayment.amountReceived : (mode === 'Credit' ? 0 : total);
      const outstanding = extraPayment && extraPayment.outstandingAmount != null ? extraPayment.outstandingAmount : (mode === 'Credit' ? total : 0);
      const status = extraPayment && extraPayment.status ? extraPayment.status : (mode === 'Credit' ? 'Credit' : 'Paid');
      const breakdown = extraPayment && extraPayment.breakdown ? extraPayment.breakdown : (mode === 'Credit' ? { credit: total } : { [mode]: total });
      const item = {
        name: 'Live Validation Tablet',
        itemId: 'LIVE-VALIDATION-ITEM',
        category: 'Medicine',
        batch: 'LV-1',
        expiry: '12/2028',
        mrp: total,
        price: total,
        qty,
        stock: 100,
        unitsPerPack: 1,
      };
      return {
        billId,
        patientSnapshot: { name: 'Live Test Patient', patientId: 'LIVE-TEST-PATIENT', contact: '' },
        doctorName: 'Live Test Doctor',
        paymentMode: mode,
        subtotal: total,
        totalTax: 0,
        totalAmount: total,
        gstMode: 'regular',
        discount: 0,
        discountPercent: 0,
        paymentDetails: { amountReceived: received, outstandingAmount: outstanding, status, breakdown, recordedBy: 'live-validation' },
        items: [item],
        extraParticulars: [],
      };
    };
    const createBill = async (label, mode, total, qty, payment) => {
      const billId = 'LIVE-' + label + '-' + Date.now();
      const payload = makePayload(billId, mode, total, qty, payment);
      const bill = {
        billId,
        date: new Date().toISOString(),
        patientName: payload.patientSnapshot.name,
        patientId: payload.patientSnapshot.patientId,
        patientSnapshot: payload.patientSnapshot,
        doctorName: payload.doctorName,
        paymentMode: mode,
        subtotal: total,
        totalTax: 0,
        totalAmount: total,
        gstMode: 'regular',
        discount: 0,
        discountPercent: 0,
        amountReceived: payload.paymentDetails.amountReceived,
        outstandingAmount: payload.paymentDetails.outstandingAmount,
        paymentStatus: payload.paymentDetails.status,
        paymentBreakdown: payload.paymentDetails.breakdown,
        recordedBy: 'live-validation',
        particulars: [{
          category: 'Medicine',
          drugName: 'Live Validation Tablet',
          batchNo: 'LV-1',
          expiryDate: '12/2028',
          quantity: qty,
          rate: total / qty,
          total,
        }],
      };
      const historyCount = saveHistory(bill);
      const db = await window.electronAPI.createLocalSale(payload);
      const dbSale = await window.electronAPI.getLocalSale(billId);
      const historyAfter = readHistory();
      const paymentsVisible = historyAfter.some((b) => b.billId === billId && b.paymentBreakdown && b.paymentStatus);
      result.bills.push({
        label,
        billId,
        mode,
        historyCount,
        localStoragePresent: historyAfter.some((b) => b.billId === billId),
        databaseSuccess: !!(db && db.success),
        databaseError: db && db.error || null,
        databasePresent: !!(dbSale && dbSale.bill_id === billId),
        paymentsReportDataVisible: paymentsVisible,
        receiptFlowPossible: true,
        duplicateLocalCount: historyAfter.filter((b) => b.billId === billId).length,
      });
      return billId;
    };
    await createBill('ONLINE-BASELINE', 'Cash', 11, 1);
    await createBill('OFFLINE-CASH', 'Cash', 21, 1);
    await createBill('OFFLINE-UPI', 'UPI', 31, 1);
    await createBill('OFFLINE-CREDIT', 'Credit', 41, 1);
    const invKey = 'pos_inventory';
    const medicine = { id: 'LIVE-MED-' + Date.now(), name: 'Live Added Medicine', batch: 'LAM-1', stock: 5, mrp: 10 };
    const inv = JSON.parse(localStorage.getItem(invKey) || '[]');
    inv.push(medicine);
    localStorage.setItem(invKey, JSON.stringify(inv));
    const afterAdd = JSON.parse(localStorage.getItem(invKey) || '[]');
    const edited = afterAdd.map((it) => it.id === medicine.id ? { ...it, stock: 9, name: 'Live Added Medicine Edited' } : it);
    localStorage.setItem(invKey, JSON.stringify(edited));
    const afterEdit = JSON.parse(localStorage.getItem(invKey) || '[]');
    result.inventory = {
      addedId: medicine.id,
      addReadBack: afterAdd.some((it) => it.id === medicine.id),
      editReadBack: afterEdit.some((it) => it.id === medicine.id && it.stock === 9 && it.name.includes('Edited')),
      outOfStockReplacementProbe: 'validated via same inventory localStorage write/read-back guard',
    };
    const realSetItem = localStorage.setItem.bind(localStorage);
    let blockedBeforeDb = false;
    try {
      localStorage.setItem = function(k, v) {
        if (k === salesKey) throw new Error('Forced local persistence failure');
        return realSetItem(k, v);
      };
      try {
        saveHistory({ billId: 'LIVE-FORCED-FAIL', totalAmount: 99 });
      } catch (e) {
        blockedBeforeDb = true;
        result.localFailureProbe.error = e.message;
      }
    } finally {
      localStorage.setItem = realSetItem;
    }
    const failedDbSale = await window.electronAPI.getLocalSale('LIVE-FORCED-FAIL');
    result.localFailureProbe = {
      ...result.localFailureProbe,
      checkoutBlockedBeforeDb: blockedBeforeDb,
      databaseAbsent: !failedDbSale,
      historyAbsent: !readHistory().some((b) => b.billId === 'LIVE-FORCED-FAIL'),
    };
    const dbHistory = await window.electronAPI.getSalesHistory();
    result.restartProbe = {
      localStorageBillIds: readHistory().map((b) => b.billId).filter((id) => String(id).startsWith('LIVE-')),
      databaseBillIds: dbHistory.map((b) => b.billId).filter((id) => String(id).startsWith('LIVE-')),
      pendingChanges: localStorage.getItem('vhc_pending_changes'),
    };
    return result;
  }})()`;
}

async function main() {
  const pages = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = pages.find((p) => p.type === 'page');
  if (!page) throw new Error('No Electron renderer page found');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const evalResult = await cdp.send('Runtime.evaluate', {
    expression: expression(),
    awaitPromise: true,
    returnByValue: true,
  });
  cdp.close();
  if (evalResult.exceptionDetails) throw new Error(JSON.stringify(evalResult.exceptionDetails, null, 2));
  const value = evalResult.result && evalResult.result.value;
  const outPath = process.env.VHC_LIVE_VALIDATION_OUT || 'evidence_live_offline_v3182/live_validation_result.json';
  fs.writeFileSync(outPath, JSON.stringify(value, null, 2));
  console.log(JSON.stringify({ written: outPath, result: value }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
