const http = require('http');

const port = Number(process.env.VHC_CDP_PORT || 9333);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++sequence;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.rej(new Error(message.error.message));
      else handler.res(message.result);
    };
  });
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

async function main() {
  const pages = await getJson(`http://127.0.0.1:${port}/json`);
  const page = pages.find((candidate) => candidate.type === 'page');
  if (!page) throw new Error('No Electron renderer page found');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });

  const result = await evaluate(client, `(${async function validateOffline() {
    const billId = globalThis.__VHC_VALIDATION_BILL_ID__ || 'TEST-VHC-OFFLINE-E2E-001';
    const salesKey = 'vhc_pos_sales_history';
    const inventoryKey = 'pos_inventory';
    const read = (key, fallback) => {
      try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
    };
    const beforeInventory = read(inventoryKey, []);
    const medicineId = globalThis.__VHC_VALIDATION_ITEM_ID__ || 'TEST-VHC-ITEM-OFFLINE-001';
    const medicine = {
      id: medicineId,
      itemId: medicineId,
      name: 'TEST-VHC Synthetic Tablet',
      category: 'Medicine',
      batch: 'TEST-VHC-BATCH-001',
      expiry: '12/2029',
      stock: 10,
      mrp: 25,
      price: 25,
      unitsPerPack: 1,
    };
    const added = [...beforeInventory.filter((item) => item.id !== medicineId), medicine];
    localStorage.setItem(inventoryKey, JSON.stringify(added));
    const addReadBack = read(inventoryKey, []).find((item) => item.id === medicineId);
    const edited = read(inventoryKey, []).map((item) => item.id === medicineId ? { ...item, stock: 12, name: 'TEST-VHC Synthetic Tablet Edited' } : item);
    localStorage.setItem(inventoryKey, JSON.stringify(edited));
    const editReadBack = read(inventoryKey, []).find((item) => item.id === medicineId);

    const bill = {
      billId,
      date: new Date().toISOString(),
      patientName: 'TEST-VHC Synthetic Patient',
      patientId: 'TEST-VHC-PATIENT-001',
      patientSnapshot: { name: 'TEST-VHC Synthetic Patient', patientId: 'TEST-VHC-PATIENT-001', contact: '' },
      doctorName: 'TEST-VHC Synthetic Doctor',
      paymentMode: 'Cash',
      subtotal: 50,
      totalTax: 0,
      totalAmount: 50,
      amountReceived: 50,
      outstandingAmount: 0,
      paymentStatus: 'Paid',
      paymentBreakdown: { Cash: 50 },
      recordedBy: 'TEST-VHC-validation',
      particulars: [{ category: 'Medicine', drugName: medicine.name, batchNo: medicine.batch, expiryDate: medicine.expiry, quantity: 2, rate: 25, total: 50 }],
    };
    const history = read(salesKey, []);
    localStorage.setItem(salesKey, JSON.stringify([bill, ...history.filter((entry) => entry.billId !== billId)]));
    const localResult = await window.electronAPI.createLocalSale({
      billId,
      patientSnapshot: bill.patientSnapshot,
      doctorName: bill.doctorName,
      paymentMode: bill.paymentMode,
      subtotal: 50,
      totalTax: 0,
      totalAmount: 50,
      gstMode: 'regular',
      discount: 0,
      discountPercent: 0,
      paymentDetails: { amountReceived: 50, outstandingAmount: 0, status: 'Paid', breakdown: { Cash: 50 }, recordedBy: bill.recordedBy },
      items: [{ ...medicine, name: medicine.name, qty: 2, stock: 12 }],
      extraParticulars: [],
    });
    const localSale = await window.electronAPI.getLocalSale(billId);
    const operations = await window.electronAPI.getFinancialSyncOperations();
    const operation = operations.find((entry) => entry.bill_id === billId);
    const historyAfter = read(salesKey, []);
    const workerResult = window.VHC_AUDIT && window.VHC_AUDIT.financialSync
      ? await window.VHC_AUDIT.financialSync.run({ source: 'TEST-VHC-offline-validation' })
      : { skipped: true, reason: 'worker unavailable' };
    return {
      appVersion: await window.electronAPI.getAppVersion(),
      navigatorOnline: navigator.onLine,
      billId,
      localResult,
      localSale,
      operation,
      workerResult,
      localStorageBillCount: historyAfter.filter((entry) => entry.billId === billId).length,
      reportsPaymentRecord: historyAfter.find((entry) => entry.billId === billId) || null,
      receiptRecord: historyAfter.find((entry) => entry.billId === billId) || null,
      inventory: {
        addReadBack: Boolean(addReadBack),
        editReadBack: Boolean(editReadBack && editReadBack.stock === 12 && editReadBack.name.endsWith('Edited')),
      },
      visibleText: document.body.innerText,
    };
  }})()`.replace(
    'globalThis.__VHC_VALIDATION_BILL_ID__',
    JSON.stringify(process.env.VHC_VALIDATION_BILL_ID || 'TEST-VHC-OFFLINE-E2E-001'),
  ).replace(
    'globalThis.__VHC_VALIDATION_ITEM_ID__',
    JSON.stringify(process.env.VHC_VALIDATION_ITEM_ID || 'TEST-VHC-ITEM-OFFLINE-001'),
  ));
  client.close();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
