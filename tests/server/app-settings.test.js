const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSettings, DEFAULTS } = require('../../electron/app-settings');

describe('desktop app settings', () => {
  const dir = path.join(__dirname, '..', '..', '.local', 'test', 'app-settings');
  const file = path.join(dir, 'app-settings.json');

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps running in the tray by default', () => {
    const settings = createSettings(file);
    assert.equal(settings.get('keepInTray'), true);
    assert.deepEqual(settings.getAll(), DEFAULTS);
  });

  it('persists a change across restarts', () => {
    createSettings(file).set('keepInTray', false);

    const reloaded = createSettings(file);
    assert.equal(reloaded.get('keepInTray'), false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).keepInTray, false);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it('falls back to defaults for a corrupt file', () => {
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(createSettings(file).getAll(), DEFAULTS);
  });

  it('ignores unknown keys and wrong types in the file', () => {
    fs.writeFileSync(file, JSON.stringify({ keepInTray: 'yes', surprise: true, trayHintShown: true }));
    const settings = createSettings(file);
    assert.equal(settings.get('keepInTray'), true); // wrong type ignored
    assert.equal(settings.get('trayHintShown'), true);
    assert.equal(settings.get('surprise'), undefined);
  });

  it('rejects unknown settings and wrong value types', () => {
    const settings = createSettings(file);
    assert.throws(() => settings.set('nope', true), /Invalid setting/);
    assert.throws(() => settings.set('keepInTray', 'false'), /Invalid setting/);
    assert.throws(() => settings.set('__proto__', true), /Invalid setting/);
    assert.equal(settings.get('keepInTray'), true);
  });
});
