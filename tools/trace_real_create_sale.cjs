const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const page = (await getJson(`http://127.0.0.1:${port}/json`)).find((entry) => entry.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function trace() {
      const billId = 'TEST-VHC-OFFLINE-E2E-001';
      const session = await window.VHC_CLOUD.getSession();
      const localSale = await window.electronAPI.getLocalSale(billId);
      const payload = window.VHC_FINANCIAL_SYNC._localSaleToCloudPayload(localSale);
      const before = await window.VHC_CLOUD.findSaleByBillId(billId);
      const createResult = await window.VHC_CLOUD.createSale(payload);
      const after = await window.VHC_CLOUD.findSaleByBillId(billId);
      return {
        environment: window.VHC_CLOUD.getEnvironmentConfig(),
        auth: session ? { present: true, userIdPresent: Boolean(session.user && session.user.id), expiresAt: session.expires_at || null, tokenPresent: Boolean(session.access_token) } : { present: false },
        operation: "rpc('create_sale', { payload: jsonb })",
        payload: { ...payload, items: payload.items.map((item) => ({ ...item })) },
        before,
        createResult,
        after,
      };
    }})()`, awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
