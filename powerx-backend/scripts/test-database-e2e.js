// E2E: strengthened database tool — SQLite create/insert/read + file delivery.
const et = require('../services/enterpriseTools');
const fs = require('fs'), os = require('os'), path = require('path');

async function main() {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtest_'));
  const staged = [];
  const ctx = { onStep: () => {}, fsx: { workdir: wd }, addFile: (rel, name) => staged.push(name || rel) };

  console.log('STEP 1 — CREATE TABLE + INSERT (write)');
  const r1 = await et.toolDatabase({ db: 'shop.db', sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, price REAL); INSERT INTO items(name,price) VALUES('Pen',1.5),('Book',9.0),('Lamp',22.0);" }, ctx);
  if (!/changes=3/.test(r1)) throw new Error('FAIL: insert did not affect 3 rows\n' + r1);
  console.log('   ✅ wrote 3 rows');

  console.log('STEP 2 — SELECT (read/extract)');
  const r2 = await et.toolDatabase({ db: 'shop.db', sql: 'SELECT name, price FROM items WHERE price > 5 ORDER BY price DESC;' }, ctx);
  if (!/Lamp/.test(r2) || !/Book/.test(r2) || /Pen/.test(r2)) throw new Error('FAIL: read query wrong\n' + r2);
  console.log('   ✅ read back filtered rows (Lamp, Book; Pen excluded)');

  console.log('STEP 3 — UPDATE + verify persistence across calls');
  await et.toolDatabase({ db: 'shop.db', sql: "UPDATE items SET price = 3.0 WHERE name = 'Pen';" }, ctx);
  const r4 = await et.toolDatabase({ db: 'shop.db', sql: "SELECT price FROM items WHERE name='Pen';" }, ctx);
  if (!/"price":\s*3/.test(r4.replace(/\s/g, m => m))) throw new Error('FAIL: update not persisted\n' + r4);
  console.log('   ✅ update persisted across separate tool calls');

  console.log('STEP 4 — DB file delivered');
  if (!staged.includes('shop.db') || !fs.existsSync(path.join(wd, 'shop.db'))) throw new Error('FAIL: db file not delivered');
  console.log('   ✅ shop.db staged for delivery');

  console.log('\nALL DATABASE TESTS PASSED ✅');
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
