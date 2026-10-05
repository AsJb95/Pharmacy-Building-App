const fs = require('fs');
const path = require('path');

const profile = process.argv[2] || path.join(process.cwd(), 'evidence_clinic_zip_20260925_153536', 'vhc-pharmacy-pos');
const leveldb = path.join(profile, 'Local Storage', 'leveldb');
const outDir = path.join(process.cwd(), 'evidence_clinic_zip_20260925_153536');

function clean(buf) {
  return buf.toString('latin1').replace(/\x00/g, '');
}

function istDate(msOrIso) {
  const d = new Date(msOrIso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function field(chunk, name) {
  const i = chunk.indexOf(`"${name}"`);
  if (i < 0) return '';
  const rest = chunk.slice(i + name.length + 2, i + name.length + 220);
  const m = rest.match(/:\s*"([^"]*)"/) || rest.match(/:\s*([0-9.]+)/);
  return m ? m[1] : '';
}

function numberField(chunk, name) {
  const raw = field(chunk, name);
  return raw === '' ? null : Number(raw);
}

const byId = new Map();
for (const name of fs.readdirSync(leveldb)) {
  if (!/\.(ldb|log)$/i.test(name)) continue;
  const file = path.join(leveldb, name);
  const text = clean(fs.readFileSync(file));
  const re = /BILL-\d{10,}/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[0];
    const start = Math.max(0, m.index - 250);
    const end = Math.min(text.length, m.index + 4000);
    const chunk = text.slice(start, end);
    const epoch = Number(id.slice(5));
    const rec = {
      bill_id: id,
      file,
      offset: m.index,
      epoch_ms: epoch,
      epoch_ist_date: istDate(epoch),
      date: field(chunk, 'date'),
      date_ist_date: field(chunk, 'date') ? istDate(field(chunk, 'date')) : '',
      patient: field(chunk, 'patientName'),
      total: numberField(chunk, 'totalAmount'),
      paymentMode: field(chunk, 'paymentMode'),
      paymentStatus: field(chunk, 'paymentStatus'),
      amountReceived: numberField(chunk, 'amountReceived'),
      outstandingAmount: numberField(chunk, 'outstandingAmount'),
    };
    const score = ['date', 'patient', 'total', 'paymentMode', 'paymentStatus'].reduce((s, k) => s + (rec[k] !== '' && rec[k] != null ? 1 : 0), 0);
    const old = byId.get(id);
    if (!old || score > old.score || (score === old.score && rec.offset > old.offset)) byId.set(id, { ...rec, score });
  }
}

const rows = Array.from(byId.values()).sort((a, b) => a.epoch_ms - b.epoch_ms);
const byDate = {};
for (const r of rows) {
  const d = r.date_ist_date || r.epoch_ist_date;
  byDate[d] = byDate[d] || { count: 0, totalKnown: 0, missingTotal: 0 };
  byDate[d].count++;
  if (Number.isFinite(r.total)) byDate[d].totalKnown += r.total;
  else byDate[d].missingTotal++;
}
for (const v of Object.values(byDate)) v.totalKnown = Math.round(v.totalKnown * 100) / 100;

const result = { profile, leveldb, count: rows.length, byDate, rows };
fs.writeFileSync(path.join(outDir, 'forensic_bill_regex.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(outDir, 'forensic_bill_regex.csv'), [
  Object.keys(rows[0] || {}).join(','),
  ...rows.map((r) => Object.values(r).map((v) => JSON.stringify(v ?? '')).join(',')),
].join('\n'));
console.log(JSON.stringify({ count: rows.length, byDate, out: path.join(outDir, 'forensic_bill_regex.json') }, null, 2));
