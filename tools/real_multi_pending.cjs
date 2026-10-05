const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const page = (await getJson(`http://127.0.0.1:${port}/json`)).find((entry) => entry.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function multiPending() {
      const ids = ['TEST-VHC-REAL-PENDING-A', 'TEST-VHC-REAL-PENDING-B', 'TEST-VHC-REAL-PENDING-C'];
      for (let index = 0; index < ids.length; index += 1) {
        const billId = ids[index];
        if (await window.electronAPI.getLocalSale(billId)) continue;
        await window.electronAPI.createLocalSale({
          billId, patientSnapshot: { name: 'TEST-VHC Synthetic Patient', patientId: 'TEST-VHC-PATIENT-001', contact: '' },
          doctorName: 'TEST-VHC Synthetic Doctor', paymentMode: 'Cash', subtotal: 31 + index, totalTax: 0, totalAmount: 31 + index,
          gstMode: 'regular', discount: 0, discountPercent: 0,
          paymentDetails: { amountReceived: 31 + index, outstandingAmount: 0, status: 'Paid', breakdown: { Cash: 31 + index }, recordedBy: 'TEST-VHC-validation' },
          items: [{ name: billId + '-ITEM', category: 'Medicine', batch: billId + '-BATCH', expiry: '12/2029', mrp: 31 + index, price: 31 + index, qty: 1, stock: 10, unitsPerPack: 1 }], extraParticulars: [],
        });
      }
      const originalCreate = window.VHC_CLOUD.createSaleStrict;
      window.VHC_CLOUD.createSaleStrict = async (payload) => {
        if (payload.billId.endsWith('-B') || payload.billId.endsWith('-C')) throw Object.assign(new Error('TEST-VHC injected cloud interruption'), { code: 'TEST_INTERRUPTION' });
        return originalCreate(payload);
      };
      const concurrent = await Promise.all([
        window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-multi-primary' }),
        window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-multi-overlap' }),
      ]);
      window.VHC_CLOUD.createSaleStrict = originalCreate;
      const afterInterrupted = (await window.electronAPI.getFinancialSyncOperations()).filter((op) => ids.includes(op.bill_id));
      const recovery = await window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-multi-recovery' });
      const afterRecovery = (await window.electronAPI.getFinancialSyncOperations()).filter((op) => ids.includes(op.bill_id));
      const cloud = [];
      for (const id of ids) cloud.push(await window.VHC_CLOUD.findSaleByBillIdStrict(id));
      return { concurrent, afterInterrupted, recovery, afterRecovery, cloud };
    }})()`, awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
