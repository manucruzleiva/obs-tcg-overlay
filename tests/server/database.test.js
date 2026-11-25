/**
 * The database file on disk: a damaged one is set aside instead of stopping the server, and saves replace it whole.
 */

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DatabaseService = require('../../src/db/database');

it('sets a damaged database aside and starts a new one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-db-'));
  const dbPath = path.join(dir, 'overlay.sqlite');
  fs.writeFileSync(dbPath, 'this is not a database, it is long enough to look like a header');
  const db = new DatabaseService();
  db.dbPath = dbPath;
  await db.init();
  db.setSetting('a', 1);
  db.save();

  const aside = fs.readdirSync(dir).find((f) => f.startsWith('overlay.sqlite.broken-'));
  assert.ok(aside, 'the damaged file is kept');
  assert.match(fs.readFileSync(path.join(dir, aside), 'utf8'), /not a database/);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);

  const again = new DatabaseService();
  again.dbPath = dbPath;
  await again.init();
  assert.equal(again.getSetting('a'), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
