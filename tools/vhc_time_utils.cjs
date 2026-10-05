function canonicalTimestamp(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) return new Date(input).toISOString();
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input.toISOString();
  const raw = String(input).trim();
  if (/^\d{10,}$/.test(raw)) return new Date(Number(raw)).toISOString();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function businessDateInTimeZone(input, timeZone = 'Asia/Kolkata') {
  const iso = canonicalTimestamp(input);
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso)).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function displayDateTime(input, opts = {}) {
  const iso = canonicalTimestamp(input);
  if (!iso) return '';
  return new Intl.DateTimeFormat(opts.locale || 'en-IN', {
    timeZone: opts.timeZone || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: !!opts.hour12,
  }).format(new Date(iso));
}

function billIdEpochMs(billId) {
  const m = String(billId || '').match(/^BILL-(\d{10,})$/);
  return m ? Number(m[1]) : null;
}

module.exports = { canonicalTimestamp, businessDateInTimeZone, displayDateTime, billIdEpochMs };
