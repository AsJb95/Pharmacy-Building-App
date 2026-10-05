const http = require('http');
const port = Number(process.env.VHC_CDP_PORT || 9333);
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }).on('error', reject); }); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); const pending = new Map(); let id = 0; ws.onopen = () => resolve({ send(method, params = {}) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((res, rej) => pending.set(requestId, { res, rej })); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (event) => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (!handler) return; pending.delete(message.id); message.error ? handler.rej(new Error(message.error.message)) : handler.res(message.result); }; }); }
async function main() {
  const page = (await getJson(`http://127.0.0.1:${port}/json`)).find((entry) => entry.type === 'page');
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const response = await client.send('Runtime.evaluate', {
    expression: `(${async function uiCheck() {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clickText = (text) => {
        const element = Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"]')).find((candidate) => (candidate.textContent || '').trim().includes(text));
        if (!element) return false;
        element.click();
        return true;
      };
      await wait(3500);
      const initial = document.body.innerText;
      const reportsClicked = clickText('Reports & Financials');
      await wait(1200);
      const reports = document.body.innerText;
      const paymentsClicked = clickText('Payments');
      await wait(800);
      const payments = document.body.innerText;
      const buttonTexts = Array.from(document.querySelectorAll('button')).map((button) => (button.textContent || '').trim()).filter(Boolean);
      const inventoryClicked = clickText('Inventory');
      await wait(900);
      const inventory = document.body.innerText;
      return {
        initialStatus: ['Online • Synced', 'Syncing…', 'Offline •', 'Sync Failed •'].find((label) => initial.includes(label)) || null,
        reportsClicked,
        reportsBillVisible: reports.includes('TEST-VHC-REAL-CASH-001') || reports.includes('TEST-VHC-OFFLINE-E2E-001'),
        reportsText: reports.slice(0, 12000),
        paymentsClicked,
        paymentsBillVisible: payments.includes('TEST-VHC-REAL-CASH-001') || payments.includes('TEST-VHC-OFFLINE-E2E-001'),
        paymentModesVisible: ['Cash', 'UPI', 'Card', 'Credit', 'Split'].filter((mode) => payments.includes(mode)),
        receiptControls: buttonTexts.filter((text) => /receipt|reprint|print|view/i.test(text)),
        inventoryClicked,
        inventoryItemVisible: inventory.includes('TEST-VHC Synthetic Tablet Edited'),
        inventoryText: inventory.slice(0, 8000),
      };
    }})()`, awaitPromise: true, returnByValue: true,
  });
  client.close();
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
