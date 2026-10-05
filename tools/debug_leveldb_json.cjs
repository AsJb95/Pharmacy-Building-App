const fs = require('fs');
const file = process.argv[2];
const text = fs.readFileSync(file).toString('latin1').replace(/\x00/g, '');
const needle = '[{"billId"';
const idx = text.indexOf(needle);
console.log({ idx, file });
if (idx >= 0) {
  let depth = 0, inStr = false, esc = false, end = -1;
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
      if (depth === 0 && ch === ']') { end = i + 1; break; }
    }
  }
  console.log({ end, depth, preview: text.slice(idx, idx + 120), tail: end > 0 ? text.slice(end - 80, end + 40) : '' });
  if (end > 0) {
    const raw = text.slice(idx, end);
    try { const arr = JSON.parse(raw); console.log({ parsed: arr.length, first: arr[0].billId, last: arr[arr.length - 1].billId }); }
    catch (e) { console.log({ parseError: e.message }); }
  }
}
