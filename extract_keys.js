const fs = require('fs');
const content = fs.readFileSync('C:/New VHC/unpacked_app/dist/assets/index-doBKNLAj.js', 'utf8');

// Find all localStorage key names (quoted strings passed to getItem/setItem/removeItem)
const localStoragePattern = /(?:getItem|setItem|removeItem)\(`([^`]+)`\)/g;
const localStoragePattern2 = /(?:getItem|setItem|removeItem)\("([^"]+)"\)/g;
const localStoragePattern3 = /(?:getItem|setItem|removeItem)\('([^']+)'\)/g;

const keys = new Set();
let m;
while ((m = localStoragePattern.exec(content)) !== null) keys.add(m[1]);
while ((m = localStoragePattern2.exec(content)) !== null) keys.add(m[1]);
while ((m = localStoragePattern3.exec(content)) !== null) keys.add(m[1]);

console.log('=== localStorage keys ===');
[...keys].sort().forEach(k => console.log(k));

// Find all patient/stock/inventory related strings
const importantStrings = [];
const strPat = /`([^`]*(?:patient|patientId|inventory|stock|audit|bill|purchase|return|cancel|adjust)[^`]*)`/gi;
let sm;
while ((sm = strPat.exec(content)) !== null) {
  if (sm[1].length < 100) importantStrings.push(sm[1]);
}

console.log('\n=== Important strings ===');
[...new Set(importantStrings)].sort().slice(0, 100).forEach(s => console.log(s));
