const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'dist/assets/index-doBKNLAj.js'), 'utf8');
const cloudSource = fs.readFileSync(path.join(root, 'cloud-src/vhc-cloud-sync.js'), 'utf8');
const cloudBundle = fs.readFileSync(path.join(root, 'dist/assets/vhc-cloud-sync.js'), 'utf8');
assert.match(renderer, /N = async \(\) =>/);
assert.match(renderer, /await t\(\{ id: Date\.now\(\), \.\.\.itemToSave \}\)/);
assert.match(renderer, /Unable to save stock:/);
assert.match(renderer, /Stock added successfully\./);
assert.match(renderer, /Inventory save returned no result/);
assert.doesNotMatch(renderer, /result && !result\.error &&[\s\S]{0,80}ADDED_ITEM/);
for (const cloud of [cloudSource, cloudBundle]) {
  assert.match(cloud, /NHC Pharmacy Counter is not configured for this database/);
  assert.match(cloud, /default alerts_config provisioning failed/);
  assert.match(cloud, /pharmacy_counter/);
}
console.log('Inventory add-flow contract checks passed.');
