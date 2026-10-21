/**
 * Championship Blue, OTO's default look.
 *
 * It comes with the app (assets/designs/championship-blue: the files of the design and its control settings, as in a .oto) and is put in
 * the designs of this computer once for each version of it that OTO ships (VERSION below), at start:
 *
 *   - the design is installed, in the place of a design of the same name (that is how a new version of it arrives: to change it, make a
 *     copy of it under another name first)
 *   - it is put on the overlay when no design is on it (the producer has not chosen one), and only then
 *   - on a fresh install (no game saved yet) its control settings are applied too: the bench attacks, the turn highlight, the design
 *     animations, no toast banners. On an install that was already in use the producer's settings stay as they are.
 *
 * The classic look (no design) stays one click away in Settings, Look.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('./zip');

const FOLDER = 'championship-blue';
const VERSION = 1; // raise it when the bundled design changes, so installs that have an older one get the new one
const SETTING = 'defaultDesign';
const SYSTEM = { clientId: 'system', name: 'OTO (automatic)' };

// The bundled design as a .oto package: its files, as they are in the folder
function bundledPackage(assetsDir) {
  const dir = path.join(assetsDir, 'designs', FOLDER);
  const names = ['design.json', 'controls.json', 'styles.css'].filter((name) => fs.existsSync(path.join(dir, name)));
  const images = path.join(dir, 'images');
  if (fs.existsSync(images)) names.push(...fs.readdirSync(images).sort().map((name) => `images/${name}`));
  return createZip(names.map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) })));
}

// Put the default design in, if this version of it was not put in yet. `fresh`: no game was saved before this start. Returns what was done
// ({ skipped } when nothing was to do).
function installDefaultDesign({ db, themes, packages, assetsDir, fresh, log = () => {} }) {
  const done = db.getSetting(SETTING, null);
  if (done && Number(done.version) >= VERSION) return { skipped: 'already installed' };
  if (!fs.existsSync(path.join(assetsDir, 'designs', FOLDER, 'design.json'))) return { skipped: 'not shipped' };
  const onAir = themes.activeName() !== null;
  const result = packages.install(bundledPackage(assetsDir), { design: true, controls: fresh, activate: !onAir, replace: true }, SYSTEM);
  db.setSetting(SETTING, { version: VERSION, installedAt: Date.now() });
  log('info', 'Default design installed', { ...result, fresh });
  return result;
}

module.exports = { installDefaultDesign, bundledPackage, VERSION, SETTING, FOLDER };
