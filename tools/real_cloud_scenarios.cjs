const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const page = (await getJson(`http://127.0.0.1:${port}/json`)).find((entry) => entry.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function scenarios() {
      const definitions = [
        { billId: 'TEST-VHC-REAL-CASH-001', mode: 'Cash', total: 101, received: 101, outstanding: 0, status: 'Paid', breakdown: { Cash: 101 } },
        { billId: 'TEST-VHC-REAL-UPI-001', mode: 'UPI', total: 102, received: 102, outstanding: 0, status: 'Paid', breakdown: { UPI: 102 } },
        { billId: 'TEST-VHC-REAL-CARD-001', mode: 'Card', total: 103, received: 103, outstanding: 0, status: 'Paid', breakdown: { Card: 103 } },
        { billId: 'TEST-VHC-REAL-CREDIT-001', mode: 'Credit', total: 104, received: 0, outstanding: 104, status: 'Credit', breakdown: { credit: 104 } },
        { billId: 'TEST-VHC-REAL-SPLIT-001', mode: 'Split', total: 105, received: 105, outstanding: 0, status: 'Paid', breakdown: { Cash: 40, UPI: 65 } },
        { billId: 'TEST-VHC-REAL-PARTIAL-001', mode: 'Cash', total: 107, received: 107, outstanding: 0, status: 'Paid', breakdown: { Cash: 107 }, secondItem: true },
      ];
      const created = [];
      const history = JSON.parse(localStorage.getItem('vhc_pos_sales_history') || '[]');
      for (const def of definitions) {
        const existing = await window.electronAPI.getLocalSale(def.billId);
        if (!existing) {
          const items = [{ name: def.billId + '-ITEM-A', category: 'Medicine', batch: def.billId + '-A', expiry: '12/2029', mrp: def.secondItem ? 50 : def.total, price: def.secondItem ? 50 : def.total, qty: 1, stock: 20, unitsPerPack: 1 }];
          if (def.secondItem) items.push({ name: def.billId + '-ITEM-B', category: 'Medicine', batch: def.billId + '-B', expiry: '12/2029', mrp: 57, price: 57, qty: 1, stock: 20, unitsPerPack: 1 });
          const result = await window.electronAPI.createLocalSale({
            billId: def.billId,
            patientSnapshot: { name: 'TEST-VHC Synthetic Patient', patientId: 'TEST-VHC-PATIENT-001', contact: '' },
            doctorName: 'TEST-VHC Synthetic Doctor', paymentMode: def.mode,
            subtotal: def.total, totalTax: 0, totalAmount: def.total, gstMode: 'regular', discount: 0, discountPercent: 0,
            paymentDetails: { amountReceived: def.received, outstandingAmount: def.outstanding, status: def.status, breakdown: def.breakdown, recordedBy: 'TEST-VHC-validation' },
            items, extraParticulars: [],
          });
          created.push({ billId: def.billId, result });
          const bill = { billId: def.billId, date: new Date().toISOString(), patientName: 'TEST-VHC Synthetic Patient', patientId: 'TEST-VHC-PATIENT-001', paymentMode: def.mode, totalAmount: def.total, amountReceived: def.received, outstandingAmount: def.outstanding, paymentStatus: def.status, paymentBreakdown: def.breakdown, particulars: items.map((item) => ({ category: 'Medicine', drugName: item.name, batchNo: item.batch, expiryDate: item.expiry, quantity: 1, rate: item.price, total: item.price })) };
          history.unshift(bill);
        }
      }
      localStorage.setItem('vhc_pos_sales_history', JSON.stringify(history));
      const worker = await window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-real-payment-scenarios' });
      const operations = await window.electronAPI.getFinancialSyncOperations();
      const cloud = [];
      for (const def of definitions) cloud.push(await window.VHC_CLOUD.findSaleByBillIdStrict(def.billId));
      return { created, worker, operations: operations.filter((op) => definitions.some((def) => def.billId === op.bill_id)), cloud };
    }})()`, awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
