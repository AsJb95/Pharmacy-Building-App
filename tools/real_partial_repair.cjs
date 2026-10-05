const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const page = (await getJson(`http://127.0.0.1:${port}/json`)).find((entry) => entry.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function partialRepair() {
      const billId = 'TEST-VHC-REAL-PARTIAL-001';
      const before = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
      if (!before || before.sale_items.length !== 2) throw new Error('Expected a two-item synthetic cloud sale before interruption');
      const removedItem = before.sale_items[0];
      const session = await window.VHC_CLOUD.getSession();
      const config = window.electronAPI.getSupabaseRuntimeConfig();
      const response = await fetch(config.supabaseUrl + '/rest/v1/sale_items?id=eq.' + encodeURIComponent(removedItem.id), {
        method: 'DELETE',
        headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + session.access_token, Prefer: 'return=minimal' }
      });
      if (!response.ok) throw new Error('Synthetic interruption DELETE failed: HTTP ' + response.status + ' ' + await response.text());
      const interrupted = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
      await window.electronAPI.markFinancialSyncAttempt(billId, 'TEST-VHC simulated partial sale_items interruption');
      const repair = await window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-partial-repair' });
      const after = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
      const operations = await window.electronAPI.getFinancialSyncOperations();
      await window.electronAPI.markFinancialSyncAttempt(billId, 'TEST-VHC existing-sale reuse probe');
      const reuse = await window.VHC_FINANCIAL_SYNC.run({ source: 'TEST-VHC-existing-sale-reuse' });
      const afterReuse = await window.VHC_CLOUD.findSaleByBillIdStrict(billId);
      return {
        saleIdBefore: before.id,
        itemsBefore: before.sale_items.length,
        itemsAfterInterruption: interrupted.sale_items.length,
        repair,
        saleIdAfter: after && after.id,
        itemsAfterRepair: after && after.sale_items.length,
        operationAfterRepair: operations.find((op) => op.bill_id === billId),
        reuse,
        saleIdAfterReuse: afterReuse && afterReuse.id,
        itemsAfterReuse: afterReuse && afterReuse.sale_items.length,
      };
    }})()`, awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
