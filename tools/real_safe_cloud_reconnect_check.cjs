const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const pages = await getJson(`http://127.0.0.1:${port}/json`);
  const page = pages.find((candidate) => candidate.type === 'page');
  if (!page) throw new Error('No Electron renderer page found');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function reconnectCheck() {
      const billId = globalThis.__VHC_VALIDATION_BILL_ID__ || 'TEST-VHC-OFFLINE-E2E-001';
      const transitions = [];
      const preCheck = await window.VHC_CLOUD.findSaleByBillId(billId);
      const originalAttempt = window.electronAPI.markFinancialSyncAttempt;
      const originalConfirmed = window.electronAPI.markFinancialSyncConfirmed;
      window.electronAPI.markFinancialSyncAttempt = async (...args) => {
        const result = await originalAttempt(...args);
        transitions.push(result && result.status);
        return result;
      };
      window.electronAPI.markFinancialSyncConfirmed = async (...args) => {
        const result = await originalConfirmed(...args);
        transitions.push(result && result.status);
        return result;
      };
      const runs = [];
      try {
        for (let i = 0; i < 10; i += 1) runs.push(await window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-reconnect-' + i }));
      } finally {
        window.electronAPI.markFinancialSyncAttempt = originalAttempt;
        window.electronAPI.markFinancialSyncConfirmed = originalConfirmed;
      }
      const localSale = await window.electronAPI.getLocalSale(billId);
      const operations = await window.electronAPI.getFinancialSyncOperations();
      const cloudSale = await window.VHC_CLOUD.findSaleByBillId(billId);
      const movements = await window.VHC_CLOUD.getStockMovements();
      return {
        navigatorOnline: navigator.onLine,
        preCheck,
        transitions,
        runs,
        operation: operations.find((entry) => entry.bill_id === billId),
        localSale,
        cloudSale,
        cloudMovementMatches: movements.filter((entry) => entry.bill_id === billId),
        pendingFlag: localStorage.getItem('vhc_pending_changes'),
        visibleText: document.body.innerText,
      };
    }})()`.replace('globalThis.__VHC_VALIDATION_BILL_ID__', JSON.stringify(process.env.VHC_VALIDATION_BILL_ID || 'TEST-VHC-OFFLINE-E2E-001')), awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
