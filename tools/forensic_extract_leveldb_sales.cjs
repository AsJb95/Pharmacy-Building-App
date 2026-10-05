const fs = require('fs');
const path = require('path');

const profile = process.argv[2] || path.join(process.cwd(), 'evidence_clinic_zip_20260925_153536', 'vhc-pharmacy-pos');
const leveldb = path.join(profile, 'Local Storage', 'leveldb');
const outDir = path.join(process.cwd(), 'evidence_clinic_zip_20260925_153536');

function files(dir) {
  return fs.readdirSync(dir)
    .filter((n) => /\.(ldb|log)$/i.test(n))
    .map((n) => path.join(dir, n));
}

function findJsonArrays(text) {
  const out = [];
  let idx = 0;
  while ((idx = text.indexOf('[{"billId"', idx)) !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = idx; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0 && ch === ']') {
          const raw = text.slice(idx, i + 1);
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.some((b) => b && b.billId)) out.push(parsed);
          } catch {}
          idx = i + 1;
          break;
        }
      }
    }
    idx++;
  }
  return out;
}

function parseBillEpoch(id) {
  const m = String(id || '').match(/^BILL-(\d{10,})$/);
  return m ? Number(m[1]) : null;
}

function istDate(isoOrMs) {
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function istTime(isoOrMs) {
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

const candidates = [];
for (const file of files(leveldb)) {
  const buf = fs.readFileSync(file);
  const variants = [
    ['utf8', buf.toString('utf8')],
    ['utf16le', buf.toString('utf16le')],
    ['latin1-nullstripped', buf.toString('latin1').replace(/\x00/g, '')],
    ['utf8-nullstripped', buf.toString('utf8').replace(/\x00/g, '')],
  ];
  for (const [enc, text] of variants) {
    const arrays = findJsonArrays(text);
    for (const arr of arrays) {
      const ids = new Set(arr.map((b) => b && b.billId).filter(Boolean));
      const sep24 = arr.filter((b) => istDate(b.date || parseBillEpoch(b.billId)) === '2026-09-24').length;
      const sep25 = arr.filter((b) => istDate(b.date || parseBillEpoch(b.billId)) === '2026-09-25').length;
      candidates.push({ file, enc, count: arr.length, unique: ids.size, sep24, sep25, arr });
    }
  }
}

candidates.sort((a, b) => (b.unique - a.unique) || (b.count - a.count) || (b.sep25 - a.sep25));
const best = candidates[0];
if (!best) {
  console.error('No valid sales-history JSON arrays found');
  process.exit(2);
}

const rows = best.arr.map((b) => {
  const epoch = parseBillEpoch(b.billId);
  const canonical = b.date || (epoch ? new Date(epoch).toISOString() : '');
  return {
    bill_id: b.billId,
    raw_date: b.date || '',
    bill_epoch_ms: epoch,
    bill_epoch_ist: epoch ? istTime(epoch) : '',
    parsed_ist: canonical ? istTime(canonical) : '',
    business_date_ist: canonical ? istDate(canonical) : '',
    bill_epoch_business_date_ist: epoch ? istDate(epoch) : '',
    patient: b.patientName || '',
    total: Number(b.totalAmount || 0),
    paymentMode: b.paymentMode || '',
    paymentStatus: b.paymentStatus || '',
    amountReceived: b.amountReceived,
    outstandingAmount: b.outstandingAmount,
    itemCount: Array.isArray(b.particulars) ? b.particulars.length : 0,
  };
});

const byDate = {};
for (const r of rows) {
  byDate[r.business_date_ist] = byDate[r.business_date_ist] || { count: 0, total: 0 };
  byDate[r.business_date_ist].count++;
  byDate[r.business_date_ist].total += r.total;
}
for (const v of Object.values(byDate)) v.total = Math.round(v.total * 100) / 100;

const result = {
  profile,
  leveldb,
  candidates: candidates.map((c) => ({ file: c.file, enc: c.enc, count: c.count, unique: c.unique, sep24: c.sep24, sep25: c.sep25 })),
  selected: { file: best.file, enc: best.enc, count: best.count, unique: best.unique, sep24: best.sep24, sep25: best.sep25 },
  byDate,
  rows,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'forensic_sales_history.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(outDir, 'forensic_sales_history_rows.csv'), [
  Object.keys(rows[0] || {}).join(','),
  ...rows.map((r) => Object.values(r).map((v) => JSON.stringify(v ?? '')).join(',')),
].join('\n'));
console.log(JSON.stringify({
  selected: result.selected,
  byDate,
  out: path.join(outDir, 'forensic_sales_history.json'),
}, null, 2));
